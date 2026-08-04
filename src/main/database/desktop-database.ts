import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppIdentity,
  AppIdentityInput,
  AgentProfile,
  AgentProfileInput,
  AgentModuleId,
  AgentOptionValues,
  AgentProfileStats,
  AgentPromptMode,
  KnowledgeCodeGraph,
  KnowledgeCategoryStat,
  KnowledgeFileInsight,
  KnowledgeLanguageStat,
  KnowledgeSnapshot,
  AgentRunRecord,
  AgentStatus,
  ProjectSummary,
  ProviderConnection,
  ProviderConnectionInput,
  TaskDifficulty,
  TaskRecord,
  TaskSaveInput,
  TaskStatus,
} from "@contracts";
import { logRetention, truncateLogMessage } from "./log-retention";
import { appMigrations, runMigrations, schemaVersion, type AppliedMigration } from "./migrations";
import { ensureColumns } from "./sqlite-types";
import type { SqliteDatabase } from "./sqlite-types";
import { WorkflowRepository } from "./workflow-repository";

type ProfileRow = {
  id: string;
  name: string;
  role: string;
  cliId: string;
  module: string | null;
  model: string;
  providerConnectionId: string | null;
  accent: string | null;
  cwd: string | null;
  systemPrompt: string | null;
  extraArgs: string | null;
  commandOverride: string | null;
  promptMode: string | null;
  interactive: number;
  forceTty: number;
  autoApprove: number;
  enabled: number;
  tags: string | null;
  options: string | null;
  createdAt: string;
  updatedAt: string;
};

type IdentityRow = {
  id: string;
  email: string;
  displayName: string;
  loginMethod: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type ProviderConnectionRow = {
  id: string;
  userId: string;
  provider: string;
  authMode: string;
  storageMode: string;
  accountLabel: string | null;
  status: string;
  tokenReference: string | null;
  baseUrl: string | null;
  quotaLabel: string | null;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
  lastVerifiedAt: string | null;
  verificationDetail: string | null;
};

type StatsRow = {
  profileId: string;
  runs: number;
  completed: number;
  failed: number;
  running: number;
  totalMs: number | null;
  lastRunAt: string | null;
  lastStatus: string | null;
};

type TaskRow = {
  id: string;
  project_id: string | null;
  parent_task_id: string | null;
  title: string;
  prompt: string;
  status: string;
  assigned_cli_id: string | null;
  assigned_model: string | null;
  due_at: string | null;
  difficulty: string | null;
  estimated_minutes: number | null;
  automation_enabled: number | null;
  last_run_at: string | null;
  last_run_id: string | null;
  run_count: number | null;
  created_at: string;
  completed_at: string | null;
};

type KnowledgeSnapshotRow = {
  projectPath: string;
  projectName: string;
  generatedAt: string;
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  totalBytes: number;
  totalLines: number;
  languagesJson: string;
  categoriesJson: string;
  filesJson: string;
  graphJson: string;
  agentBrief: string;
};

export type TerminalLogRow = {
  stream: string;
  message: string;
  createdAt: string;
};

const emptyStats: AgentProfileStats = {
  runs: 0,
  completed: 0,
  failed: 0,
  running: 0,
  successRate: 0,
  totalMs: 0,
};

const defaultIdentity: AppIdentityInput = {
  displayName: "Local Workspace",
  email: "owner@agentic.local",
  loginMethod: "email",
  status: "signed-out",
};

const providerConnectionColumns = `
  id,
  user_id as userId,
  provider,
  auth_mode as authMode,
  storage_mode as storageMode,
  account_label as accountLabel,
  status,
  token_reference as tokenReference,
  base_url as baseUrl,
  quota_label as quotaLabel,
  created_at as createdAt,
  updated_at as updatedAt,
  last_connected_at as lastConnectedAt,
  last_verified_at as lastVerifiedAt,
  verification_detail as verificationDetail
`;

const taskSelectColumns = `
  id,
  project_id,
  parent_task_id,
  title,
  prompt,
  status,
  assigned_cli_id,
  assigned_model,
  due_at,
  difficulty,
  estimated_minutes,
  automation_enabled,
  last_run_at,
  last_run_id,
  run_count,
  created_at,
  completed_at
`;

export class DesktopDatabase {
  readonly workflows: WorkflowRepository;
  private appliedMigrations: AppliedMigration[] = [];
  /** Rows appended per run since its last prune; see `appendTerminalLog`. */
  private readonly logAppendsSincePrune = new Map<string, number>();

  private constructor(private readonly db: SqliteDatabase) {
    this.workflows = new WorkflowRepository(db);
  }

  static async open(userDataPath: string): Promise<DesktopDatabase> {
    fs.mkdirSync(userDataPath, { recursive: true });
    const sqlitePath = path.join(userDataPath, "agentic-workspace.sqlite");
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(sqlitePath) as SqliteDatabase;
    const database = new DesktopDatabase(db);
    database.migrate();
    database.reconcileInterruptedAgentRuns();
    database.ensureDefaultIdentity();
    database.sweepExpiredTerminalLogs();
    return database;
  }

  /**
   * Startup retention sweep. Deliberately not fatal: a failed cleanup means the
   * database is larger than we would like, which is not a reason to refuse to open
   * the app. Returns the number of rows dropped.
   */
  sweepExpiredTerminalLogs(now = new Date()): number {
    const cutoff = new Date(now.getTime() - logRetention.maxRunAgeDays * 24 * 60 * 60 * 1000).toISOString();
    try {
      return this.pruneOldTerminalLogs(cutoff);
    } catch {
      return 0;
    }
  }

  getAppIdentity(): AppIdentity {
    const row = this.db
      .prepare(
        `select
           id,
           email,
           display_name as displayName,
           login_method as loginMethod,
           status,
           created_at as createdAt,
           updated_at as updatedAt
         from app_identity
         order by created_at asc
         limit 1`,
      )
      .get() as IdentityRow | undefined;

    if (row) {
      return {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        loginMethod: row.loginMethod as AppIdentity["loginMethod"],
        status: row.status as AppIdentity["status"],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }

    this.ensureDefaultIdentity();
    const next = this.findIdentityRow();
    if (!next) throw new Error("Failed to initialize app identity.");
    return hydrateIdentity(next);
  }

  saveAppIdentity(input: AppIdentityInput): AppIdentity {
    const now = new Date().toISOString();
    const current = this.findIdentityRow();
    const id = current?.id ?? randomUUID();

    this.db
      .prepare(
        `insert into app_identity
           (id, email, display_name, login_method, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           email = excluded.email,
           display_name = excluded.display_name,
           login_method = excluded.login_method,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.email.trim() || defaultIdentity.email,
        input.displayName.trim() || defaultIdentity.displayName,
        input.loginMethod,
        input.status ?? current?.status ?? "signed-in",
        current?.createdAt ?? now,
        now,
      );

    return this.getAppIdentity();
  }

  listProviderConnections(): ProviderConnection[] {
    const rows = this.db
      .prepare(
        `select
           ${providerConnectionColumns}
         from provider_connections
         order by updated_at desc, created_at desc`,
      )
      .all() as ProviderConnectionRow[];

    return rows.map(hydrateProviderConnection);
  }

  saveProviderConnection(input: ProviderConnectionInput): ProviderConnection {
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const identity = this.getAppIdentity();
    const existing = this.findProviderConnectionRow(id);
    const userId = input.userId?.trim() || existing?.userId || identity.id;
    // A brand new connection has not been checked against anything yet, so it
    // starts "unverified" rather than claiming to be connected.
    const status = input.status ?? existing?.status ?? "unverified";
    const authMode = input.authMode ?? existing?.authMode ?? (input.provider === "custom-api" ? "api-key" : "oauth");
    const storageMode = existing?.storageMode ?? "local";

    this.db
      .prepare(
        `insert into provider_connections
           (id, user_id, provider, auth_mode, storage_mode, account_label, status, token_reference,
            base_url, quota_label, created_at, updated_at, last_connected_at, last_verified_at, verification_detail)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           user_id = excluded.user_id,
           provider = excluded.provider,
           auth_mode = excluded.auth_mode,
           storage_mode = excluded.storage_mode,
           account_label = excluded.account_label,
           status = excluded.status,
           token_reference = coalesce(excluded.token_reference, provider_connections.token_reference),
           base_url = excluded.base_url,
           quota_label = excluded.quota_label,
           updated_at = excluded.updated_at,
           last_connected_at = excluded.last_connected_at,
           last_verified_at = excluded.last_verified_at,
           verification_detail = excluded.verification_detail`,
      )
      .run(
        id,
        userId,
        input.provider,
        authMode,
        storageMode,
        input.accountLabel?.trim() || existing?.accountLabel || null,
        status,
        input.tokenReference?.trim() || existing?.tokenReference || null,
        // An empty string is a deliberate "stop using a proxy", so it clears the
        // stored value instead of falling back to the previous endpoint.
        input.baseUrl === undefined ? existing?.baseUrl ?? null : input.baseUrl.trim() || null,
        input.quotaLabel?.trim() || existing?.quotaLabel || null,
        existing?.createdAt ?? now,
        now,
        status === "connected" ? now : existing?.lastConnectedAt ?? null,
        resolveNullable(input.lastVerifiedAt, existing?.lastVerifiedAt),
        resolveNullable(input.verificationDetail, existing?.verificationDetail),
      );

    const saved = this.findProviderConnection(id);
    if (!saved) throw new Error("Failed to persist provider connection");
    return saved;
  }

  deleteProviderConnection(id: string): void {
    this.db.prepare("delete from provider_connections where id = ?").run(id);
  }

  createOrUpdateProject(project: ProjectSummary): void {
    this.db
      .prepare(
        `insert into projects (id, name, path, last_opened_at)
         values (?, ?, ?, ?)
         on conflict(path) do update set
           name = excluded.name,
           last_opened_at = excluded.last_opened_at`,
      )
      .run(project.id, project.name, project.path, project.lastOpenedAt);
  }

  listRecentProjects(): ProjectSummary[] {
    return this.db
      .prepare(
        `select id, name, path, last_opened_at as lastOpenedAt
         from projects
         order by last_opened_at desc
         limit 20`,
      )
      .all() as ProjectSummary[];
  }

  /**
   * Forgets a project from the recent list. Agent runs are keyed by `cwd` and
   * tasks by project path, so history and scheduled work survive the removal.
   */
  removeProject(projectPath: string): void {
    this.db.prepare("delete from projects where path = ?").run(projectPath);
  }

  saveKnowledgeSnapshot(snapshot: KnowledgeSnapshot): void {
    this.db
      .prepare(
        `insert into knowledge_snapshots
          (project_path, project_name, generated_at, total_files, indexed_files, skipped_files, total_bytes, total_lines,
           languages_json, categories_json, files_json, graph_json, agent_brief)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(project_path) do update set
           project_name = excluded.project_name,
           generated_at = excluded.generated_at,
           total_files = excluded.total_files,
           indexed_files = excluded.indexed_files,
           skipped_files = excluded.skipped_files,
           total_bytes = excluded.total_bytes,
           total_lines = excluded.total_lines,
           languages_json = excluded.languages_json,
           categories_json = excluded.categories_json,
           files_json = excluded.files_json,
           graph_json = excluded.graph_json,
           agent_brief = excluded.agent_brief`,
      )
      .run(
        snapshot.projectPath,
        snapshot.projectName,
        snapshot.generatedAt,
        snapshot.totalFiles,
        snapshot.indexedFiles,
        snapshot.skippedFiles,
        snapshot.totalBytes,
        snapshot.totalLines,
        JSON.stringify(snapshot.languages),
        JSON.stringify(snapshot.categories),
        JSON.stringify(snapshot.files),
        JSON.stringify(snapshot.graph),
        snapshot.agentBrief,
      );
  }

  getKnowledgeSnapshot(projectPath: string): KnowledgeSnapshot | null {
    const row = this.db
      .prepare(
        `select
           project_path as projectPath,
           project_name as projectName,
           generated_at as generatedAt,
           total_files as totalFiles,
           indexed_files as indexedFiles,
           skipped_files as skippedFiles,
           total_bytes as totalBytes,
           total_lines as totalLines,
           languages_json as languagesJson,
           categories_json as categoriesJson,
           files_json as filesJson,
           graph_json as graphJson,
           agent_brief as agentBrief
         from knowledge_snapshots
         where project_path = ?`,
      )
      .get(projectPath) as KnowledgeSnapshotRow | undefined;

    if (!row) return null;

    return {
      projectPath: row.projectPath,
      projectName: row.projectName,
      generatedAt: row.generatedAt,
      totalFiles: row.totalFiles,
      indexedFiles: row.indexedFiles,
      skippedFiles: row.skippedFiles,
      totalBytes: row.totalBytes,
      totalLines: row.totalLines,
      languages: parseJsonArray<KnowledgeLanguageStat>(row.languagesJson),
      categories: parseJsonArray<KnowledgeCategoryStat>(row.categoriesJson),
      files: parseJsonArray<KnowledgeFileInsight>(row.filesJson),
      graph: parseJsonValue<KnowledgeCodeGraph>(row.graphJson, { nodes: [], edges: [] }),
      agentBrief: row.agentBrief,
    };
  }

  createAgentRun(run: AgentRunRecord): void {
    this.db
      .prepare(
        `insert into agent_runs
          (id, cli_id, cwd, prompt, model, profile_id, task_id, conversation_id, status, started_at, ended_at, exit_code)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.cliId,
        run.cwd,
        run.prompt,
        run.model ?? null,
        run.profileId ?? null,
        run.taskId ?? null,
        run.conversationId ?? null,
        run.status,
        run.startedAt,
        run.endedAt ?? null,
        run.exitCode ?? null,
      );
  }

  updateAgentRunStatus(runId: string, status: AgentStatus, exitCode?: number | null, conversationId?: string | null): void {
    const endedAt =
      status === "completed" || status === "failed" || status === "stopped" ? new Date().toISOString() : null;
    this.db
      .prepare(
        `update agent_runs
         set status = ?,
             ended_at = coalesce(?, ended_at),
             exit_code = coalesce(?, exit_code),
             conversation_id = coalesce(?, conversation_id)
         where id = ?`,
      )
      .run(status, endedAt, exitCode ?? null, conversationId ?? null, runId);
  }

  /**
   * Appends one terminal log row, clamping the message and periodically pruning the
   * run's oldest rows. See `log-retention.ts` for why both caps exist.
   */
  appendTerminalLog(runId: string, stream: "stdout" | "stderr" | "event" | "stdin", message: string): void {
    const { message: stored } = truncateLogMessage(message);
    this.db
      .prepare(
        `insert into terminal_logs (run_id, stream, message, created_at)
         values (?, ?, ?, ?)`,
      )
      .run(runId, stream, stored, new Date().toISOString());

    // Amortised: counting and deleting on every line would double the write cost of
    // the hot output path for a bound that only matters after thousands of rows.
    const appended = (this.logAppendsSincePrune.get(runId) ?? 0) + 1;
    if (appended < logRetention.pruneIntervalRows) {
      this.logAppendsSincePrune.set(runId, appended);
      return;
    }
    this.logAppendsSincePrune.set(runId, 0);
    this.pruneTerminalLogs(runId);
  }

  /**
   * Drops the oldest rows for a run beyond `maxRowsPerRun`, keeping the newest —
   * the terminal reads the tail, so recent output is what a reopened pane needs.
   * Returns how many rows were removed.
   */
  pruneTerminalLogs(runId: string, maxRows = logRetention.maxRowsPerRun): number {
    const result = this.db
      .prepare(
        `delete from terminal_logs
         where run_id = ?
           and id not in (
             select id from terminal_logs where run_id = ? order by id desc limit ?
           )`,
      )
      .run(runId, runId, maxRows) as { changes?: number } | undefined;
    return Number(result?.changes ?? 0);
  }

  /**
   * Drops logs for runs that finished before `cutoff`. Called on app start: nobody
   * reopens a month-old terminal, and the rows are the largest thing in the file.
   * Runs still in flight have no `ended_at` and are never swept.
   */
  pruneOldTerminalLogs(cutoff: string): number {
    const result = this.db
      .prepare(
        `delete from terminal_logs
         where run_id in (
           select id from agent_runs where ended_at is not null and ended_at < ?
         )`,
      )
      .run(cutoff) as { changes?: number } | undefined;
    return Number(result?.changes ?? 0);
  }

  /** Row count for a run's logs; used by retention tests and diagnostics. */
  countTerminalLogs(runId: string): number {
    const row = this.db
      .prepare("select count(*) as total from terminal_logs where run_id = ?")
      .get(runId) as { total: number | null } | undefined;
    return row?.total ?? 0;
  }

  listTerminalLogs(runId: string, limit = 400): TerminalLogRow[] {
    return this.db
      .prepare(
        `select stream, message, createdAt
         from (
           select stream, message, created_at as createdAt, id
           from terminal_logs
           where run_id = ?
           order by id desc
           limit ?
         )
         order by id asc`,
      )
      .all(runId, limit) as TerminalLogRow[];
  }

  getAgentRun(runId: string): AgentRunRecord | null {
    const row = this.db
      .prepare(
        `select
           id,
           cli_id as cliId,
           cwd,
           prompt,
           model,
           profile_id as profileId,
           task_id as taskId,
           conversation_id as conversationId,
           status,
           started_at as startedAt,
           ended_at as endedAt,
           exit_code as exitCode
         from agent_runs
         where id = ?`,
      )
      .get(runId) as AgentRunRecord | undefined;
    return row ?? null;
  }

  listAgentRuns(): AgentRunRecord[] {
    return this.db
      .prepare(
        `select
           id,
           cli_id as cliId,
           cwd,
           prompt,
           model,
           profile_id as profileId,
           task_id as taskId,
           conversation_id as conversationId,
           status,
           started_at as startedAt,
           ended_at as endedAt,
           exit_code as exitCode
         from agent_runs
         order by started_at desc
         limit 50`,
      )
      .all() as AgentRunRecord[];
  }

  listTasks(projectPath?: string | null): TaskRecord[] {
    const rows = projectPath
      ? (this.db
          .prepare(
            `select ${taskSelectColumns}
             from tasks
             where project_id = ?
             order by case when due_at is null then 1 else 0 end, due_at asc, created_at desc`,
          )
          .all(projectPath) as TaskRow[])
      : (this.db
          .prepare(
            `select ${taskSelectColumns}
             from tasks
             order by case when due_at is null then 1 else 0 end, due_at asc, created_at desc
             limit 100`,
          )
          .all() as TaskRow[]);

    return rows.map(hydrateTask);
  }

  listDueTasks(nowIso = new Date().toISOString(), limit = 20): TaskRecord[] {
    const rows = this.db
      .prepare(
        `select ${taskSelectColumns}
         from tasks
         where automation_enabled = 1
           and status = 'open'
           and due_at is not null
           and due_at <= ?
         order by due_at asc, created_at asc
         limit ?`,
      )
      .all(nowIso, limit) as TaskRow[];
    return rows.map(hydrateTask);
  }

  saveTask(input: TaskSaveInput): TaskRecord {
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const status = input.status ?? "open";
    const completedAt = status === "done" ? now : null;
    const estimatedMinutes =
      typeof input.estimatedMinutes === "number" && Number.isFinite(input.estimatedMinutes)
        ? Math.max(1, Math.round(input.estimatedMinutes))
        : null;

    this.db
      .prepare(
        `insert into tasks (
           id, project_id, parent_task_id, title, prompt, status,
           assigned_cli_id, assigned_model, due_at, difficulty, estimated_minutes,
           automation_enabled, last_run_at, last_run_id, run_count, created_at, completed_at
         )
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, 0, ?, ?)
         on conflict(id) do update set
           project_id = excluded.project_id,
           parent_task_id = excluded.parent_task_id,
           title = excluded.title,
           prompt = excluded.prompt,
           status = excluded.status,
           assigned_cli_id = excluded.assigned_cli_id,
           assigned_model = excluded.assigned_model,
           due_at = excluded.due_at,
           difficulty = excluded.difficulty,
           estimated_minutes = excluded.estimated_minutes,
           automation_enabled = excluded.automation_enabled,
           completed_at = excluded.completed_at`,
      )
      .run(
        id,
        input.projectPath?.trim() || null,
        input.parentTaskId?.trim() || null,
        input.title.trim(),
        input.prompt.trim(),
        status,
        input.assignedCliId ?? null,
        input.assignedModel?.trim() || null,
        input.dueAt?.trim() || null,
        input.difficulty ?? null,
        estimatedMinutes,
        input.automationEnabled ? 1 : 0,
        now,
        completedAt,
      );

    const saved = this.findTask(id);
    if (!saved) throw new Error(`Task ${id} could not be saved.`);
    return saved;
  }

  setTaskStatus(id: string, status: TaskStatus): TaskRecord {
    this.db
      .prepare("update tasks set status = ?, completed_at = ? where id = ?")
      .run(status, status === "done" ? new Date().toISOString() : null, id);
    const saved = this.findTask(id);
    if (!saved) throw new Error(`Task ${id} was not found.`);
    return saved;
  }

  markTaskRunStarted(id: string, runId: string): TaskRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `update tasks
         set status = 'investigating',
             completed_at = null,
             last_run_at = ?,
             last_run_id = ?,
             run_count = coalesce(run_count, 0) + 1
         where id = ?`,
      )
      .run(now, runId, id);
    const saved = this.getTask(id);
    if (!saved) throw new Error(`Task ${id} was not found.`);
    return saved;
  }

  finishTaskRun(id: string, status: AgentStatus, runId: string): TaskRecord | null {
    const taskStatus: TaskStatus = status === "completed" ? "done" : "blocked";
    const completedAt = taskStatus === "done" ? new Date().toISOString() : null;
    this.db
      .prepare(
        `update tasks
         set status = ?,
             completed_at = ?,
             last_run_id = ?
         where id = ?`,
      )
      .run(taskStatus, completedAt, runId, id);
    return this.getTask(id);
  }

  deleteTask(id: string): void {
    this.db.prepare("delete from tasks where id = ?").run(id);
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db
      .prepare(`select ${taskSelectColumns} from tasks where id = ?`)
      .get(id) as TaskRow | undefined;
    return row ? hydrateTask(row) : null;
  }

  saveAgentProfile(input: AgentProfileInput): AgentProfile {
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const existing = input.id ? this.findProfileRow(id) : null;

    this.db
      .prepare(
        `insert into agent_profiles
           (id, name, role, cli_id, module, model, provider_connection_id, accent, cwd, system_prompt, extra_args, command_override,
            prompt_mode, interactive, force_tty, auto_approve, enabled, tags, options, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           name = excluded.name,
           role = excluded.role,
           cli_id = excluded.cli_id,
           module = excluded.module,
           model = excluded.model,
           provider_connection_id = excluded.provider_connection_id,
           accent = excluded.accent,
           cwd = excluded.cwd,
           system_prompt = excluded.system_prompt,
           extra_args = excluded.extra_args,
           command_override = excluded.command_override,
           prompt_mode = excluded.prompt_mode,
           interactive = excluded.interactive,
           force_tty = excluded.force_tty,
           auto_approve = excluded.auto_approve,
           enabled = excluded.enabled,
           tags = excluded.tags,
           options = excluded.options,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.name.trim(),
        input.role.trim(),
        input.cliId,
        input.module ?? null,
        input.model.trim(),
        input.providerConnectionId?.trim() || null,
        input.accent ?? null,
        input.cwd?.trim() || null,
        input.systemPrompt?.trim() || null,
        input.extraArgs?.trim() || null,
        input.commandOverride?.trim() || null,
        input.promptMode ?? null,
        input.interactive ? 1 : 0,
        input.forceTty ? 1 : 0,
        input.autoApprove ? 1 : 0,
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.options ?? {}),
        existing?.createdAt ?? now,
        now,
      );

    const saved = this.listAgentProfiles().find((profile) => profile.id === id);
    if (!saved) throw new Error("Failed to persist agent profile");
    return saved;
  }

  listAgentProfiles(): AgentProfile[] {
    const rows = this.db
      .prepare(
        `select
           id,
           name,
           role,
           cli_id as cliId,
           module,
           model,
           provider_connection_id as providerConnectionId,
           accent,
           cwd,
           system_prompt as systemPrompt,
           extra_args as extraArgs,
           command_override as commandOverride,
           prompt_mode as promptMode,
           interactive,
           force_tty as forceTty,
           auto_approve as autoApprove,
           enabled,
           tags,
           options,
           created_at as createdAt,
           updated_at as updatedAt
         from agent_profiles
         order by created_at asc`,
      )
      .all() as ProfileRow[];

    const stats = this.profileStats();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      cliId: row.cliId as AgentProfile["cliId"],
      module: (row.module as AgentModuleId | null) ?? undefined,
      model: row.model,
      providerConnectionId: row.providerConnectionId ?? undefined,
      accent: row.accent ?? "#a78bfa",
      cwd: row.cwd ?? undefined,
      systemPrompt: row.systemPrompt ?? undefined,
      extraArgs: row.extraArgs ?? undefined,
      commandOverride: row.commandOverride ?? undefined,
      promptMode: (row.promptMode as AgentPromptMode | null) ?? undefined,
      interactive: row.interactive === 1,
      forceTty: row.forceTty === 1,
      autoApprove: row.autoApprove === 1,
      enabled: row.enabled === 1,
      tags: parseTags(row.tags),
      options: parseOptions(row.options),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      stats: stats.get(row.id) ?? emptyStats,
    }));
  }

  deleteAgentProfile(id: string): void {
    this.db.prepare("delete from agent_profiles where id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }

  private reconcileInterruptedAgentRuns(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `update agent_runs
         set status = 'stopped',
             ended_at = coalesce(ended_at, ?)
         where ended_at is null
           and status not in ('completed', 'failed', 'stopped')`,
      )
      .run(now);
  }

  private ensureDefaultIdentity(): void {
    if (this.findIdentityRow()) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into app_identity
           (id, email, display_name, login_method, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        defaultIdentity.email,
        defaultIdentity.displayName,
        defaultIdentity.loginMethod,
        defaultIdentity.status ?? "signed-out",
        now,
        now,
      );
  }

  private findIdentityRow(): IdentityRow | null {
    const row = this.db
      .prepare(
        `select
           id,
           email,
           display_name as displayName,
           login_method as loginMethod,
           status,
           created_at as createdAt,
           updated_at as updatedAt
         from app_identity
         order by created_at asc
         limit 1`,
      )
      .get() as IdentityRow | undefined;
    return row ?? null;
  }

  private findProviderConnection(id: string): ProviderConnection | null {
    const row = this.findProviderConnectionRow(id);
    return row ? hydrateProviderConnection(row) : null;
  }

  private findProviderConnectionRow(id: string): ProviderConnectionRow | null {
    const row = this.db
      .prepare(
        `select
           ${providerConnectionColumns}
         from provider_connections
         where id = ?`,
      )
      .get(id) as ProviderConnectionRow | undefined;
    return row ?? null;
  }

  private findProfileRow(id: string): { createdAt: string } | null {
    const row = this.db.prepare("select created_at as createdAt from agent_profiles where id = ?").get(id) as
      | { createdAt: string }
      | undefined;
    return row ?? null;
  }

  private findTask(id: string): TaskRecord | null {
    return this.getTask(id);
  }

  private profileStats(): Map<string, AgentProfileStats> {
    const rows = this.db
      .prepare(
        `select
           profile_id as profileId,
           count(*) as runs,
           sum(case when status = 'completed' then 1 else 0 end) as completed,
           sum(case when status = 'failed' then 1 else 0 end) as failed,
           sum(case when ended_at is null then 1 else 0 end) as running,
           sum(
             case when ended_at is not null
               then cast((julianday(ended_at) - julianday(started_at)) * 86400000 as integer)
               else 0 end
           ) as totalMs,
           max(started_at) as lastRunAt,
           (
             select latest.status
             from agent_runs latest
             where latest.profile_id = agent_runs.profile_id
             order by latest.started_at desc, latest.id desc
             limit 1
           ) as lastStatus
         from agent_runs
         where profile_id is not null
         group by profile_id`,
      )
      .all() as StatsRow[];

    const map = new Map<string, AgentProfileStats>();
    for (const row of rows) {
      const finished = (row.completed ?? 0) + (row.failed ?? 0);
      map.set(row.profileId, {
        runs: row.runs ?? 0,
        completed: row.completed ?? 0,
        failed: row.failed ?? 0,
        running: row.running ?? 0,
        successRate: finished > 0 ? Math.round(((row.completed ?? 0) / finished) * 100) : 0,
        totalMs: row.totalMs ?? 0,
        lastRunAt: row.lastRunAt ?? undefined,
        lastStatus: (row.lastStatus as AgentStatus | null) ?? undefined,
      });
    }
    return map;
  }

  private migrate(): void {
    this.db.exec(`
      pragma journal_mode = wal;

      create table if not exists projects (
        id text primary key,
        name text not null,
        path text not null unique,
        last_opened_at text not null
      );

      create table if not exists app_identity (
        id text primary key,
        email text not null,
        display_name text not null,
        login_method text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists provider_connections (
        id text primary key,
        user_id text not null,
        provider text not null,
        auth_mode text not null,
        storage_mode text not null,
        account_label text,
        status text not null,
        token_reference text,
        base_url text,
        quota_label text,
        created_at text not null,
        updated_at text not null,
        last_connected_at text,
        last_verified_at text,
        verification_detail text
      );

      create table if not exists agent_profiles (
        id text primary key,
        name text not null,
        role text not null,
        cli_id text not null,
        module text,
        model text not null,
        provider_connection_id text,
        accent text,
        cwd text,
        system_prompt text,
        extra_args text,
        command_override text,
        prompt_mode text,
        interactive integer not null default 0,
        force_tty integer not null default 0,
        auto_approve integer not null default 0,
        enabled integer not null default 1,
        tags text,
        options text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists tasks (
        id text primary key,
        project_id text,
        parent_task_id text,
        title text not null,
        prompt text not null,
        status text not null,
        assigned_cli_id text,
        assigned_model text,
        due_at text,
        difficulty text,
        estimated_minutes integer,
        automation_enabled integer not null default 0,
        last_run_at text,
        last_run_id text,
        run_count integer not null default 0,
        created_at text not null default current_timestamp,
        completed_at text
      );

      create table if not exists agent_runs (
        id text primary key,
        cli_id text not null,
        cwd text not null,
        prompt text not null,
        model text,
        task_id text,
        conversation_id text,
        status text not null,
        started_at text not null,
        ended_at text,
        exit_code integer
      );

      create table if not exists agent_events (
        id integer primary key autoincrement,
        run_id text not null,
        type text not null,
        status text,
        message text,
        created_at text not null default current_timestamp
      );

      create table if not exists terminal_logs (
        id integer primary key autoincrement,
        run_id text not null,
        stream text not null,
        message text not null,
        created_at text not null
      );

      create index if not exists idx_terminal_logs_run on terminal_logs (run_id, id);

      create table if not exists approvals (
        id text primary key,
        run_id text not null,
        summary text not null,
        status text not null,
        created_at text not null default current_timestamp,
        decided_at text
      );

      create table if not exists settings (
        key text primary key,
        value text not null,
        updated_at text not null default current_timestamp
      );

      create table if not exists knowledge_snapshots (
        project_path text primary key,
        project_name text not null,
        generated_at text not null,
        total_files integer not null,
        indexed_files integer not null,
        skipped_files integer not null,
        total_bytes integer not null,
        total_lines integer not null,
        languages_json text not null,
        categories_json text not null,
        files_json text not null,
        graph_json text not null,
        agent_brief text not null
      );
    `);

    this.ensureColumn("agent_runs", "profile_id", "text");
    this.ensureColumn("agent_runs", "task_id", "text");
    this.ensureColumn("agent_runs", "conversation_id", "text");
    this.ensureColumn("agent_profiles", "provider_connection_id", "text");
    this.ensureColumn("agent_profiles", "module", "text");
    this.ensureColumn("agent_profiles", "options", "text");
    ensureColumns(this.db, "tasks", [
      { name: "parent_task_id", ddl: "text" },
      { name: "assigned_cli_id", ddl: "text" },
      { name: "assigned_model", ddl: "text" },
      { name: "due_at", ddl: "text" },
      { name: "difficulty", ddl: "text" },
      { name: "estimated_minutes", ddl: "integer" },
      { name: "automation_enabled", ddl: "integer not null default 0" },
      { name: "last_run_at", ddl: "text" },
      { name: "last_run_id", ddl: "text" },
      { name: "run_count", ddl: "integer not null default 0" },
    ]);
    this.db.exec(`
      create index if not exists idx_tasks_due on tasks (automation_enabled, status, due_at);
      create index if not exists idx_agent_runs_task on agent_runs (task_id, started_at desc);
      create index if not exists idx_provider_connections_user on provider_connections (user_id, status);
      create index if not exists idx_knowledge_snapshots_generated on knowledge_snapshots (generated_at desc);
    `);
    this.workflows.migrate();

    // Versioned steps run last, so they can assume every legacy table exists.
    this.appliedMigrations = runMigrations(this.db, appMigrations);
  }

  /** Highest recorded schema version; 0 for a database that predates versioning. */
  schemaVersion(): number {
    return schemaVersion(this.db);
  }

  /** Migrations that ran during this open, for startup logging and tests. */
  migrationsAppliedOnOpen(): AppliedMigration[] {
    return this.appliedMigrations;
  }

  /** Adds a column when an older database file predates it. */
  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`alter table ${table} add column ${column} ${type}`);
  }
}

function hydrateTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    projectPath: row.project_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    prompt: row.prompt,
    status: row.status as TaskStatus,
    assignedCliId: row.assigned_cli_id as TaskRecord["assignedCliId"],
    assignedModel: row.assigned_model,
    dueAt: row.due_at,
    difficulty: row.difficulty as TaskDifficulty | null,
    estimatedMinutes: row.estimated_minutes,
    automationEnabled: row.automation_enabled === 1,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    runCount: row.run_count ?? 0,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function hydrateIdentity(row: IdentityRow): AppIdentity {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    loginMethod: row.loginMethod as AppIdentity["loginMethod"],
    status: row.status as AppIdentity["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Distinguishes "clear this column" from "leave it alone" for optional inputs.
 * `null` writes null, `undefined` keeps whatever the row already had. Needed
 * because a rotated credential must drop a stale verification timestamp, which
 * a plain `input.x || existing?.x || null` fallback can never express.
 */
function resolveNullable(next: string | null | undefined, existing: string | null | undefined): string | null {
  if (next === null) return null;
  if (next === undefined) return existing ?? null;
  return next.trim() || existing || null;
}

function hydrateProviderConnection(row: ProviderConnectionRow): ProviderConnection {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider as ProviderConnection["provider"],
    authMode: row.authMode as ProviderConnection["authMode"],
    storageMode: row.storageMode as ProviderConnection["storageMode"],
    accountLabel: row.accountLabel ?? undefined,
    status: row.status as ProviderConnection["status"],
    tokenReference: row.tokenReference ?? undefined,
    baseUrl: row.baseUrl ?? undefined,
    quotaLabel: row.quotaLabel ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastConnectedAt: row.lastConnectedAt ?? undefined,
    lastVerifiedAt: row.lastVerifiedAt ?? undefined,
    verificationDetail: row.verificationDetail ?? undefined,
  };
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Option values are declared per CLI descriptor, so a stored profile can hold keys
 * the current catalog no longer declares. Keep whatever still matches the
 * `AgentOptionValue` union and drop the rest rather than surfacing junk to the UI.
 */
function parseOptions(raw: string | null): AgentOptionValues {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const values: AgentOptionValues = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" || typeof value === "boolean") {
        values[key] = value;
      } else if (Array.isArray(value)) {
        values[key] = value.filter((entry): entry is string => typeof entry === "string");
      }
    }
    return values;
  } catch {
    return {};
  }
}

function parseJsonArray<T>(raw: string): T[] {  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonValue<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
