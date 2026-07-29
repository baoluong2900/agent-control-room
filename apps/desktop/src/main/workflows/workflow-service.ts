import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { dialog, type WebContents } from "electron";
import type {
  WorkflowActivityEntry,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowExportResult,
  WorkflowMetrics,
  WorkflowRunOptions,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowSaveInput,
  WorkflowStatus,
  WorkflowStepDefinition,
  WorkflowStepRunRecord,
} from "@contracts";
import { buildInvocation, cliDisplayNames, quoteCommand, shellInvocation } from "../agents/commands";
import type { DesktopDatabase } from "../database/desktop-database";
import type { WorkflowRepository } from "../database/workflow-repository";

type RunningWorkflow = {
  cancelled: boolean;
  child?: ChildProcess;
};

export class WorkflowService {
  private readonly repo: WorkflowRepository;
  private readonly active = new Map<string, RunningWorkflow>();

  constructor(
    private readonly db: DesktopDatabase,
    private readonly webContentsProvider: () => WebContents | null,
  ) {
    this.repo = db.workflows;
  }

  list(): WorkflowDefinition[] {
    return this.repo.list();
  }

  get(workflowId: string): WorkflowDefinition | null {
    return this.repo.get(workflowId);
  }

  save(input: WorkflowSaveInput): WorkflowDefinition {
    return this.repo.save(input);
  }

  remove(workflowId: string): void {
    this.repo.remove(workflowId);
  }

  duplicate(workflowId: string): WorkflowDefinition {
    return this.repo.duplicate(workflowId);
  }

  setStatus(workflowId: string, status: WorkflowStatus): WorkflowDefinition {
    return this.repo.setStatus(workflowId, status);
  }

  toggleFavorite(workflowId: string): WorkflowDefinition {
    return this.repo.toggleFavorite(workflowId);
  }

  runs(workflowId: string, limit = 20): WorkflowRunRecord[] {
    return this.repo.listRuns(workflowId, limit);
  }

  /** Aggregate metrics for the four stat cards at the top of the page. */
  metrics(): WorkflowMetrics {
    const workflows = this.repo.list();
    const totalWorkflows = workflows.length;
    const activeWorkflows = workflows.filter((wf) => wf.status === "active").length;
    const automatedRuns = workflows.reduce((sum, wf) => sum + wf.stats.runs, 0);
    const rated = workflows.filter((wf) => wf.stats.runs > 0);
    const successRate =
      rated.length === 0
        ? 0
        : Number((rated.reduce((sum, wf) => sum + wf.stats.successRate, 0) / rated.length).toFixed(1));

    return {
      totalWorkflows,
      activeWorkflows,
      automatedRuns,
      successRate,
    };
  }

  /** Recent workflow activity feed (bottom-left card in the reference). */
  activity(limit = 8): WorkflowActivityEntry[] {
    const runs = this.repo.listRuns(undefined, limit * 2);
    const entries: WorkflowActivityEntry[] = runs.slice(0, limit).map((run) => {
      const kind = activityKindFor(run.status);
      return {
        id: run.id,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        kind,
        headline: headlineFor(run),
        detail: detailFor(run),
        at: run.endedAt ?? run.startedAt,
      };
    });

    if (entries.length > 0) return entries;
    return [];
  }

  async cancel(workflowRunId: string): Promise<void> {
    const running = this.active.get(workflowRunId);
    if (!running) return;
    running.cancelled = true;
    running.child?.kill(process.platform === "win32" ? undefined : "SIGTERM");
    this.repo.updateRunStatus(workflowRunId, "cancelled");
  }

  async exportDefinition(workflowId: string): Promise<WorkflowExportResult | null> {
    const workflow = this.repo.get(workflowId);
    if (!workflow) return null;

    const result = await dialog.showSaveDialog({
      title: "Export workflow",
      defaultPath: `${slugify(workflow.name)}.workflow.json`,
      filters: [{ name: "Workflow", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;

    const payload = serializeWorkflow(workflow);
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), "utf8");
    return { filePath: result.filePath, workflowId };
  }

  async importDefinition(): Promise<WorkflowDefinition | null> {
    const result = await dialog.showOpenDialog({
      title: "Import workflow",
      properties: ["openFile"],
      filters: [{ name: "Workflow", extensions: ["json"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const raw = fs.readFileSync(result.filePaths[0], "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkflowSaveInput> & { name?: string };
    if (!parsed || typeof parsed.name !== "string") {
      throw new Error("The selected file is not a valid workflow definition.");
    }

    return this.repo.save(normalizeImport(parsed));
  }

  /**
   * Runs a workflow's steps sequentially. Each enabled step spawns its CLI/shell
   * process and the service awaits completion, streaming output as workflow events.
   * dryRun is the only simulated path; missing CLIs are recorded as failures.
   */
  async run(options: WorkflowRunOptions): Promise<WorkflowRunRecord> {
    const workflow = this.repo.get(options.workflowId);
    if (!workflow) throw new Error(`Workflow ${options.workflowId} was not found.`);

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const triggeredBy = options.triggeredBy ?? workflow.trigger.type;
    const cwd = (options.cwd ?? workflow.projectPath ?? process.cwd()).trim() || process.cwd();

    const steps = workflow.steps
      .filter((step) => step.enabled)
      .filter((step) => (options.stepId ? step.id === options.stepId : true));

    this.repo.createRun({
      id: runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: "running",
      triggeredBy,
      startedAt,
    });
    this.active.set(runId, { cancelled: false });

    this.emit({
      type: "workflow:run-started",
      workflowId: workflow.id,
      workflowRunId: runId,
      status: "running",
      message: `Running "${workflow.name}" (${steps.length} step${steps.length === 1 ? "" : "s"}) in ${cwd}`,
      timestamp: startedAt,
    });

    const runStart = Date.now();
    let finalStatus: WorkflowRunStatus = "success";

    for (const step of steps) {
      const running = this.active.get(runId);
      if (running?.cancelled) {
        finalStatus = "cancelled";
        break;
      }

      const stepStatus = await this.runStep({ workflow, step, runId, cwd, dryRun: options.dryRun });
      if (stepStatus === "waiting-approval") {
        finalStatus = "waiting-approval";
        break;
      }
      if (stepStatus === "failed" && !step.continueOnError) {
        finalStatus = "failed";
        break;
      }
    }

    const durationMs = Date.now() - runStart;
    this.repo.finishRun(runId, finalStatus, durationMs);
    this.active.delete(runId);

    this.emit({
      type: "workflow:run-finished",
      workflowId: workflow.id,
      workflowRunId: runId,
      status: finalStatus,
      message: `Workflow "${workflow.name}" ${finalStatus} in ${(durationMs / 1000).toFixed(1)}s`,
      timestamp: new Date().toISOString(),
    });

    return this.repo.getRun(runId)!;
  }

  private async runStep(params: {
    workflow: WorkflowDefinition;
    step: WorkflowStepDefinition;
    runId: string;
    cwd: string;
    dryRun?: boolean;
  }): Promise<WorkflowRunStatus> {
    const { workflow, step, runId, cwd, dryRun } = params;
    const stepRunId = randomUUID();
    const startedAt = new Date().toISOString();

    const stepRun: WorkflowStepRunRecord = {
      id: stepRunId,
      workflowRunId: runId,
      stepId: step.id,
      order: step.order,
      name: step.name,
      kind: step.kind,
      cliId: step.cliId,
      status: "running",
      startedAt,
    };
    this.repo.createStepRun(stepRun);

    const displayName = cliDisplayNames[step.cliId] ?? step.cliId;
    this.emit({
      type: "workflow:step-started",
      workflowId: workflow.id,
      workflowRunId: runId,
      stepId: step.id,
      stepName: step.name,
      status: "running",
      message: `▶ ${step.name} · ${displayName}${step.model ? ` (${step.model})` : ""}`,
      timestamp: startedAt,
    });

    if (step.requiresApproval || step.kind === "approval") {
      this.emit({
        type: "workflow:step-started",
        workflowId: workflow.id,
        workflowRunId: runId,
        stepId: step.id,
        stepName: step.name,
        status: "waiting-approval",
        message: `⏸ ${step.name} requires manual approval`,
        timestamp: new Date().toISOString(),
      });
    }

    const stepStart = Date.now();
    let status: WorkflowRunStatus = "success";
    let exitCode: number | null = 0;
    let output = "";

    if (dryRun) {
      output = `[dry-run] ${step.instruction}`;
      await delay(180);
    } else if (step.requiresApproval || step.kind === "approval") {
      status = "waiting-approval";
      exitCode = null;
      output = "Waiting for manual approval.";
    } else {
      const result = await this.spawnStep({ step, cwd, runId, workflowId: workflow.id });
      status = result.status;
      exitCode = result.exitCode;
      output = result.output;
    }

    const durationMs = Date.now() - stepStart;
    this.repo.finishStepRun(stepRunId, { status, durationMs, exitCode, output: output.slice(-4000) });

    this.emit({
      type: "workflow:step-finished",
      workflowId: workflow.id,
      workflowRunId: runId,
      stepId: step.id,
      stepName: step.name,
      status,
      message: `${status === "success" ? "✔" : "✖"} ${step.name} (${(durationMs / 1000).toFixed(1)}s)`,
      timestamp: new Date().toISOString(),
    });

    return status;
  }

  private spawnStep(params: {
    step: WorkflowStepDefinition;
    cwd: string;
    runId: string;
    workflowId: string;
  }): Promise<{ status: WorkflowRunStatus; exitCode: number | null; output: string }> {
    const { step, cwd, runId, workflowId } = params;

    return new Promise((resolve) => {
      void (async () => {
        let invocation: { executable: string; args: string[]; stdinPrompt?: string };
        try {
          if (step.cliId === "shell") {
            invocation = shellInvocation(step.shellCommand?.trim() || step.instruction);
          } else {
            invocation = await buildInvocation({
              cliId: step.cliId,
              cwd,
              prompt: step.instruction,
              model: step.model,
              shellCommand: step.shellCommand,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.emit({
            type: "workflow:log",
            workflowId,
            workflowRunId: runId,
            stepId: step.id,
            message: `⚠ ${message}`,
            timestamp: new Date().toISOString(),
          });
          resolve({ status: "failed", exitCode: null, output: message });
          return;
        }

        this.emit({
          type: "workflow:log",
          workflowId,
          workflowRunId: runId,
          stepId: step.id,
          message: `$ ${quoteCommand([invocation.executable, ...invocation.args])}`,
          timestamp: new Date().toISOString(),
        });

        const child = spawn(invocation.executable, invocation.args, {
          cwd,
          env: { ...process.env, FORCE_COLOR: "1" },
          windowsHide: true,
        });

        const running = this.active.get(runId);
        if (running) running.child = child;

        let output = "";
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          child.kill(process.platform === "win32" ? undefined : "SIGTERM");
          this.emit({
            type: "workflow:log",
            workflowId,
            workflowRunId: runId,
            stepId: step.id,
            message: `⏱ ${step.name} timed out after ${step.timeoutSeconds}s`,
            timestamp: new Date().toISOString(),
          });
        }, Math.max(1, step.timeoutSeconds) * 1000);

        if (invocation.stdinPrompt && child.stdin) {
          child.stdin.write(`${invocation.stdinPrompt}\n`);
          child.stdin.end();
        }

        const onChunk = (chunk: Buffer) => {
          const text = chunk.toString();
          output += text;
          this.emit({
            type: "workflow:log",
            workflowId,
            workflowRunId: runId,
            stepId: step.id,
            message: text.replace(/\s+$/, ""),
            timestamp: new Date().toISOString(),
          });
        };

        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);

        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: "failed", exitCode: null, output: `${output}\n${error.message}` });
        });

        child.on("exit", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const cancelled = this.active.get(runId)?.cancelled;
          resolve({
            status: cancelled ? "cancelled" : code === 0 ? "success" : "failed",
            exitCode: code,
            output,
          });
        });
      })();
    });
  }

  private emit(event: WorkflowEvent): void {
    this.webContentsProvider()?.send("workflow:event", event);
  }
}

function activityKindFor(status: WorkflowRunStatus): WorkflowActivityEntry["kind"] {
  switch (status) {
    case "success":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "paused";
    case "running":
    case "queued":
      return "triggered";
    default:
      return "processed";
  }
}

function headlineFor(run: WorkflowRunRecord): string {
  switch (run.status) {
    case "success":
      return "completed successfully";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
      return "is running";
    default:
      return `triggered (${run.triggeredBy})`;
  }
}

function detailFor(run: WorkflowRunRecord): string {
  const done = run.steps.filter((step) => step.status === "success").length;
  const duration = run.durationMs ? ` • ${(run.durationMs / 1000).toFixed(1)}s` : "";
  return `${done}/${run.steps.length} steps${duration}`;
}

function serializeWorkflow(workflow: WorkflowDefinition): WorkflowSaveInput {
  return {
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    favorite: workflow.favorite,
    owner: workflow.owner,
    projectPath: workflow.projectPath ?? null,
    trigger: workflow.trigger,
    integrations: workflow.integrations,
    steps: workflow.steps.map((step) => ({
      name: step.name,
      kind: step.kind,
      summary: step.summary,
      cliId: step.cliId,
      model: step.model,
      instruction: step.instruction,
      shellCommand: step.shellCommand,
      timeoutSeconds: step.timeoutSeconds,
      requiresApproval: step.requiresApproval,
      continueOnError: step.continueOnError,
      enabled: step.enabled,
    })),
  };
}

function normalizeImport(parsed: Partial<WorkflowSaveInput> & { name?: string }): WorkflowSaveInput {
  return {
    name: `${parsed.name} (imported)`,
    description: parsed.description ?? "",
    status: "draft",
    favorite: false,
    owner: parsed.owner ?? "You",
    projectPath: parsed.projectPath ?? null,
    trigger: parsed.trigger ?? { type: "manual" },
    integrations: parsed.integrations ?? [],
    steps: (parsed.steps ?? []).map((step) => ({
      name: step.name ?? "Step",
      kind: step.kind ?? "execute",
      summary: step.summary ?? "",
      cliId: step.cliId ?? "claude",
      model: step.model ?? "",
      instruction: step.instruction ?? "",
      shellCommand: step.shellCommand,
      timeoutSeconds: step.timeoutSeconds ?? 600,
      requiresApproval: step.requiresApproval ?? false,
      continueOnError: step.continueOnError ?? false,
      enabled: step.enabled ?? true,
    })),
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workflow";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
