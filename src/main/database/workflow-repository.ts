import { randomUUID } from "node:crypto";
import type {
  AgentCliId,
  WorkflowDefinition,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowSaveInput,
  WorkflowStatus,
  WorkflowStepDefinition,
  WorkflowStepKind,
  WorkflowStepRunRecord,
  WorkflowTrigger,
  WorkflowTriggerType,
} from "@contracts";
import { ensureColumns, type SqliteDatabase } from "./sqlite-types";
import { workflowSeeds } from "../workflows/workflow-seeds";

type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  favorite: number;
  owner: string | null;
  project_path: string | null;
  trigger_type: string | null;
  trigger_schedule: string | null;
  trigger_detail: string | null;
  integrations: string | null;
  baseline_runs: number | null;
  baseline_success_rate: number | null;
  baseline_avg_duration_ms: number | null;
  baseline_last_run_at: string | null;
  created_at: string;
  updated_at: string | null;
};

type StepRow = {
  id: string;
  workflow_id: string;
  step_order: number;
  name: string | null;
  kind: string | null;
  summary: string | null;
  agent_cli_id: string;
  profile_id: string | null;
  provider_connection_id: string | null;
  model: string | null;
  prompt_template: string;
  shell_command: string | null;
  timeout_seconds: number | null;
  requires_approval: number | null;
  continue_on_error: number | null;
  enabled: number | null;
};

type RunRow = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: string;
  triggered_by: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
};

type StepRunRow = {
  id: string;
  workflow_run_id: string;
  step_id: string;
  step_order: number;
  name: string;
  kind: string;
  cli_id: string;
  status: string;
  agent_run_id: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  output: string | null;
};

export class WorkflowRepository {
  constructor(private readonly db: SqliteDatabase) {}

  migrate(): void {
    this.db.exec(`
      create table if not exists workflows (
        id text primary key,
        name text not null,
        project_id text,
        created_at text not null default current_timestamp
      );

      create table if not exists workflow_steps (
        id text primary key,
        workflow_id text not null,
        agent_cli_id text not null,
        step_order integer not null,
        prompt_template text not null
      );

      create table if not exists workflow_runs (
        id text primary key,
        workflow_id text not null,
        workflow_name text not null,
        status text not null,
        triggered_by text not null,
        started_at text not null,
        ended_at text,
        duration_ms integer
      );

      create table if not exists workflow_step_runs (
        id text primary key,
        workflow_run_id text not null,
        step_id text not null,
        step_order integer not null,
        name text not null,
        kind text not null,
        cli_id text not null,
        status text not null,
        agent_run_id text,
        started_at text not null,
        ended_at text,
        duration_ms integer,
        exit_code integer,
        output text
      );

      create table if not exists workflow_metadata (
        key text primary key,
        value text not null,
        updated_at text not null default current_timestamp
      );

      create index if not exists idx_workflow_steps_workflow on workflow_steps (workflow_id, step_order);
      create index if not exists idx_workflow_runs_workflow on workflow_runs (workflow_id, started_at desc);
      create index if not exists idx_workflow_step_runs_run on workflow_step_runs (workflow_run_id, step_order);
    `);

    ensureColumns(this.db, "workflows", [
      { name: "description", ddl: "text not null default ''" },
      { name: "status", ddl: "text not null default 'draft'" },
      { name: "favorite", ddl: "integer not null default 0" },
      { name: "owner", ddl: "text not null default 'You'" },
      { name: "project_path", ddl: "text" },
      { name: "trigger_type", ddl: "text not null default 'manual'" },
      { name: "trigger_schedule", ddl: "text" },
      { name: "trigger_detail", ddl: "text" },
      { name: "integrations", ddl: "text not null default '[]'" },
      { name: "baseline_runs", ddl: "integer not null default 0" },
      { name: "baseline_success_rate", ddl: "real not null default 0" },
      { name: "baseline_avg_duration_ms", ddl: "integer not null default 0" },
      { name: "baseline_last_run_at", ddl: "text" },
      { name: "updated_at", ddl: "text" },
    ]);

    ensureColumns(this.db, "workflow_steps", [
      { name: "name", ddl: "text not null default 'Step'" },
      { name: "kind", ddl: "text not null default 'execute'" },
      { name: "summary", ddl: "text not null default ''" },
      { name: "model", ddl: "text not null default ''" },
      { name: "profile_id", ddl: "text" },
      { name: "provider_connection_id", ddl: "text" },
      { name: "shell_command", ddl: "text" },
      { name: "timeout_seconds", ddl: "integer not null default 600" },
      { name: "requires_approval", ddl: "integer not null default 0" },
      { name: "continue_on_error", ddl: "integer not null default 0" },
      { name: "enabled", ddl: "integer not null default 1" },
    ]);

    this.seed();
  }

  private seed(): void {
    const seeded = this.db.prepare("select value from workflow_metadata where key = 'seeds_initialized'").get() as
      | { value: string }
      | undefined;
    if (seeded) return;

    const existing = this.db.prepare("select count(*) as total from workflows").get() as { total: number };
    if (existing.total > 0) {
      this.db
        .prepare("insert into workflow_metadata (key, value, updated_at) values ('seeds_initialized', 'true', ?)")
        .run(new Date().toISOString());
      return;
    }

    for (const seed of workflowSeeds) {
      this.db
        .prepare(
          `insert into workflows (
             id, name, description, status, favorite, owner, project_path,
             trigger_type, trigger_schedule, trigger_detail, integrations,
             baseline_runs, baseline_success_rate, baseline_avg_duration_ms, baseline_last_run_at,
             created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          seed.id,
          seed.name,
          seed.description,
          seed.status,
          seed.favorite ? 1 : 0,
          seed.owner,
          seed.projectPath ?? null,
          seed.trigger.type,
          seed.trigger.schedule ?? null,
          seed.trigger.detail ?? null,
          JSON.stringify(seed.integrations),
          0,
          0,
          0,
          null,
          seed.createdAt,
          seed.updatedAt,
        );

      seed.steps.forEach((step, index) => {
        this.insertStep(seed.id, { ...step, order: index + 1 });
      });
    }

    this.db
      .prepare("insert into workflow_metadata (key, value, updated_at) values ('seeds_initialized', 'true', ?)")
      .run(new Date().toISOString());
  }

  private insertStep(workflowId: string, step: WorkflowStepDefinition): void {
    this.db
      .prepare(
        `insert into workflow_steps (
           id, workflow_id, step_order, name, kind, summary, agent_cli_id, profile_id,
           provider_connection_id, model, prompt_template, shell_command, timeout_seconds,
           requires_approval, continue_on_error, enabled
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        step.id,
        workflowId,
        step.order,
        step.name,
        step.kind,
        step.summary,
        step.cliId,
        step.profileId ?? null,
        step.providerConnectionId ?? null,
        step.model,
        step.instruction,
        step.shellCommand ?? null,
        step.timeoutSeconds,
        step.requiresApproval ? 1 : 0,
        step.continueOnError ? 1 : 0,
        step.enabled ? 1 : 0,
      );
  }

  list(): WorkflowDefinition[] {
    const rows = this.db
      .prepare("select * from workflows order by favorite desc, updated_at desc, created_at desc")
      .all() as WorkflowRow[];

    return rows.map((row) => this.hydrate(row));
  }

  get(workflowId: string): WorkflowDefinition | null {
    const row = this.db.prepare("select * from workflows where id = ?").get(workflowId) as WorkflowRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  save(input: WorkflowSaveInput): WorkflowDefinition {
    const timestamp = new Date().toISOString();
    const id = input.id ?? `wf-${randomUUID().slice(0, 8)}`;
    const existing = input.id ? this.get(input.id) : null;

    if (existing) {
      this.db
        .prepare(
          `update workflows set
             name = ?, description = ?, status = ?, favorite = ?, owner = ?, project_path = ?,
             trigger_type = ?, trigger_schedule = ?, trigger_detail = ?, integrations = ?, updated_at = ?
           where id = ?`,
        )
        .run(
          input.name,
          input.description,
          input.status,
          input.favorite ? 1 : 0,
          input.owner,
          input.projectPath ?? null,
          input.trigger.type,
          input.trigger.schedule ?? null,
          input.trigger.detail ?? null,
          JSON.stringify(input.integrations),
          timestamp,
          id,
        );
    } else {
      this.db
        .prepare(
          `insert into workflows (
             id, name, description, status, favorite, owner, project_path,
             trigger_type, trigger_schedule, trigger_detail, integrations,
             baseline_runs, baseline_success_rate, baseline_avg_duration_ms, baseline_last_run_at,
             created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, null, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.description,
          input.status,
          input.favorite ? 1 : 0,
          input.owner,
          input.projectPath ?? null,
          input.trigger.type,
          input.trigger.schedule ?? null,
          input.trigger.detail ?? null,
          JSON.stringify(input.integrations),
          timestamp,
          timestamp,
        );
    }

    this.db.prepare("delete from workflow_steps where workflow_id = ?").run(id);
    input.steps.forEach((step, index) => {
      this.insertStep(id, {
        ...step,
        id: step.id ?? `step-${randomUUID().slice(0, 8)}`,
        order: index + 1,
      });
    });

    const saved = this.get(id);
    if (!saved) throw new Error(`Workflow ${id} could not be saved.`);
    return saved;
  }

  /**
   * Deletes the workflow and everything that references it. Step runs are removed
   * via their parent run ids, otherwise they would linger and keep the deleted
   * workflow visible in the activity feed (which reads workflow_runs directly).
   */
  remove(workflowId: string): void {
    this.db
      .prepare(
        `delete from workflow_step_runs
         where workflow_run_id in (select id from workflow_runs where workflow_id = ?)`,
      )
      .run(workflowId);
    this.db.prepare("delete from workflow_runs where workflow_id = ?").run(workflowId);
    this.db.prepare("delete from workflow_steps where workflow_id = ?").run(workflowId);
    this.db.prepare("delete from workflows where id = ?").run(workflowId);
  }

  duplicate(workflowId: string): WorkflowDefinition {
    const source = this.get(workflowId);
    if (!source) throw new Error(`Workflow ${workflowId} was not found.`);

    return this.save({
      name: `${source.name} (copy)`,
      description: source.description,
      status: "draft",
      favorite: false,
      owner: source.owner,
      projectPath: source.projectPath ?? null,
      trigger: source.trigger,
      integrations: source.integrations,
      steps: source.steps.map((step) => ({ ...step, id: undefined })),
    });
  }

  setStatus(workflowId: string, status: WorkflowStatus): WorkflowDefinition {
    this.db
      .prepare("update workflows set status = ?, updated_at = ? where id = ?")
      .run(status, new Date().toISOString(), workflowId);
    const next = this.get(workflowId);
    if (!next) throw new Error(`Workflow ${workflowId} was not found.`);
    return next;
  }

  toggleFavorite(workflowId: string): WorkflowDefinition {
    const current = this.get(workflowId);
    if (!current) throw new Error(`Workflow ${workflowId} was not found.`);
    this.db
      .prepare("update workflows set favorite = ?, updated_at = ? where id = ?")
      .run(current.favorite ? 0 : 1, new Date().toISOString(), workflowId);
    return this.get(workflowId)!;
  }

  createRun(run: {
    id: string;
    workflowId: string;
    workflowName: string;
    status: WorkflowRunStatus;
    triggeredBy: WorkflowTriggerType;
    startedAt: string;
  }): void {
    this.db
      .prepare(
        `insert into workflow_runs (id, workflow_id, workflow_name, status, triggered_by, started_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.workflowId, run.workflowName, run.status, run.triggeredBy, run.startedAt);
  }

  finishRun(runId: string, status: WorkflowRunStatus, durationMs: number): void {
    this.db
      .prepare("update workflow_runs set status = ?, ended_at = ?, duration_ms = ? where id = ?")
      .run(status, new Date().toISOString(), durationMs, runId);
  }

  updateRunStatus(runId: string, status: WorkflowRunStatus): void {
    this.db.prepare("update workflow_runs set status = ? where id = ?").run(status, runId);
  }

  createStepRun(stepRun: WorkflowStepRunRecord): void {
    this.db
      .prepare(
        `insert into workflow_step_runs (
           id, workflow_run_id, step_id, step_order, name, kind, cli_id, status,
           agent_run_id, started_at, ended_at, duration_ms, exit_code, output
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stepRun.id,
        stepRun.workflowRunId,
        stepRun.stepId,
        stepRun.order,
        stepRun.name,
        stepRun.kind,
        stepRun.cliId,
        stepRun.status,
        stepRun.agentRunId ?? null,
        stepRun.startedAt,
        stepRun.endedAt ?? null,
        stepRun.durationMs ?? null,
        stepRun.exitCode ?? null,
        stepRun.output ?? null,
      );
  }

  finishStepRun(
    stepRunId: string,
    patch: {
      status: WorkflowRunStatus;
      agentRunId?: string | null;
      durationMs: number;
      exitCode?: number | null;
      output?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `update workflow_step_runs set
           status = ?, agent_run_id = coalesce(?, agent_run_id), ended_at = ?,
           duration_ms = ?, exit_code = ?, output = ?
         where id = ?`,
      )
      .run(
        patch.status,
        patch.agentRunId ?? null,
        new Date().toISOString(),
        patch.durationMs,
        patch.exitCode ?? null,
        patch.output ?? null,
        stepRunId,
      );
  }

  listRuns(workflowId?: string, limit = 20): WorkflowRunRecord[] {
    const runs = workflowId
      ? (this.db
          .prepare("select * from workflow_runs where workflow_id = ? order by started_at desc limit ?")
          .all(workflowId, limit) as RunRow[])
      : (this.db.prepare("select * from workflow_runs order by started_at desc limit ?").all(limit) as RunRow[]);

    return runs.map((run) => ({
      id: run.id,
      workflowId: run.workflow_id,
      workflowName: run.workflow_name,
      status: run.status as WorkflowRunStatus,
      triggeredBy: run.triggered_by as WorkflowTriggerType,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      durationMs: run.duration_ms,
      steps: this.listStepRuns(run.id),
    }));
  }

  getRun(runId: string): WorkflowRunRecord | null {
    const run = this.db.prepare("select * from workflow_runs where id = ?").get(runId) as RunRow | undefined;
    if (!run) return null;

    return {
      id: run.id,
      workflowId: run.workflow_id,
      workflowName: run.workflow_name,
      status: run.status as WorkflowRunStatus,
      triggeredBy: run.triggered_by as WorkflowTriggerType,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      durationMs: run.duration_ms,
      steps: this.listStepRuns(run.id),
    };
  }

  private listStepRuns(workflowRunId: string): WorkflowStepRunRecord[] {
    const rows = this.db
      .prepare("select * from workflow_step_runs where workflow_run_id = ? order by step_order asc")
      .all(workflowRunId) as StepRunRow[];

    return rows.map((row) => ({
      id: row.id,
      workflowRunId: row.workflow_run_id,
      stepId: row.step_id,
      order: row.step_order,
      name: row.name,
      kind: row.kind as WorkflowStepKind,
      cliId: row.cli_id as AgentCliId,
      status: row.status as WorkflowRunStatus,
      agentRunId: row.agent_run_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      exitCode: row.exit_code,
      output: row.output,
    }));
  }

  private hydrate(row: WorkflowRow): WorkflowDefinition {
    const stepRows = this.db
      .prepare("select * from workflow_steps where workflow_id = ? order by step_order asc")
      .all(row.id) as StepRow[];

    const steps: WorkflowStepDefinition[] = stepRows.map((step, index) => ({
      id: step.id,
      order: step.step_order ?? index + 1,
      name: step.name ?? "Step",
      kind: (step.kind ?? "execute") as WorkflowStepKind,
      summary: step.summary ?? "",
      cliId: step.agent_cli_id as AgentCliId,
      profileId: step.profile_id ?? undefined,
      providerConnectionId: step.provider_connection_id ?? undefined,
      model: step.model ?? "",
      instruction: step.prompt_template,
      shellCommand: step.shell_command ?? undefined,
      timeoutSeconds: step.timeout_seconds ?? 600,
      requiresApproval: Boolean(step.requires_approval),
      continueOnError: Boolean(step.continue_on_error),
      enabled: step.enabled === null ? true : Boolean(step.enabled),
    }));

    const trigger: WorkflowTrigger = {
      type: (row.trigger_type ?? "manual") as WorkflowTriggerType,
      schedule: row.trigger_schedule ?? undefined,
      detail: row.trigger_detail ?? undefined,
    };

    const liveStats = this.db
      .prepare(
        `select
           sum(case when status in ('success', 'failed', 'cancelled') then 1 else 0 end) as finishedRuns,
           sum(case when status = 'success' then 1 else 0 end) as successes,
           sum(case when duration_ms is not null then 1 else 0 end) as timedRuns,
           sum(coalesce(duration_ms, 0)) as totalDuration,
           max(started_at) as lastRunAt
         from workflow_runs where workflow_id = ?`,
      )
      .get(row.id) as {
      finishedRuns: number | null;
      successes: number | null;
      timedRuns: number | null;
      totalDuration: number | null;
      lastRunAt: string | null;
    };

    const lastRun = this.db
      .prepare("select status, started_at from workflow_runs where workflow_id = ? order by started_at desc limit 1")
      .get(row.id) as { status: string; started_at: string } | undefined;

    // In-flight runs (queued / running / waiting-approval) are excluded so they
    // are not counted as failures while they are still pending.
    const liveFinishedRuns = liveStats.finishedRuns ?? 0;
    const liveSuccesses = liveStats.successes ?? 0;
    const totalRuns = liveFinishedRuns;
    const successRate = totalRuns === 0 ? 0 : (liveSuccesses / totalRuns) * 100;

    const liveTimedRuns = liveStats.timedRuns ?? 0;
    const durationSamples = liveTimedRuns;
    const avgDurationMs =
      durationSamples === 0
        ? 0
        : Math.round((liveStats.totalDuration ?? 0) / durationSamples);

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      status: (row.status ?? "draft") as WorkflowStatus,
      favorite: Boolean(row.favorite),
      owner: row.owner ?? "You",
      projectPath: row.project_path,
      trigger,
      steps,
      integrations: parseJsonArray(row.integrations),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      stats: {
        runs: totalRuns,
        successRate: Number(successRate.toFixed(1)),
        avgDurationMs,
        lastRunAt: lastRun?.started_at ?? null,
        lastRunStatus: (lastRun?.status as WorkflowRunStatus | undefined) ?? null,
      },
    };
  }
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
