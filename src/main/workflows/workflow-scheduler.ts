import fs, { type FSWatcher } from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import type { WorkflowDefinition, WorkflowEvent } from "@contracts";
import type { WorkflowService } from "./workflow-service";
import { parseSchedule, previousOccurrence } from "./workflow-schedule";

type SchedulerOptions = {
  intervalMs?: number;
};

const FILE_CHANGE_DEBOUNCE_MS = 1_000;

/**
 * Fires locally runnable workflow triggers: friendly schedules and project file
 * changes. GitHub/Jira/webhook triggers remain disabled in the editor until the
 * app has real integrations listening for them; this service deliberately does not
 * pretend to handle remote events it cannot receive.
 *
 * Scheduled workflows are due when their most recent scheduled moment is newer
 * than their last recorded run. Workflows that have never run are baselined
 * against the moment the scheduler booted, so launching the app does not
 * immediately fire every schedule whose time already passed earlier today.
 */
export class WorkflowSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private startedAt = new Date();
  /** Guards against re-firing the same schedule slot when a run is slow to record. */
  private readonly lastFiredFor = new Map<string, number>();
  /** Root folder -> fs watcher. Multiple workflows can share a project root. */
  private readonly fileWatchers = new Map<string, FSWatcher>();
  /** Workflow id -> last accepted file-change run time. */
  private readonly lastFileChangeFor = new Map<string, number>();

  constructor(
    private readonly workflows: WorkflowService,
    private readonly webContentsProvider: () => WebContents | null,
  ) {}

  start(options: SchedulerOptions = {}): void {
    if (this.timer) return;
    this.startedAt = new Date();
    this.refreshFileWatchers();
    const intervalMs = Math.max(15_000, options.intervalMs ?? 60_000);
    this.timer = setInterval(() => {
      void this.runDueWorkflows();
      this.refreshFileWatchers();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const watcher of this.fileWatchers.values()) watcher.close();
    this.fileWatchers.clear();
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
          this.emitFailure(workflow, error, "Scheduled run");
        }
      }
    } finally {
      this.ticking = false;
    }

    return fired;
  }

  /** Runs every active file-change workflow whose project/detail matches `changedPath`. */
  async runFileChangeWorkflows(changedPath: string, now = new Date()): Promise<string[]> {
    const fired: string[] = [];
    const absoluteChanged = path.resolve(changedPath);

    for (const workflow of this.workflows.list()) {
      if (!this.matchesFileChange(workflow, absoluteChanged)) continue;

      const last = this.lastFileChangeFor.get(workflow.id) ?? 0;
      if (now.getTime() - last < FILE_CHANGE_DEBOUNCE_MS) continue;
      this.lastFileChangeFor.set(workflow.id, now.getTime());
      this.emitFileChangeTriggered(workflow, absoluteChanged);

      try {
        await this.workflows.run({ workflowId: workflow.id, triggeredBy: "file-change" });
        fired.push(workflow.id);
      } catch (error) {
        this.emitFailure(workflow, error, "File-change run");
      }
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

  private matchesFileChange(workflow: WorkflowDefinition, changedPath: string): boolean {
    if (workflow.status !== "active") return false;
    if (workflow.trigger.type !== "file-change") return false;
    if (!workflow.steps.some((step) => step.enabled)) return false;
    if (!workflow.projectPath) return false;

    const root = path.resolve(workflow.projectPath);
    const relative = path.relative(root, changedPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;

    const detail = workflow.trigger.detail?.trim();
    if (!detail) return true;

    return detail
      .split(",")
      .map((part) => normalizeFilter(part))
      .filter(Boolean)
      .some((filter) => fileChangeFilterMatches(filter, relative));
  }

  private refreshFileWatchers(): void {
    const desired = new Set(
      this.workflows
        .list()
        .filter((workflow) => workflow.status === "active" && workflow.trigger.type === "file-change" && workflow.projectPath)
        .map((workflow) => path.resolve(workflow.projectPath as string)),
    );

    for (const [root, watcher] of this.fileWatchers.entries()) {
      if (desired.has(root)) continue;
      watcher.close();
      this.fileWatchers.delete(root);
    }

    for (const root of desired) {
      if (this.fileWatchers.has(root)) continue;
      this.watchProjectRoot(root);
    }
  }

  private watchProjectRoot(root: string): void {
    if (!fs.existsSync(root)) return;

    const onChange = (_event: string, filename: string | Buffer | null) => {
      const changedPath = filename ? path.resolve(root, filename.toString()) : root;
      void this.runFileChangeWorkflows(changedPath);
    };

    try {
      this.fileWatchers.set(root, fs.watch(root, { recursive: process.platform !== "linux" }, onChange));
    } catch {
      try {
        this.fileWatchers.set(root, fs.watch(root, onChange));
      } catch (error) {
        this.emitDetached(`⚠ File-change watcher could not start for ${root}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private emitTriggered(workflow: WorkflowDefinition, dueAt: Date): void {
    this.emit(workflow, `⏰ Schedule "${workflow.trigger.schedule}" came due at ${dueAt.toLocaleString()}`);
  }

  private emitFileChangeTriggered(workflow: WorkflowDefinition, changedPath: string): void {
    const root = workflow.projectPath ? path.resolve(workflow.projectPath) : "";
    const relative = root ? path.relative(root, changedPath) || "." : changedPath;
    this.emit(workflow, `📁 File change matched ${relative}`);
  }

  private emitFailure(workflow: WorkflowDefinition, error: unknown, prefix: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.emit(workflow, `⚠ ${prefix} could not start: ${message}`);
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

  private emitDetached(message: string): void {
    this.webContentsProvider()?.send("workflow:event", {
      type: "workflow:log",
      workflowId: "",
      workflowRunId: "",
      message,
      timestamp: new Date().toISOString(),
    } satisfies WorkflowEvent);
  }
}

function normalizeFilter(filter: string): string {
  return filter.trim().replace(/^\.\//, "").replaceAll("\\", "/");
}

function fileChangeFilterMatches(filter: string, relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  if (filter.includes("*")) return globLikeMatch(filter, normalized);
  return normalized === filter || normalized.startsWith(`${filter}/`) || normalized.includes(filter);
}

function globLikeMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .split("**")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}
