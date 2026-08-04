import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { WebContents } from "electron";
import type {
  AgentProfile,
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
  WorkflowStepOutcome,
  WorkflowStepRunRecord,
} from "@contracts";
import { buildInvocation, cliDisplayNames, quoteCommand, shellInvocation } from "../agents/commands";
import { resolveProviderEnv } from "../agents/provider-resolver";
import type { DesktopDatabase } from "../database/desktop-database";
import type { WorkflowRepository } from "../database/workflow-repository";
import type { ProviderSecretVault } from "../settings/provider-secret-vault";
import { applyStepContext } from "./step-context";

type RunningWorkflow = {
  cancelled: boolean;
  child?: ChildProcess;
};

/**
 * A run parked on an approval gate. Everything needed to resume the remaining
 * steps is captured here so `approve` can pick the run back up where it stopped.
 */
type PendingApproval = {
  workflowId: string;
  runId: string;
  cwd: string;
  dryRun?: boolean;
  /** When the whole run started, so total duration stays correct across the pause. */
  runStart: number;
  /** When the gate opened, used for the gate step's own duration. */
  gateStart: number;
  /** Step run row that recorded the gate, closed out when the user decides. */
  gateStepRunId: string;
  /** The gated step plus everything after it, in execution order. */
  remaining: WorkflowStepDefinition[];
  /** Set when the gated step still has to run after being approved. */
  approvedStepId?: string;
  /** Outputs collected before the gate, so context survives the pause. */
  outcomes: WorkflowStepOutcome[];
};

export class WorkflowService {
  private readonly repo: WorkflowRepository;
  private readonly active = new Map<string, RunningWorkflow>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(
    private readonly db: DesktopDatabase,
    private readonly webContentsProvider: () => WebContents | null,
    private readonly secretVault?: ProviderSecretVault,
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
    // A run parked on an approval gate has no live child process, so cancelling
    // it is the same as rejecting the gate.
    if (this.pendingApprovals.has(workflowRunId)) {
      await this.reject(workflowRunId, "cancelled by user");
      return;
    }

    const running = this.active.get(workflowRunId);
    if (!running) return;
    running.cancelled = true;
    running.child?.kill(process.platform === "win32" ? undefined : "SIGTERM");
    this.repo.updateRunStatus(workflowRunId, "cancelled");
  }

  async exportDefinition(workflowId: string): Promise<WorkflowExportResult | null> {
    const workflow = this.repo.get(workflowId);
    if (!workflow) return null;

    const { dialog } = await import("electron");
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
    const { dialog } = await import("electron");
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
   * A step that needs sign-off parks the run until `approve` or `reject` is called.
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
      status: "queued",
      triggeredBy,
      startedAt,
    });
    this.active.set(runId, { cancelled: false });

    this.emit({
      type: "workflow:run-queued",
      workflowId: workflow.id,
      workflowRunId: runId,
      status: "queued",
      message: `Queued "${workflow.name}" (${steps.length} step${steps.length === 1 ? "" : "s"})`,
      timestamp: startedAt,
    });

    this.repo.updateRunStatus(runId, "running");
    this.emit({
      type: "workflow:run-started",
      workflowId: workflow.id,
      workflowRunId: runId,
      status: "running",
      message: `Running "${workflow.name}" (${steps.length} step${steps.length === 1 ? "" : "s"}) in ${cwd}`,
      timestamp: new Date().toISOString(),
    });

    return this.executeSteps({ workflow, runId, steps, cwd, dryRun: options.dryRun, runStart: Date.now() });
  }

  /** True while a run sits on an approval gate and can be approved or rejected. */
  isWaitingForApproval(workflowRunId: string): boolean {
    return this.pendingApprovals.has(workflowRunId);
  }

  /** Closes the open gate as approved and resumes the remaining steps. */
  async approve(workflowRunId: string): Promise<WorkflowRunRecord> {
    const pending = this.takePendingApproval(workflowRunId);
    const workflow = this.repo.get(pending.workflowId);
    if (!workflow) throw new Error(`Workflow ${pending.workflowId} was not found.`);

    const gatedStep = pending.remaining[0];
    this.settleGate(pending, workflow, "success", "Approved by user.");

    // An `approval` step is the gate itself, so it is done once approved. Any
    // other step was merely held back and still has to execute.
    const remaining = pending.approvedStepId ? pending.remaining : pending.remaining.slice(1);

    this.active.set(workflowRunId, { cancelled: false });
    this.repo.updateRunStatus(workflowRunId, "running");
    this.emit({
      type: "workflow:run-started",
      workflowId: workflow.id,
      workflowRunId,
      status: "running",
      message: `▶ Approved "${gatedStep?.name ?? "gate"}" — resuming ${remaining.length} step${remaining.length === 1 ? "" : "s"}`,
      timestamp: new Date().toISOString(),
    });

    return this.executeSteps({
      workflow,
      runId: workflowRunId,
      steps: remaining,
      cwd: pending.cwd,
      dryRun: pending.dryRun,
      runStart: pending.runStart,
      skipGateStepId: pending.approvedStepId,
      outcomes: pending.outcomes,
    });
  }

  /** Closes the open gate as rejected and ends the run without further steps. */
  async reject(workflowRunId: string, reason?: string): Promise<WorkflowRunRecord> {
    const pending = this.takePendingApproval(workflowRunId);
    const workflow = this.repo.get(pending.workflowId);
    if (!workflow) throw new Error(`Workflow ${pending.workflowId} was not found.`);

    const detail = reason?.trim() ? `Rejected by user: ${reason.trim()}` : "Rejected by user.";
    this.settleGate(pending, workflow, "cancelled", detail);

    return this.finishRun({
      workflow,
      runId: workflowRunId,
      status: "cancelled",
      runStart: pending.runStart,
      message: `Workflow "${workflow.name}" stopped at approval — ${detail}`,
    });
  }

  private takePendingApproval(workflowRunId: string): PendingApproval {
    const pending = this.pendingApprovals.get(workflowRunId);
    if (!pending) {
      throw new Error(`Workflow run ${workflowRunId} is not waiting for approval.`);
    }
    this.pendingApprovals.delete(workflowRunId);
    return pending;
  }

  /** Records the outcome of an approval gate on its step run row and the log. */
  private settleGate(
    pending: PendingApproval,
    workflow: WorkflowDefinition,
    status: WorkflowRunStatus,
    detail: string,
  ): void {
    const gatedStep = pending.remaining[0];
    this.repo.finishStepRun(pending.gateStepRunId, {
      status,
      durationMs: Date.now() - pending.gateStart,
      exitCode: status === "success" ? 0 : null,
      output: detail,
    });
    this.emit({
      type: "workflow:step-finished",
      workflowId: workflow.id,
      workflowRunId: pending.runId,
      stepId: gatedStep?.id,
      stepName: gatedStep?.name,
      status,
      message: `${status === "success" ? "✔" : "✖"} ${gatedStep?.name ?? "Approval"} — ${detail}`,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Walks the given steps in order. Returns as soon as the run reaches a terminal
   * status, or parks it on the first approval gate that has not been decided yet.
   */
  private async executeSteps(params: {
    workflow: WorkflowDefinition;
    runId: string;
    steps: WorkflowStepDefinition[];
    cwd: string;
    dryRun?: boolean;
    runStart: number;
    skipGateStepId?: string;
    outcomes?: WorkflowStepOutcome[];
  }): Promise<WorkflowRunRecord> {
    const { workflow, runId, steps, cwd, dryRun, runStart, skipGateStepId } = params;
    const outcomes: WorkflowStepOutcome[] = [...(params.outcomes ?? [])];
    let finalStatus: WorkflowRunStatus = "success";

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (this.active.get(runId)?.cancelled) {
        finalStatus = "cancelled";
        break;
      }

      const needsApproval = !dryRun && (step.requiresApproval || step.kind === "approval");
      if (needsApproval && step.id !== skipGateStepId) {
        this.parkForApproval({
          workflow,
          runId,
          step,
          remaining: steps.slice(index),
          cwd,
          dryRun,
          runStart,
          outcomes,
        });
        return this.repo.getRun(runId)!;
      }

      // `approval` steps carry no command, so an approved gate has nothing to run.
      if (step.kind === "approval") continue;

      const result = await this.runStep({ workflow, step, runId, cwd, dryRun, outcomes });
      outcomes.push({
        stepId: step.id,
        name: step.name,
        kind: step.kind,
        status: result.status,
        output: result.output,
      });

      if (result.status === "failed" && !step.continueOnError) {
        finalStatus = "failed";
        break;
      }
      if (result.status === "cancelled") {
        finalStatus = "cancelled";
        break;
      }
    }

    const durationMs = Date.now() - runStart;
    return this.finishRun({
      workflow,
      runId,
      status: finalStatus,
      runStart,
      message: `Workflow "${workflow.name}" ${finalStatus} in ${(durationMs / 1000).toFixed(1)}s`,
    });
  }

  /** Suspends the run on a gate and remembers what is left so it can resume. */
  private parkForApproval(params: {
    workflow: WorkflowDefinition;
    runId: string;
    step: WorkflowStepDefinition;
    remaining: WorkflowStepDefinition[];
    cwd: string;
    dryRun?: boolean;
    runStart: number;
    outcomes: WorkflowStepOutcome[];
  }): void {
    const { workflow, runId, step, remaining, cwd, dryRun, runStart, outcomes } = params;
    const gateStepRunId = randomUUID();
    const startedAt = new Date().toISOString();

    this.repo.createStepRun({
      id: gateStepRunId,
      workflowRunId: runId,
      stepId: step.id,
      order: step.order,
      name: step.name,
      kind: step.kind,
      cliId: step.cliId,
      status: "waiting-approval",
      startedAt,
    });

    this.pendingApprovals.set(runId, {
      workflowId: workflow.id,
      runId,
      cwd,
      dryRun,
      runStart,
      gateStart: Date.now(),
      gateStepRunId,
      remaining,
      approvedStepId: step.kind === "approval" ? undefined : step.id,
      outcomes,
    });

    this.active.delete(runId);
    this.repo.updateRunStatus(runId, "waiting-approval");

    this.emit({
      type: "workflow:step-started",
      workflowId: workflow.id,
      workflowRunId: runId,
      stepId: step.id,
      stepName: step.name,
      status: "waiting-approval",
      message: `⏸ ${step.name} needs approval before the run continues`,
      timestamp: startedAt,
    });
    this.emit({
      type: "workflow:run-finished",
      workflowId: workflow.id,
      workflowRunId: runId,
      status: "waiting-approval",
      message: `Workflow "${workflow.name}" is waiting for approval on ${step.name}`,
      timestamp: new Date().toISOString(),
    });
  }

  private finishRun(params: {
    workflow: WorkflowDefinition;
    runId: string;
    status: WorkflowRunStatus;
    runStart: number;
    message: string;
  }): WorkflowRunRecord {
    const { workflow, runId, status, runStart, message } = params;
    this.repo.finishRun(runId, status, Date.now() - runStart);
    this.active.delete(runId);

    this.emit({
      type: "workflow:run-finished",
      workflowId: workflow.id,
      workflowRunId: runId,
      status,
      message,
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
    outcomes: WorkflowStepOutcome[];
  }): Promise<{ status: WorkflowRunStatus; output: string }> {
    const { workflow, step, runId, cwd, dryRun, outcomes } = params;
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

    const profile = this.resolveStepProfile(step);
    const effectiveCliId = profile?.cliId ?? step.cliId;
    const displayName = cliDisplayNames[effectiveCliId] ?? effectiveCliId;
    const effectiveModel = step.model.trim() || profile?.model?.trim() || "";
    const runAs = profile ? ` as ${profile.name}` : "";
    this.emit({
      type: "workflow:step-started",
      workflowId: workflow.id,
      workflowRunId: runId,
      stepId: step.id,
      stepName: step.name,
      status: "running",
      message: `▶ ${step.name} · ${displayName}${effectiveModel ? ` (${effectiveModel})` : ""}${runAs}`,
      timestamp: startedAt,
    });

    // Approval gates are handled by executeSteps before a step reaches here, so
    // anything running now has been cleared to execute.
    const stepStart = Date.now();
    let status: WorkflowRunStatus = "success";
    let exitCode: number | null = 0;
    let output = "";
    const instruction = applyStepContext(step.instruction, outcomes);

    if (dryRun) {
      output = `[dry-run] ${instruction}`;
      await delay(180);
    } else {
      const result = await this.spawnStep({
        step,
        profile,
        instruction,
        cwd,
        runId,
        workflowId: workflow.id,
      });
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

    return { status, output };
  }

  /**
   * The agent profile a step runs as, when it names one that still exists and is
   * enabled. A step pointing at a deleted or disabled profile falls back to its
   * own `cliId` rather than failing the run.
   */
  private resolveStepProfile(step: WorkflowStepDefinition): AgentProfile | undefined {
    if (!step.profileId) return undefined;
    const profile = this.db.listAgentProfiles().find((entry) => entry.id === step.profileId);
    return profile?.enabled ? profile : undefined;
  }

  private spawnStep(params: {
    step: WorkflowStepDefinition;
    profile?: AgentProfile;
    instruction: string;
    cwd: string;
    runId: string;
    workflowId: string;
  }): Promise<{ status: WorkflowRunStatus; exitCode: number | null; output: string }> {
    const { step, profile, instruction, cwd, runId, workflowId } = params;
    const cliId = profile?.cliId ?? step.cliId;

    return new Promise((resolve) => {
      void (async () => {
        let invocation: { executable: string; args: string[]; stdinPrompt?: string };
        let providerEnv: NodeJS.ProcessEnv = {};
        try {
          if (cliId === "shell") {
            invocation = shellInvocation(step.shellCommand?.trim() || instruction);
          } else {
            invocation = await buildInvocation({
              cliId,
              cwd,
              prompt: instruction,
              // An explicit step model wins; otherwise the profile's model applies.
              model: step.model.trim() || profile?.model,
              shellCommand: step.shellCommand,
              profileId: profile?.id,
              providerConnectionId: step.providerConnectionId ?? profile?.providerConnectionId,
              systemPrompt: profile?.systemPrompt,
              extraArgs: profile?.extraArgs,
              commandOverride: profile?.commandOverride,
              promptMode: profile?.promptMode,
              autoApprove: profile?.autoApprove,
              options: profile?.options,
            });

            // Workflow steps are one-shot and headless, so they never force a TTY —
            // but they do need the same credentials an interactive agent run gets.
            // A `shell` step runs no provider CLI, so it is skipped entirely.
            providerEnv = resolveProviderEnv(this.db, this.secretVault, {
              cliId,
              profileId: profile?.id,
              providerConnectionId: step.providerConnectionId ?? profile?.providerConnectionId,
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
          env: { ...process.env, ...providerEnv, FORCE_COLOR: "1" },
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
      profileId: step.profileId,
      providerConnectionId: step.providerConnectionId,
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
      profileId: step.profileId,
      providerConnectionId: step.providerConnectionId,
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
