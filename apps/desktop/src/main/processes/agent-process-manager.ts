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
import { buildInvocation, cliDisplayNames, quoteCommand } from "../agents/commands";
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
};

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

  constructor(
    private readonly db: DesktopDatabase,
    private readonly webContentsProvider: () => WebContents | null,
  ) {}

  async start(input: AgentRunInput): Promise<AgentProcess> {
    const normalizedPrompt = input.prompt.trim();
    if (!input.cwd.trim()) {
      throw new Error("Project folder is required before starting an agent.");
    }
    if (!normalizedPrompt && !input.interactive) {
      throw new Error("Prompt is required before starting an agent.");
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const displayName = cliDisplayNames[input.cliId] ?? input.cliId;

    const record: AgentRunRecord = {
      id: runId,
      cliId: input.cliId,
      cwd: input.cwd,
      prompt: normalizedPrompt || "(interactive session)",
      model: input.model,
      profileId: input.profileId,
      taskId: input.taskId,
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
      message: `${displayName} queued`,
      timestamp: startedAt,
    });

    let invocation: Awaited<ReturnType<typeof buildInvocation>>;
    try {
      invocation = await buildInvocation(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateAgentRunStatus(runId, "failed", null);
      if (input.taskId) {
        this.db.finishTaskRun(input.taskId, "failed", runId);
      }
      this.emit({
        runId,
        type: "run:error",
        status: "failed",
        profileId: input.profileId,
        taskId: input.taskId,
        message,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }

    const child = spawn(invocation.executable, invocation.args, {
      cwd: input.cwd,
      env: { ...process.env, FORCE_COLOR: "1", TERM: process.env.TERM ?? "xterm-256color" },
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    this.running.set(runId, {
      input,
      process: child,
      command: invocation.executable,
      args: invocation.args,
      interactive: Boolean(input.interactive),
      startedAt,
      status: "planning",
      taskId: input.taskId,
    });
    this.db.updateAgentRunStatus(runId, "planning");

    this.emit({
      runId,
      type: "run:started",
      status: "planning",
      profileId: input.profileId,
      taskId: input.taskId,
      message: `$ ${quoteCommand([invocation.executable, ...invocation.args])}${child.pid ? `  (pid ${child.pid})` : ""}`,
      timestamp: new Date().toISOString(),
    });

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
      this.running.delete(runId);
      this.db.updateAgentRunStatus(runId, "failed", null);
      if (input.taskId) {
        this.db.finishTaskRun(input.taskId, "failed", runId);
      }
      this.emit({
        runId,
        type: "run:error",
        status: "failed",
        profileId: input.profileId,
        taskId: input.taskId,
        message: error.message,
        timestamp: new Date().toISOString(),
      });
    });

    child.on("exit", (code) => {
      this.running.delete(runId);
      const status: AgentStatus = code === 0 ? "completed" : "failed";
      this.db.updateAgentRunStatus(runId, status, code);
      if (input.taskId) {
        this.db.finishTaskRun(input.taskId, status, runId);
      }
      this.emit({
        runId,
        type: "run:exit",
        status,
        profileId: input.profileId,
        taskId: input.taskId,
        message: `Process exited with code ${code ?? "unknown"}`,
        timestamp: new Date().toISOString(),
      });
    });

    return {
      runId,
      status: "planning",
      pid: child.pid,
      command: invocation.executable,
      args: invocation.args,
      interactive: Boolean(input.interactive),
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
    const running = this.running.get(runId);
    if (!running) return;

    running.process.kill(process.platform === "win32" ? undefined : "SIGTERM");
    this.running.delete(runId);
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
      message: "Agent stopped by user",
      timestamp: new Date().toISOString(),
    });
  }

  stopAll(): void {
    for (const runId of [...this.running.keys()]) {
      void this.stop(runId);
    }
  }

  sessions(): AgentSessionSummary[] {
    return [...this.running.entries()].map(([runId, running]) => ({
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
  }

  private handleOutput(runId: string, type: "run:stdout" | "run:stderr", message: string): void {
    this.db.appendTerminalLog(runId, type === "run:stderr" ? "stderr" : "stdout", message);
    const running = this.running.get(runId);

    const hintedStatus = statusHints.find(({ match }) => match.test(message))?.status;
    if (hintedStatus && running?.status !== hintedStatus) {
      if (running) running.status = hintedStatus;
      this.db.updateAgentRunStatus(runId, hintedStatus);
      this.emit({
        runId,
        type: "run:status",
        status: hintedStatus,
        profileId: running?.input.profileId,
        taskId: running?.input.taskId,
        timestamp: new Date().toISOString(),
      });
    }

    this.emit({
      runId,
      type,
      message,
      profileId: running?.input.profileId,
      taskId: running?.input.taskId,
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
