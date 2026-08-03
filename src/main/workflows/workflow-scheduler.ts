import type { WebContents } from "electron";
import type { WorkflowDefinition, WorkflowEvent } from "@contracts";
import type { WorkflowService } from "./workflow-service";
import { parseSchedule, previousOccurrence } from "./workflow-schedule";

type SchedulerOptions = {
  intervalMs?: number;
};

/**
 * Fires `schedule`-triggered workflows. Without this, the "Scheduled" trigger in
 * the editor was decorative — a workflow saying "Daily, 9:00 AM" never ran until
 * someone pressed Run.
 *
 * A workflow is due when its most recent scheduled moment is newer than its last
 * recorded run. Workflows that have never run are baselined against the moment
 * the scheduler booted, so launching the app does not immediately fire every
 * schedule whose time already passed earlier today.
 */
export class WorkflowSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private startedAt = new Date();
  /** Guards against re-firing the same slot when a run is slow to record. */
  private readonly lastFiredFor = new Map<string, number>();

  constructor(
    private readonly workflows: WorkflowService,
    private readonly webContentsProvider: () => WebContents | null,
  ) {}

  start(options: SchedulerOptions = {}): void {
    if (this.timer) return;
    this.startedAt = new Date();
    const intervalMs = Math.max(15_000, options.intervalMs ?? 60_000);
    this.timer = setInterval(() => {
      void this.runDueWorkflows();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs every workflow whose schedule came due, sequentially. */
  async runDueWorkflows(now = new Date()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const fired: string[] = [];

    try {
      for (const workflow of this.workflows.list()) {
        const dueAt = this.dueMoment(workflow, now);
        if (!dueAt) continue;

        this.lastFiredFor.set(workflow.id, dueAt.getTime());
        this.emitTriggered(workflow, dueAt);

        try {
          await this.workflows.run({ workflowId: workflow.id, triggeredBy: "schedule" });
          fired.push(workflow.id);
        } catch (error) {
          // One broken workflow must not stop the rest of the tick.
          this.emitFailure(workflow, error);
        }
      }
    } finally {
      this.ticking = false;
    }

    return fired;
  }

  /** The scheduled moment this workflow owes a run for, or null when it is current. */
  private dueMoment(workflow: WorkflowDefinition, now: Date): Date | null {
    if (workflow.status !== "active") return null;
    if (workflow.trigger.type !== "schedule") return null;
    if (!workflow.steps.some((step) => step.enabled)) return null;

    const schedule = parseSchedule(workflow.trigger.schedule);
    if (!schedule) return null;

    const dueAt = previousOccurrence(schedule, now);
    if (!dueAt) return null;

    const alreadyFired = this.lastFiredFor.get(workflow.id);
    if (alreadyFired !== undefined && dueAt.getTime() <= alreadyFired) return null;

    const lastRunAt = workflow.stats.lastRunAt ? Date.parse(workflow.stats.lastRunAt) : NaN;
    const baseline = Number.isFinite(lastRunAt) ? lastRunAt : this.startedAt.getTime();
    return dueAt.getTime() > baseline ? dueAt : null;
  }

  private emitTriggered(workflow: WorkflowDefinition, dueAt: Date): void {
    this.emit(workflow, `⏰ Schedule "${workflow.trigger.schedule}" came due at ${dueAt.toLocaleString()}`);
  }

  private emitFailure(workflow: WorkflowDefinition, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.emit(workflow, `⚠ Scheduled run could not start: ${message}`);
  }

  /** These log lines precede the run itself, so there is no run id to attach yet. */
  private emit(workflow: WorkflowDefinition, message: string): void {
    this.webContentsProvider()?.send("workflow:event", {
      type: "workflow:log",
      workflowId: workflow.id,
      workflowRunId: "",
      message,
      timestamp: new Date().toISOString(),
    } satisfies WorkflowEvent);
  }
}
