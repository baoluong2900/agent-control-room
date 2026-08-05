import type { WebContents } from "electron";
import type {
  AgentCliId,
  KnowledgeSnapshot,
  TaskEvent,
  TaskPlanInput,
  TaskPlanResult,
  TaskRecord,
  TaskScheduleTickResult,
} from "@contracts";
import { quoteCommand } from "../agents/commands";
import { pingAllAgentClis } from "../agents/probe";
import { resolveProviderEnv } from "../agents/provider-resolver";
import type { ProviderSecretVault } from "../settings/provider-secret-vault";
import { requestAiPlan } from "./ai-planner";
import type { DesktopDatabase } from "../database/desktop-database";
import type { AgentProcessManager } from "../processes/agent-process-manager";
import {
  buildScheduledTaskPrompt,
  buildShellScheduledTaskOutput,
  buildTaskPlan,
  defaultModelForCli,
  type AiPlanOverride,
} from "./task-planner";
import { isStalled, planRetry, STALL_SILENCE_MS } from "./retry-policy";

type TaskAutomationOptions = {
  intervalMs?: number;
};

/**
 * How long a CLI-availability probe stays good for.
 *
 * Probing all 13 CLIs spawns 13 processes, so doing it per plan would make
 * planning noticeably slow for a result that changes only when the user installs
 * something. Five minutes is short enough that a fresh install is picked up in the
 * same session.
 */
const CLI_AVAILABILITY_TTL_MS = 5 * 60_000;

export class TaskAutomationService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private cliAvailability: { ids: AgentCliId[]; checkedAt: number } | null = null;

  constructor(
    private readonly db: DesktopDatabase,
    private readonly agentProcessManager: AgentProcessManager,
    private readonly webContentsProvider: () => WebContents | null,
    /**
     * Appended as optional so the existing callers (tests, five harnesses) keep
     * working unchanged. Without them, AI planning degrades to the template plan
     * with a stated reason rather than failing.
     */
    private readonly knowledgeSnapshotProvider?: (projectPath: string) => KnowledgeSnapshot | null,
    private readonly secretVault?: ProviderSecretVault,
  ) {}

  start(options: TaskAutomationOptions = {}): void {
    if (this.timer) return;
    const intervalMs = Math.max(10_000, options.intervalMs ?? 30_000);
    void this.runDueTasks();
    this.timer = setInterval(() => {
      void this.runDueTasks();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Installed agent CLIs, cached for `CLI_AVAILABILITY_TTL_MS`.
   *
   * Returns undefined if probing fails outright, which the planner reads as "not
   * told" and answers by keeping its historical preferences — better than claiming
   * nothing is installed and collapsing every step onto `shell`.
   */
  private async availableCliIds(): Promise<AgentCliId[] | undefined> {
    const cached = this.cliAvailability;
    if (cached && Date.now() - cached.checkedAt < CLI_AVAILABILITY_TTL_MS) return cached.ids;

    try {
      const results = await pingAllAgentClis();
      const ids = results.filter((result) => result.installed).map((result) => result.cliId);
      this.cliAvailability = { ids, checkedAt: Date.now() };
      return ids;
    } catch {
      return undefined;
    }
  }

  async planTask(input: TaskPlanInput): Promise<TaskPlanResult> {
    // Probe unless the caller already knows: the renderer may pass a list it just
    // fetched for its own UI, and there is no reason to spawn 13 processes again.
    const availableCliIds = input.availableCliIds ?? (await this.availableCliIds());
    const resolved: TaskPlanInput = { ...input, availableCliIds };

    let aiPlan: AiPlanOverride | undefined;
    let fallbackReason: string | undefined;

    if (input.mode === "ai") {
      const attempt = await this.tryAiPlan(resolved, availableCliIds);
      aiPlan = attempt.plan;
      fallbackReason = attempt.reason;
    }

    const draft = buildTaskPlan(resolved, aiPlan);
    const parent = this.db.saveTask(draft.parent);
    const subtasks = draft.subtasks.map((subtask) =>
      this.db.saveTask({
        ...subtask,
        projectPath: subtask.projectPath ?? parent.projectPath ?? null,
        parentTaskId: parent.id,
      }),
    );

    return {
      parent,
      subtasks,
      summary: {
        ...draft.summary,
        // Only meaningful when AI was asked for and not delivered. Always stated, so
        // a fallback never masquerades as the model writing a generic plan.
        ...(fallbackReason ? { fallbackReason } : {}),
      },
    };
  }

  /**
   * Attempts an AI plan, returning the reason instead of throwing on failure.
   *
   * Every path through here is recoverable by design: the caller always gets a plan,
   * and asking for AI can only ever cost time, never correctness.
   */
  private async tryAiPlan(
    input: TaskPlanInput,
    availableCliIds: AgentCliId[] | undefined,
  ): Promise<{ plan?: AiPlanOverride; reason?: string }> {
    const cwd = input.projectPath?.trim();
    if (!cwd) return { reason: "AI planning needs a project folder; used the template plan." };

    // `shell` and `custom` are excluded by type, not just by filter: buildInvocation
    // cannot construct a shell invocation, and a shell "planner" has no model to ask.
    const agents = (availableCliIds ?? []).filter(
      (cliId): cliId is Exclude<AgentCliId, "shell" | "custom"> => cliId !== "shell" && cliId !== "custom",
    );
    const cliId = input.preferredCliId && agents.includes(input.preferredCliId as (typeof agents)[number])
      ? (input.preferredCliId as (typeof agents)[number])
      : agents[0];
    if (!cliId) return { reason: "No agent CLI is installed; used the template plan." };

    try {
      // The snapshot is read, never built: planning must not silently trigger a
      // full project scan. An unscanned project simply plans without context.
      const snapshot = this.knowledgeSnapshotProvider?.(cwd) ?? null;
      const outcome = await requestAiPlan({
        request: input.request,
        cwd,
        cliId,
        model: input.model ?? undefined,
        availableCliIds: availableCliIds ?? [],
        snapshot,
        env: resolveProviderEnv(this.db, this.secretVault, { cliId }),
      });
      return { plan: { steps: outcome.steps, difficulty: outcome.difficulty } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { reason: `AI planning failed (${message.slice(0, 160)}); used the template plan.` };
    }
  }

  async runDueTasks(): Promise<TaskScheduleTickResult> {
    if (this.ticking) {
      return { started: [], failed: [] };
    }

    this.ticking = true;
    const started: TaskRecord[] = [];
    const failed: TaskScheduleTickResult["failed"] = [];

    try {
      failed.push(...(await this.sweepStalledTasks()));
      const dueTasks = this.db.listDueTasks();
      for (const task of dueTasks) {
        if (!task.projectPath) {
          this.db.setTaskStatus(task.id, "blocked");
          failed.push({
            taskId: task.id,
            title: task.title,
            message: "Task is missing a project folder.",
          });
          this.emit({
            type: "task:blocked",
            taskId: task.id,
            title: task.title,
            message: `✖ ${task.title} is missing a project folder`,
          });
          continue;
        }

        const cliId = task.assignedCliId ?? "shell";
        const model = task.assignedModel?.trim() || defaultModelForCli(cliId);

        try {
          const prompt = buildScheduledTaskPrompt(task);
          const agentProcess = await this.agentProcessManager.start({
            cliId,
            cwd: task.projectPath,
            prompt,
            model,
            shellCommand: cliId === "shell" ? quoteCommand(["printf", "%s\n", buildShellScheduledTaskOutput(task)]) : undefined,
            taskId: task.id,
          });

          started.push(this.db.getTask(task.id) ?? task);
          this.emit({
            type: "task:started",
            taskId: task.id,
            title: task.title,
            runId: agentProcess.runId,
            message: `▶ ${task.title} queued on ${cliId} (${agentProcess.runId.slice(0, 8)})`,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Before the retry policy this branch left the task `open` with a past
          // `due_at`, so the next tick 30 seconds later spawned it again — for
          // ever. Every failure now consumes an attempt and earns a backoff.
          const decision = planRetry({
            attemptCount: task.attemptCount,
            maxAttempts: task.maxAttempts,
            message,
          });
          this.db.recordTaskFailure({ id: task.id, ...decision });
          failed.push({ taskId: task.id, title: task.title, message });
          this.emit({
            type: "task:failed",
            taskId: task.id,
            title: task.title,
            message:
              decision.status === "failed"
                ? `⚠ ${task.title}: ${message} (gave up after ${decision.attemptCount} attempt${
                    decision.attemptCount === 1 ? "" : "s"
                  })`
                : `⚠ ${task.title}: ${message} (retry ${decision.attemptCount}/${task.maxAttempts} at ${decision.nextRetryAt})`,
          });
        }
      }
    } finally {
      this.ticking = false;
    }

    return { started, failed };
  }

  /**
   * Manually clears a task's attempt budget and runs the scheduler immediately.
   * Backs the "Retry now" button on a `failed` card.
   */
  async retryTaskNow(taskId: string): Promise<TaskScheduleTickResult> {
    this.db.resetTaskRetries(taskId);
    return this.runDueTasks();
  }

  /**
   * Fails tasks whose agent stopped producing output.
   *
   * The signal is silence, not elapsed time: a large refactor can legitimately
   * run for hours, and killing it on a wall-clock budget alone would throw away
   * real work. A run with a fresh terminal log line is alive no matter how long
   * it has been going; only `MAX_RUN_MS` overrides that.
   *
   * `now` and `silenceMs` are injectable so a test can shrink the window instead
   * of waiting fifteen real minutes.
   */
  async sweepStalledTasks(
    options: { now?: Date; silenceMs?: number } = {},
  ): Promise<TaskScheduleTickResult["failed"]> {
    const now = options.now ?? new Date();
    const silenceMs = options.silenceMs ?? STALL_SILENCE_MS;
    const reaped: TaskScheduleTickResult["failed"] = [];
    const cutoff = new Date(now.getTime() - silenceMs).toISOString();

    for (const task of this.db.listStalledTaskCandidates(cutoff)) {
      // `markTaskRunStarted` flips the task to `investigating` at enqueue time,
      // so a run still waiting behind the concurrency limit looks exactly like a
      // hung agent here. A run that has not spawned yet has produced no output
      // by definition and must not be reaped — the silence window only means
      // something once a child actually exists.
      if (task.lastRunId && this.db.getAgentRun(task.lastRunId)?.status === "queued") continue;

      const lastOutputAt = task.lastRunId ? this.db.lastTerminalLogAt(task.lastRunId) : null;
      if (!isStalled({ startedAt: task.lastRunAt, lastOutputAt, now, silenceMs })) continue;

      // Awaited, not fired-and-forgotten: `stop()` settles the task through
      // `finishTaskRun`, and a late write would clobber the counters below.
      if (task.lastRunId) {
        await this.agentProcessManager.stop(task.lastRunId);
      }

      const message = `Agent produced no output for ${Math.round(silenceMs / 60_000)} minutes.`;
      const decision = planRetry({
        attemptCount: task.attemptCount,
        maxAttempts: task.maxAttempts,
        message,
        now,
      });
      this.db.recordTaskFailure({ id: task.id, ...decision });
      reaped.push({ taskId: task.id, title: task.title, message });
      this.emit({
        type: "task:failed",
        taskId: task.id,
        title: task.title,
        runId: task.lastRunId ?? undefined,
        message: `⚠ ${task.title}: ${message}`,
      });
    }

    return reaped;
  }

  private emit(event: Omit<TaskEvent, "timestamp">): void {
    this.webContentsProvider()?.send("task:event", {
      ...event,
      timestamp: new Date().toISOString(),
    } satisfies TaskEvent);
  }
}
