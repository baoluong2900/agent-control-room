import type { WebContents } from "electron";
import type { TaskPlanInput, TaskPlanResult, TaskRecord, TaskScheduleTickResult } from "@contracts";
import { quoteCommand } from "../agents/commands";
import type { DesktopDatabase } from "../database/desktop-database";
import type { AgentProcessManager } from "../processes/agent-process-manager";
import {
  buildScheduledTaskPrompt,
  buildShellScheduledTaskOutput,
  buildTaskPlan,
  defaultModelForCli,
} from "./task-planner";

type TaskAutomationOptions = {
  intervalMs?: number;
};

export class TaskAutomationService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly db: DesktopDatabase,
    private readonly agentProcessManager: AgentProcessManager,
    private readonly webContentsProvider: () => WebContents | null,
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

  planTask(input: TaskPlanInput): TaskPlanResult {
    const draft = buildTaskPlan(input);
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
      summary: draft.summary,
    };
  }

  async runDueTasks(): Promise<TaskScheduleTickResult> {
    if (this.ticking) {
      return { started: [], failed: [] };
    }

    this.ticking = true;
    const started: TaskRecord[] = [];
    const failed: TaskScheduleTickResult["failed"] = [];

    try {
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
            type: "task:log",
            taskId: task.id,
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
            type: "task:log",
            taskId: task.id,
            message: `▶ ${task.title} queued on ${cliId} (${agentProcess.runId.slice(0, 8)})`,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failed.push({ taskId: task.id, title: task.title, message });
          this.emit({
            type: "task:log",
            taskId: task.id,
            message: `⚠ ${task.title}: ${message}`,
          });
        }
      }
    } finally {
      this.ticking = false;
    }

    return { started, failed };
  }

  private emit(event: { type: string; taskId: string; message: string }): void {
    this.webContentsProvider()?.send("task:event", {
      ...event,
      timestamp: new Date().toISOString(),
      runId: event.taskId,
    });
  }
}
