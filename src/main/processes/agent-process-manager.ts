import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import type { WebContents } from "electron";
import type {
  AgentEvent,
  AgentProcess,
  AgentRunInput,
  AgentRunRecord,
  AgentSessionSummary,
  AgentStatus,
} from "@contracts";
import { getAgentDescriptor } from "../agents/catalog";
import { buildInvocation, quoteCommand, resolveExecutable, structuredChatFor, usesStructuredChat } from "../agents/commands";
import { resolveProviderEnv } from "../agents/provider-resolver";
import { terminateProcessTree } from "./process-tree";
import { planRetry } from "../tasks/retry-policy";
import type { ProviderSecretVault } from "../settings/provider-secret-vault";
import type { DesktopDatabase } from "../database/desktop-database";

type RunningProcess = {
  input: AgentRunInput;
  process: ChildProcessWithoutNullStreams;
  command: string;
  args: string[];
  interactive: boolean;
  startedAt: string;
  status: AgentStatus;
  taskId?: string;
  structuredChat: boolean;
  stdoutBuffer: string;
  conversationId?: string;
};

type QueuedProcess = {
  runId: string;
  input: AgentRunInput;
  startedAt: string;
};

/** One coalesced run of same-stream output, in arrival order. */
type PendingChunk = { type: "run:stdout" | "run:stderr"; text: string };

type PendingOutput = {
  chunks: PendingChunk[];
  bytes: number;
  timer: NodeJS.Timeout | null;
};

const MAX_CONCURRENT_RUNS = 3;

/**
 * How long a stopped child gets to honour SIGTERM before SIGKILL. Agent CLIs
 * flush logs and close provider connections on the way out, so cutting this too
 * fine truncates the run's own record of what it did.
 */
const KILL_GRACE_MS = 5_000;

/**
 * Ceiling on the structured-chat stdout buffer. The conversation id arrives in the
 * CLI's first JSON object, so this only has to be wide enough to hold that; without
 * a bound, a chatty run would keep every byte it ever printed in memory.
 */
const STRUCTURED_CHAT_BUFFER_LIMIT = 64 * 1024;

/**
 * How long output may sit in `pendingOutput` before it is written and published.
 *
 * Two frames at 60Hz: short enough that a streaming CLI still reads as live in the
 * terminal, long enough that a burst of hundreds of small line-writes collapses
 * into a single sqlite INSERT, a single IPC message, and a single React render.
 */
const OUTPUT_FLUSH_MS = 32;

/**
 * Flush early once a run has this much text pending, so a CLI dumping a large
 * payload in one burst does not build an unbounded buffer while waiting on the
 * timer.
 */
const OUTPUT_FLUSH_BYTES = 32 * 1024;

const statusHints: Array<{ match: RegExp; status: AgentStatus }> = [
  { match: /\b(plan|planning|strategy|roadmap)\b/i, status: "planning" },
  { match: /\b(read|reading|open|scan|search|grep|rg)\b/i, status: "reading" },
  { match: /\b(write|edit|patch|implement|coding|code)\b/i, status: "coding" },
  { match: /\b(test|jest|vitest|pytest|playwright|e2e|npm test)\b/i, status: "testing" },
  { match: /\b(review|diff|lint|typecheck)\b/i, status: "reviewing" },
  { match: /\b(approval|approve|permission|trust|y\/n)\b/i, status: "waiting-approval" },
];

export class AgentProcessManager {
  private readonly running = new Map<string, RunningProcess>();
  private readonly queued: QueuedProcess[] = [];
  /**
   * Runs pulled off `queued` whose spawn is still in flight. `spawnQueued()` awaits
   * `buildInvocation()` before it can register the child in `running`, so without
   * this set the run is invisible for that window: it counts against neither the
   * concurrency limit (letting a fourth child spawn) nor `sessions()`, and `stop()`
   * finds it in neither collection and silently does nothing.
   */
  private readonly spawning = new Map<string, QueuedProcess>();
  /** Spawns stopped while still in flight: kill the child as soon as it exists. */
  private readonly cancelledSpawns = new Set<string>();
  /**
   * Runs whose kill is in flight. They stay in `running` (that map holds the only
   * handle on the child, and escalation needs it), so they need their own marker
   * to be excluded from the concurrency count and the session list — the user has
   * been told they are stopped, and a queued run must not wait out their grace
   * period.
   */
  private readonly terminating = new Set<string>();
  /**
   * Output waiting to be written to the database and pushed to the renderer.
   *
   * A CLI writes stdout in whatever size the pipe hands over — often a line at a
   * time, hundreds per second while a build or test run streams. Publishing each
   * one immediately cost a synchronous sqlite INSERT *and* an IPC message *and* a
   * renderer store update per chunk, which is what made the whole window sluggish
   * while any agent was talking. Coalescing a burst into one write per
   * `OUTPUT_FLUSH_MS` keeps the text and its order intact while cutting that
   * traffic by one to two orders of magnitude.
   */
  private readonly pendingOutput = new Map<string, PendingOutput>();
  private drainingQueue = false;
  /**
   * Runs stop() has already settled. The map entry is gone by the time the child
   * actually exits, so the decision has to outlive it.
   */
  private readonly stoppedByUser = new Set<string>();
  /** Set on app quit: late exit handlers must not touch a closed database. */
  private shuttingDown = false;

  constructor(
    private readonly db: DesktopDatabase,
    private readonly webContentsProvider: () => WebContents | null,
    private readonly secretVault?: ProviderSecretVault,
    /**
     * SIGTERM grace period. Injectable so the escalation test can shrink it to a
     * few hundred milliseconds instead of sleeping out the production window.
     */
    private readonly killGraceMs: number = KILL_GRACE_MS,
  ) {}

  async start(input: AgentRunInput): Promise<AgentProcess> {
    return this.enqueue(input);
  }

  async restart(runId: string): Promise<AgentProcess> {
    const live = this.running.get(runId);
    const queued = this.queued.find((entry) => entry.runId === runId);
    const input = live?.input ?? queued?.input ?? this.inputFromHistory(runId);
    if (!input) throw new Error(`Run ${runId} cannot be restarted.`);

    if (live || queued) {
      await this.stop(runId);
    }

    return this.enqueue({ ...input, resumeConversationId: undefined });
  }

  private async enqueue(input: AgentRunInput): Promise<AgentProcess> {
    const normalizedPrompt = input.prompt.trim();
    if (!input.cwd.trim()) {
      throw new Error("Project folder is required before starting an agent.");
    }
    if (!normalizedPrompt && !input.interactive) {
      throw new Error("Prompt is required before starting an agent.");
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const record: AgentRunRecord = {
      id: runId,
      cliId: input.cliId,
      cwd: input.cwd,
      prompt: normalizedPrompt || "(interactive session)",
      model: input.model,
      profileId: input.profileId,
      taskId: input.taskId,
      conversationId: input.resumeConversationId,
      status: "queued",
      startedAt,
      exitCode: null,
    };

    this.db.createAgentRun(record);
    if (input.taskId) {
      try {
        this.db.markTaskRunStarted(input.taskId, runId);
      } catch {
        // Scheduled tasks are optional; the agent run must still proceed.
      }
    }
    this.emit({
      runId,
      type: "run:created",
      status: "queued",
      profileId: input.profileId,
      taskId: input.taskId,
      uiMode: input.uiMode,
      conversationId: input.resumeConversationId,
      message: this.running.size >= MAX_CONCURRENT_RUNS ? `Queued behind ${this.running.size} running agent runs.` : undefined,
      timestamp: startedAt,
    });

    // Preflight the executable before queueing. Queueing made start() resolve
    // before the spawn was attempted, so an unresolvable CLI used to fail deep
    // inside drainQueue() and the caller got a healthy-looking "queued" handle
    // for a run that could never start.
    const missing = await this.preflightExecutable(input);
    if (missing) {
      this.db.updateAgentRunStatus(runId, "failed", null);
      this.recordTaskSpawnFailure(input.taskId, runId, missing);
      this.emit({
        runId,
        type: "run:error",
        status: "failed",
        profileId: input.profileId,
        taskId: input.taskId,
        uiMode: input.uiMode,
        message: missing,
        timestamp: new Date().toISOString(),
      });
      throw new Error(missing);
    }

    const queued: QueuedProcess = { runId, input: { ...input, prompt: normalizedPrompt }, startedAt };
    this.queued.push(queued);
    void this.drainQueue();

    return {
      runId,
      status: "queued",
      command: "(queued)",
      args: [],
      interactive: Boolean(input.interactive),
    };
  }

  /**
   * Returns an error message when this run can never spawn, or null when the
   * binary is on PATH. `shell` and `custom`-with-no-override are left to the
   * builder, which already reports them precisely.
   */
  private async preflightExecutable(input: AgentRunInput): Promise<string | null> {
    if (input.cliId === "shell") return null;

    let descriptor: ReturnType<typeof getAgentDescriptor>;
    try {
      descriptor = getAgentDescriptor(input.cliId);
    } catch {
      return `Unknown agent CLI: ${input.cliId}`;
    }

    const resolved = await resolveExecutable(input.cliId, input.commandOverride);
    if (resolved) return null;

    return input.commandOverride?.trim()
      ? `Command "${input.commandOverride.trim()}" was not found.`
      : `${descriptor.displayName} was not found on PATH.`;
  }

  /**
   * Settles the task behind a run that failed to spawn, honouring the retry
   * policy. Both spawn-failure paths (preflight and post-enqueue) land here:
   * `finishTaskRun` alone parks the task in `failed` without touching
   * `attempt_count` or `next_retry_at`, so the scheduler could never retry it.
   */
  private recordTaskSpawnFailure(taskId: string | undefined, runId: string, message: string): void {
    if (!taskId) return;
    try {
      this.db.finishTaskRun(taskId, "failed", runId);
      const task = this.db.getTask(taskId);
      if (!task) return;
      const decision = planRetry({
        attemptCount: task.attemptCount,
        maxAttempts: task.maxAttempts,
        message,
      });
      this.db.recordTaskFailure({ id: taskId, ...decision });
    } catch {
      // The task row is optional bookkeeping; the run error must still surface.
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.shuttingDown || this.drainingQueue) return;
    this.drainingQueue = true;
    try {
      while (this.activeCount() < MAX_CONCURRENT_RUNS && this.queued.length > 0) {
        const next = this.queued.shift();
        if (!next) return;
        this.spawning.set(next.runId, next);
        try {
          await this.spawnQueued(next);
        } finally {
          this.spawning.delete(next.runId);
        }
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  /**
   * Runs occupying a concurrency slot: live children plus spawns in flight.
   * Runs being terminated are excluded — they are already reported as stopped, so
   * holding their slot while SIGKILL escalation plays out would idle the queue for
   * the whole grace period.
   */
  private activeCount(): number {
    let live = 0;
    for (const runId of this.running.keys()) {
      if (!this.terminating.has(runId)) live += 1;
    }
    return live + this.spawning.size;
  }

  private async spawnQueued({ runId, input, startedAt }: QueuedProcess): Promise<void> {
    const normalizedPrompt = input.prompt.trim();
    let invocation: Awaited<ReturnType<typeof buildInvocation>>;
    let providerEnv: NodeJS.ProcessEnv;
    try {
      invocation = await buildInvocation(input);
      providerEnv = resolveProviderEnv(this.db, this.secretVault, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateAgentRunStatus(runId, "failed", null);
      // A failure raised here happens *after* start() already resolved, so the
      // scheduler's own catch block never sees it. Applying the retry policy
      // from this side is what keeps `attempt_count`/`next_retry_at` honest —
      // otherwise finishTaskRun() parked the task in `failed` with a zero
      // attempt count and no backoff, so "Retry now" was the only way out.
      this.recordTaskSpawnFailure(input.taskId, runId, message);
      this.emit({
        runId,
        type: "run:error",
        status: "failed",
        profileId: input.profileId,
        taskId: input.taskId,
        uiMode: input.uiMode,
        message,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const child = spawn(invocation.executable, invocation.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...providerEnv,
        FORCE_COLOR: "1",
        TERM: process.env.TERM ?? "xterm-256color",
      },
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    const structuredChat = usesStructuredChat(input);
    // stop() may have landed while buildInvocation() was awaited. The run is
    // already recorded as stopped, so kill the fresh child instead of publishing
    // it as live and leaving an orphaned process behind.
    if (this.cancelledSpawns.delete(runId) || this.shuttingDown) {
      child.kill(process.platform === "win32" ? undefined : "SIGTERM");
      return;
    }

    this.running.set(runId, {
      input,
      process: child,
      command: invocation.executable,
      args: invocation.args,
      interactive: Boolean(input.interactive),
      startedAt,
      status: "planning",
      taskId: input.taskId,
      structuredChat,
      stdoutBuffer: "",
      conversationId: input.resumeConversationId,
    });
    this.db.updateAgentRunStatus(runId, "planning");

    this.emit({
      runId,
      type: "run:started",
      status: "planning",
      profileId: input.profileId,
      taskId: input.taskId,
      uiMode: input.uiMode,
      conversationId: input.resumeConversationId,
      message: `$ ${quoteCommand([invocation.executable, ...invocation.args])}${child.pid ? `  (pid ${child.pid})` : ""}`,
      timestamp: new Date().toISOString(),
    });

    if (input.uiMode === "chat" && normalizedPrompt) {
      this.emit({
        runId,
        type: "run:stdin",
        profileId: input.profileId,
        taskId: input.taskId,
        uiMode: input.uiMode,
        conversationId: input.resumeConversationId,
        message: normalizedPrompt,
        timestamp: new Date().toISOString(),
      });
    }

    if (invocation.stdinPrompt && child.stdin.writable) {
      child.stdin.write(`${invocation.stdinPrompt}\n`);
    }
    // One-shot runs must close stdin, otherwise CLIs wait for piped input.
    if (!input.interactive && child.stdin.writable) {
      child.stdin.end();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      this.handleOutput(runId, "run:stdout", chunk.toString());
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.handleOutput(runId, "run:stderr", chunk.toString());
    });

    child.on("error", (error) => {
      // Publish buffered output before the failure so the terminal keeps the
      // order the CLI produced, and so the run's last words are not dropped
      // when the pending map is cleared below.
      this.flushOutput(runId);
      this.running.delete(runId);
      if (this.stoppedByUser.delete(runId) || this.shuttingDown) return;
      this.db.updateAgentRunStatus(runId, "failed", null);
      this.recordTaskSpawnFailure(input.taskId, runId, error.message);
      this.emit({
        runId,
        type: "run:error",
        status: "failed",
        profileId: input.profileId,
        taskId: input.taskId,
        uiMode: input.uiMode,
        message: error.message,
        timestamp: new Date().toISOString(),
      });
      void this.drainQueue();
    });

    child.on("exit", (code) => {
      // Must precede the `running` lookup below: the conversation id is parsed
      // out of stdout by publishOutput(), so a still-buffered final chunk would
      // otherwise be dropped and a structured-chat run would lose the id it
      // needs to resume the thread on the next turn.
      this.flushOutput(runId);
      const running = this.running.get(runId);
      this.running.delete(runId);
      // stop() already settled this run; SIGTERM reports a null exit code, which
      // would otherwise be recorded as a failure over the user's "stopped".
      if (this.stoppedByUser.delete(runId) || this.shuttingDown) return;
      const status: AgentStatus = code === 0 ? "completed" : "failed";
      const conversationId =
        running?.conversationId ??
        extractConversationId(running?.stdoutBuffer ?? "", conversationIdFields(input.cliId));
      this.db.updateAgentRunStatus(runId, status, code, conversationId);
      if (input.taskId) {
        this.db.finishTaskRun(input.taskId, status, runId);
      }
      this.emit({
        runId,
        type: "run:exit",
        status,
        profileId: input.profileId,
        taskId: input.taskId,
        uiMode: input.uiMode,
        conversationId,
        message: `Process exited with code ${code ?? "unknown"}`,
        timestamp: new Date().toISOString(),
      });
      void this.drainQueue();
    });
  }

  private inputFromHistory(runId: string): AgentRunInput | null {
    const record = this.db.getAgentRun(runId);
    if (!record) return null;

    const profile = record.profileId
      ? this.db.listAgentProfiles().find((candidate) => candidate.id === record.profileId)
      : undefined;
    const prompt = record.prompt === "(interactive session)" ? "" : record.prompt;

    return {
      cliId: profile?.cliId ?? record.cliId,
      cwd: profile?.cwd ?? record.cwd,
      prompt,
      model: profile?.model ?? record.model,
      profileId: record.profileId,
      taskId: record.taskId,
      providerConnectionId: profile?.providerConnectionId,
      interactive: profile?.interactive,
      uiMode: "terminal",
      extraArgs: profile?.extraArgs,
      commandOverride: profile?.commandOverride,
      promptMode: profile?.promptMode,
      forceTty: profile?.forceTty,
      autoApprove: profile?.autoApprove,
      systemPrompt: profile?.systemPrompt,
      options: profile?.options,
      shellCommand: (profile?.cliId ?? record.cliId) === "shell" ? prompt : undefined,
    };
  }

  /** Writes raw input to a live process stdin (terminal keystrokes / answers). */
  send(runId: string, data: string): boolean {
    const running = this.running.get(runId);
    if (!running || !running.process.stdin.writable) return false;

    running.process.stdin.write(data);
    this.db.appendTerminalLog(runId, "stdin", data);
    return true;
  }

  async stop(runId: string): Promise<void> {
    // Cancelled mid-spawn: the child does not exist yet, so record the decision
    // and let spawnQueued() kill it the moment it has a handle.
    const spawningEntry = this.spawning.get(runId);
    if (spawningEntry) {
      this.stoppedByUser.add(runId);
      this.cancelledSpawns.add(runId);
      this.db.updateAgentRunStatus(runId, "stopped", null);
      if (spawningEntry.input.taskId) {
        this.db.finishTaskRun(spawningEntry.input.taskId, "stopped", runId);
      }
      this.emit({
        runId,
        type: "run:status",
        status: "stopped",
        profileId: spawningEntry.input.profileId,
        taskId: spawningEntry.input.taskId,
        uiMode: spawningEntry.input.uiMode,
        message: "Agent stopped before it started",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const queuedIndex = this.queued.findIndex((entry) => entry.runId === runId);
    if (queuedIndex >= 0) {
      const [queued] = this.queued.splice(queuedIndex, 1);
      this.db.updateAgentRunStatus(runId, "stopped", null);
      if (queued.input.taskId) {
        this.db.finishTaskRun(queued.input.taskId, "stopped", runId);
      }
      this.emit({
        runId,
        type: "run:status",
        status: "stopped",
        profileId: queued.input.profileId,
        taskId: queued.input.taskId,
        uiMode: queued.input.uiMode,
        message: "Queued agent run cancelled",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const running = this.running.get(runId);
    if (!running) return;

    // Keep the terminal in the order the CLI produced: anything it printed
    // before the stop must land above the "stopped" event, not after it.
    this.flushOutput(runId);

    // Claim the run before signalling, so the exit handler that SIGTERM triggers
    // sees the decision and leaves the "stopped" status alone.
    this.stoppedByUser.add(runId);
    // Do not delete the map entry yet. `stop()` has to be able to escalate, and
    // the entry is the only handle on the child; dropping it here is what used to
    // make "stopped" a claim rather than a fact — a CLI that traps SIGTERM kept
    // running with nothing left to signal it. `terminating` keeps it out of the
    // concurrency count and the session list while the kill is in flight.
    this.terminating.add(runId);
    this.db.updateAgentRunStatus(runId, "stopped", null);
    if (running.input.taskId) {
      this.db.finishTaskRun(running.input.taskId, "stopped", runId);
    }
    this.emit({
      runId,
      type: "run:status",
      status: "stopped",
      profileId: running.input.profileId,
      taskId: running.input.taskId,
      uiMode: running.input.uiMode,
      message: "Agent stopped by user",
      timestamp: new Date().toISOString(),
    });

    // Free the slot before awaiting the kill: a queued run should not wait out
    // the grace period of a child that is already logically stopped.
    void this.drainQueue();

    try {
      const outcome = await terminateProcessTree(running.process, {
        graceMs: this.killGraceMs,
        onEscalate: ({ pid, descendants }) => {
          // Worth surfacing: a CLI that regularly needs SIGKILL is either
          // trapping SIGTERM or wedged, and the terminal log is where a user
          // looking at a stuck agent will actually look. Skipped on the quit
          // path, where the database handle is already closed.
          if (this.shuttingDown) return;
          this.db.appendTerminalLog(
            runId,
            "event",
            `SIGTERM ignored after ${this.killGraceMs}ms — escalating to SIGKILL (pid ${pid}` +
              `${descendants.length > 0 ? `, ${descendants.length} child process(es)` : ""}).`,
          );
        },
      });
      if (outcome === "unkillable" && !this.shuttingDown) {
        this.db.appendTerminalLog(
          runId,
          "event",
          `Process ${running.process.pid} survived SIGKILL; it may be blocked in the kernel.`,
        );
      }
    } catch {
      // terminateProcessTree never rejects, but a logging failure on a closing
      // database must not turn the quit path into an unhandled rejection.
    } finally {
      this.running.delete(runId);
      this.terminating.delete(runId);
    }

    void this.drainQueue();
  }

  /**
   * Quit path: signals every live child and stops recording. The children exit
   * asynchronously, after `before-quit` has already closed the database, so any
   * further DB write from an exit handler would hit a closed handle.
   */
  stopAll(): void {
    // Settle the queue *before* raising the shutdown flag: these runs never
    // spawned, so nothing else will ever move them off `queued`. Left as-is the
    // row survived the restart as a permanent zombie and its task stayed
    // `investigating` forever, which also made it a stall-sweep candidate.
    const abandoned = this.queued.splice(0, this.queued.length);
    for (const entry of abandoned) {
      try {
        this.db.updateAgentRunStatus(entry.runId, "stopped", null);
        if (entry.input.taskId) {
          this.db.recordTaskFailure({
            id: entry.input.taskId,
            attemptCount: 0,
            status: "open",
            nextRetryAt: null,
            lastError: "App quit before this run started. It will be retried.",
          });
        }
      } catch {
        // The database may already be closing; a best-effort settle is enough.
      }
    }

    this.shuttingDown = true;
    // Drop buffered output and its timers: `before-quit` closes the database
    // immediately after this returns, so a late flush would write to a closed
    // handle. The runs are already recorded as stopped and no reader survives.
    for (const pending of this.pendingOutput.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pendingOutput.clear();
    for (const runId of [...this.running.keys()]) {
      void this.stop(runId);
    }
  }

  sessions(): AgentSessionSummary[] {
    // Terminating runs are filtered out: the user has already been shown
    // "stopped", so listing them for the length of the grace period would make a
    // stopped agent look like it is still working.
    const running = [...this.running.entries()]
      .filter(([runId]) => !this.terminating.has(runId))
      .map(([runId, running]) => ({
        runId,
        cliId: running.input.cliId,
        profileId: running.input.profileId,
        model: running.input.model,
        cwd: running.input.cwd,
        status: running.status,
        pid: running.process.pid,
        interactive: running.interactive,
        startedAt: running.startedAt,
        command: quoteCommand([running.command, ...running.args]),
      }));

    const spawning = [...this.spawning.values()].map((entry) => ({
      runId: entry.runId,
      cliId: entry.input.cliId,
      profileId: entry.input.profileId,
      model: entry.input.model,
      cwd: entry.input.cwd,
      status: "planning" as AgentStatus,
      interactive: Boolean(entry.input.interactive),
      startedAt: entry.startedAt,
      command: "(starting)",
    }));

    const queued = this.queued.map((entry, index) => ({
      runId: entry.runId,
      cliId: entry.input.cliId,
      profileId: entry.input.profileId,
      model: entry.input.model,
      cwd: entry.input.cwd,
      status: "queued" as AgentStatus,
      interactive: Boolean(entry.input.interactive),
      startedAt: entry.startedAt,
      command: `Queued (${index + 1}/${this.queued.length})`,
    }));

    return [...running, ...spawning, ...queued];
  }

  /**
   * Buffers one stdout/stderr chunk. The write, the status hint and the IPC
   * message all happen in `flushOutput`, at most once per `OUTPUT_FLUSH_MS`.
   */
  private handleOutput(runId: string, type: "run:stdout" | "run:stderr", message: string): void {
    // The quit path is synchronous — `stopAll()` signals every child and
    // `before-quit` closes the database immediately afterwards — but the children
    // outlive it by up to the whole SIGTERM grace period, and a CLI prints on its
    // way out. That trailing output arrived on a closed handle and threw
    // "database is not open" from a stream callback, i.e. an uncaughtException on
    // the way to exit, once per still-running agent.
    //
    // Dropping the last bytes of a dying CLI's output while the app is quitting
    // is the correct trade: the run is already recorded as stopped, and no reader
    // survives to display them.
    if (this.shuttingDown) return;

    let pending = this.pendingOutput.get(runId);
    if (!pending) {
      pending = { chunks: [], bytes: 0, timer: null };
      this.pendingOutput.set(runId, pending);
    }

    // Merge into the previous chunk while the stream is unchanged: stdout and
    // stderr have to stay separate rows and separate events, but consecutive
    // writes on the same stream are just one longer piece of text.
    const last = pending.chunks[pending.chunks.length - 1];
    if (last && last.type === type) {
      last.text += message;
    } else {
      pending.chunks.push({ type, text: message });
    }
    pending.bytes += message.length;

    if (pending.bytes >= OUTPUT_FLUSH_BYTES) {
      this.flushOutput(runId);
      return;
    }
    if (!pending.timer) {
      pending.timer = setTimeout(() => this.flushOutput(runId), OUTPUT_FLUSH_MS);
      // Never hold the event loop open for buffered log text: the app must be
      // able to quit inside the flush window.
      pending.timer.unref?.();
    }
  }

  /**
   * Publishes whatever this run has buffered. Called on the flush timer, when the
   * buffer grows past `OUTPUT_FLUSH_BYTES`, and before any terminal event so the
   * user never sees "exited" above the output that preceded it.
   */
  private flushOutput(runId: string): void {
    const pending = this.pendingOutput.get(runId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingOutput.delete(runId);
    if (this.shuttingDown) return;

    for (const chunk of pending.chunks) {
      this.publishOutput(runId, chunk.type, chunk.text);
    }
  }

  private publishOutput(runId: string, type: "run:stdout" | "run:stderr", message: string): void {
    this.db.appendTerminalLog(runId, type === "run:stderr" ? "stderr" : "stdout", message);
    const running = this.running.get(runId);
    if (running?.structuredChat && type === "run:stdout") {
      running.stdoutBuffer += message;
      running.conversationId =
        extractConversationId(running.stdoutBuffer, conversationIdFields(running.input.cliId)) ??
        running.conversationId;
      // Once the id is known the buffer has done its job, so drop it rather than
      // accumulating a whole chat's stdout in memory for the life of the run. Until
      // then keep the head: the id sits in the first JSON object the CLI prints, so
      // clamping the tail would throw away the very bytes we are waiting for.
      running.stdoutBuffer = running.conversationId
        ? ""
        : running.stdoutBuffer.slice(0, STRUCTURED_CHAT_BUFFER_LIMIT);
    }

    const hintedStatus = statusHints.find(({ match }) => match.test(message))?.status;
    // Only a run still in `running` may have its status advanced. stdout can be
    // flushed after the exit handler has already recorded completed/failed/
    // stopped, and writing a hint then resurrected a finished run into
    // "coding"/"testing" — a terminal status must stay terminal.
    //
    // A terminating run is still in `running` (stop() keeps the handle so it can
    // escalate), and a CLI being killed usually prints on its way out. Without
    // the `terminating` guard that farewell output would relabel a run the user
    // has already been told is stopped.
    if (running && !this.terminating.has(runId) && hintedStatus && running.status !== hintedStatus) {
      running.status = hintedStatus;
      this.db.updateAgentRunStatus(runId, hintedStatus);
      this.emit({
        runId,
        type: "run:status",
        status: hintedStatus,
        profileId: running?.input.profileId,
        taskId: running?.input.taskId,
        uiMode: running?.input.uiMode,
        conversationId: running?.conversationId,
        timestamp: new Date().toISOString(),
      });
    }

    this.emit({
      runId,
      type,
      message,
      profileId: running?.input.profileId,
      taskId: running?.input.taskId,
      uiMode: running?.input.uiMode,
      conversationId: running?.conversationId,
      timestamp: new Date().toISOString(),
    });
  }

  private emit(event: AgentEvent): void {
    const isLifecycle =
      event.type === "run:created" ||
      event.type === "run:started" ||
      event.type === "run:exit" ||
      event.type === "run:error";

    if (isLifecycle && event.message) {
      this.db.appendTerminalLog(event.runId, "event", event.message);
    }

    this.webContentsProvider()?.send("agent:event", event);
  }
}

const DEFAULT_CONVERSATION_ID_FIELDS = ["session_id", "conversation_id"];

/** Conversation-id keys this CLI uses, falling back to the common pair. */
function conversationIdFields(cliId: AgentRunInput["cliId"]): string[] {
  const fields = structuredChatFor(cliId)?.conversationIdFields;
  return fields?.length ? fields : DEFAULT_CONVERSATION_ID_FIELDS;
}

/**
 * Pulls a conversation id out of a CLI's structured output.
 *
 * Handles both shapes a chat CLI actually emits: one whole JSON object, and
 * JSONL where each line is its own object. The old version only did the former,
 * so a CLI that streamed line-delimited JSON silently never resumed. Partial
 * trailing lines are expected while output is still streaming and are skipped
 * rather than treated as an error.
 *
 * The last id wins: a CLI that reprints the id per line is still describing the
 * same conversation, and the freshest line is the safest one to trust.
 */
export function extractConversationId(output: string, fields = DEFAULT_CONVERSATION_ID_FIELDS): string | undefined {
  const readId = (raw: string): string | undefined => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object") return undefined;
    for (const field of fields) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };

  const whole = readId(output);
  if (whole) return whole;

  let found: string | undefined;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    found = readId(trimmed) ?? found;
  }
  return found;
}
