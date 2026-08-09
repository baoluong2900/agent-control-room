import type {
  AgentCliDescriptor,
  AgentCliId,
  AgentEvent,
  AgentModelProbe,
  AgentPingResult,
  AgentProcess,
  AgentProfile,
  AgentProfileInput,
  AgentRunInput,
  AgentRunRecord,
  AgentSessionSummary,
} from "./agent";
import type {
  GitBranchSummary,
  GitCommitSummary,
  GitDiffSummary,
  GitFileDiff,
  GitOperationResult,
  GitStashDetail,
  GitStashEntry,
  ProjectSummary,
} from "./project";
import type {
  GatewayUsageResult,
  GatewayUsageSettings,
  GatewayUsageSettingsInput,
  GatewayUsageSnapshot,
} from "./gateway";
import type {
  KnowledgeExportFormat,
  KnowledgeExportResult,
  KnowledgeScanInput,
  KnowledgeScanProgress,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
} from "./knowledge";
import type {
  AppIdentity,
  AppIdentityInput,
  ProviderConnection,
  ProviderConnectionAuthRequest,
  ProviderConnectionAuthResult,
  ProviderConnectionInput,
  ProviderConnectionVerifyResult,
} from "./settings";
import type { DatabaseMaintenanceResult, DatabaseStorageReport, SystemDiagnostics } from "./system";
import type {
  TaskEvent,
  TaskPlanInput,
  TaskPlanResult,
  TaskRecord,
  TaskSaveInput,
  TaskScheduleTickResult,
  TaskStatus,
} from "./task";
import type {
  WorkflowActivityEntry,
  WebhookEndpointStatus,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowExportResult,
  WorkflowMetrics,
  WorkflowRunOptions,
  WorkflowRunRecord,
  WorkflowSaveInput,
  WorkflowStatus,
} from "./workflow";

export interface AgenticDesktopApi {
  system: {
    diagnostics: (projectPath?: string | null) => Promise<SystemDiagnostics>;
    /** Size, location and log-row count of the local sqlite store. */
    storage: () => Promise<DatabaseStorageReport>;
    /**
     * Drops terminal logs for finished runs outside the fixed retention window,
     * then reclaims the freed pages. Reports the real byte delta.
     */
    cleanupStorage: () => Promise<DatabaseMaintenanceResult>;
  };
  projects: {
    selectFolder: () => Promise<ProjectSummary | null>;
    listRecent: () => Promise<ProjectSummary[]>;
    remove: (projectPath: string) => Promise<ProjectSummary[]>;
  };
  settings: {
    getIdentity: () => Promise<AppIdentity>;
    saveIdentity: (input: AppIdentityInput) => Promise<AppIdentity>;
    listProviderConnections: () => Promise<ProviderConnection[]>;
    saveProviderConnection: (input: ProviderConnectionInput) => Promise<ProviderConnection>;
    deleteProviderConnection: (id: string) => Promise<void>;
    verifyProviderConnection: (id: string) => Promise<ProviderConnectionVerifyResult>;
    /**
     * Opens the provider's own site in the user's browser so they can copy a
     * credential out. Deliberately not called `openProviderAuth`: no OAuth
     * callback, device-code exchange, or token refresh happens here.
     */
    openProviderSite: (input: ProviderConnectionAuthRequest) => Promise<ProviderConnectionAuthResult>;
  };
  agents: {
    catalog: () => Promise<AgentCliDescriptor[]>;
    ping: (cliId: AgentCliId, commandOverride?: string) => Promise<AgentPingResult>;
    pingAll: () => Promise<AgentPingResult[]>;
    models: (cliId: AgentCliId) => Promise<AgentModelProbe>;
    start: (input: AgentRunInput) => Promise<AgentProcess>;
    restart: (runId: string) => Promise<AgentProcess>;
    stop: (runId: string) => Promise<void>;
    send: (runId: string, data: string) => Promise<boolean>;
    sessions: () => Promise<AgentSessionSummary[]>;
    history: () => Promise<AgentRunRecord[]>;
    listProfiles: () => Promise<AgentProfile[]>;
    saveProfile: (input: AgentProfileInput) => Promise<AgentProfile>;
    deleteProfile: (id: string) => Promise<void>;
    logs: (runId: string) => Promise<Array<{ stream: string; message: string; createdAt: string }>>;
  };
  tasks: {
    list: (projectPath?: string | null) => Promise<TaskRecord[]>;
    save: (input: TaskSaveInput) => Promise<TaskRecord>;
    plan: (input: TaskPlanInput) => Promise<TaskPlanResult>;
    runDue: () => Promise<TaskScheduleTickResult>;
    setStatus: (id: string, status: TaskStatus) => Promise<TaskRecord>;
    retryNow: (id: string) => Promise<TaskScheduleTickResult>;
    remove: (id: string) => Promise<void>;
  };
  workflows: {
    list: () => Promise<WorkflowDefinition[]>;
    get: (workflowId: string) => Promise<WorkflowDefinition | null>;
    save: (input: WorkflowSaveInput) => Promise<WorkflowDefinition>;
    remove: (workflowId: string) => Promise<void>;
    duplicate: (workflowId: string) => Promise<WorkflowDefinition>;
    setStatus: (workflowId: string, status: WorkflowStatus) => Promise<WorkflowDefinition>;
    toggleFavorite: (workflowId: string) => Promise<WorkflowDefinition>;
    metrics: () => Promise<WorkflowMetrics>;
    activity: (limit?: number) => Promise<WorkflowActivityEntry[]>;
    runs: (workflowId: string, limit?: number) => Promise<WorkflowRunRecord[]>;
    run: (options: WorkflowRunOptions) => Promise<WorkflowRunRecord>;
    /** Fires every `schedule`-triggered workflow that is due; returns their ids. */
    runDueSchedules: () => Promise<string[]>;
    /** Current state of the local inbound webhook listener. */
    webhookStatus: () => Promise<WebhookEndpointStatus>;
    /** Issues a new token, invalidating the previous one. */
    rotateWebhookToken: () => Promise<WebhookEndpointStatus>;
    cancel: (workflowRunId: string) => Promise<void>;
    approve: (workflowRunId: string) => Promise<WorkflowRunRecord>;
    reject: (workflowRunId: string, reason?: string) => Promise<WorkflowRunRecord>;
    exportDefinition: (workflowId: string) => Promise<WorkflowExportResult | null>;
    importDefinition: () => Promise<WorkflowDefinition | null>;
  };
  gateway: {
    /** Current dashboard configuration. Never carries the API key itself. */
    getUsageSettings: () => Promise<GatewayUsageSettings>;
    /** Saves the base URL and/or the key; the key goes straight to the secret vault. */
    saveUsageSettings: (input: GatewayUsageSettingsInput) => Promise<GatewayUsageSettings>;
    /**
     * One poll of credit and usage. Resolves to a typed failure instead of
     * rejecting, so a polling panel needs no try/catch per tick.
     */
    getUsageSnapshot: (days?: number) => Promise<GatewayUsageResult<GatewayUsageSnapshot>>;
  };
  git: {
    diff: (cwd: string) => Promise<GitDiffSummary>;
    fileDiff: (cwd: string, path: string, staged?: boolean) => Promise<GitFileDiff>;
    log: (cwd: string, limit?: number) => Promise<GitCommitSummary[]>;
    stage: (cwd: string, path: string) => Promise<GitOperationResult>;
    unstage: (cwd: string, path: string) => Promise<GitOperationResult>;
    commit: (cwd: string, message: string) => Promise<GitOperationResult>;
    /** Local branches, current one first. */
    branches: (cwd: string) => Promise<GitBranchSummary[]>;
    /** Switches branches, or creates one from HEAD when `create` is set. */
    checkout: (cwd: string, name: string, create?: boolean) => Promise<GitOperationResult>;
    stashes: (cwd: string) => Promise<GitStashEntry[]>;
    /** The patch one stash would restore, for review before applying it. */
    stashDetail: (cwd: string, ref: string) => Promise<GitStashDetail>;
    stashPush: (cwd: string, message?: string, includeUntracked?: boolean) => Promise<GitOperationResult>;
    /** `keep: true` applies and leaves the entry; false pops it. */
    stashApply: (cwd: string, ref: string, expectedOid: string, keep?: boolean) => Promise<GitOperationResult>;
    /** Drops only when the shifting ref still names the immutable expected OID. */
    stashDrop: (cwd: string, ref: string, expectedOid: string) => Promise<GitOperationResult>;
  };
  knowledge: {
    get: (projectPath: string) => Promise<KnowledgeSnapshot | null>;
    scan: (input: KnowledgeScanInput) => Promise<KnowledgeSnapshot>;
    /** Requests cancellation of an in-flight scan by its `scanId`. */
    cancelScan: (scanId: string) => Promise<boolean>;
    /** Ranked search over the stored snapshot, scored in the main process. */
    search: (input: KnowledgeSearchInput) => Promise<KnowledgeSearchResult>;
    export: (projectPath: string, format: KnowledgeExportFormat) => Promise<KnowledgeExportResult>;
  };
  events: {
    subscribe: (callback: (event: AgentEvent) => void) => () => void;
    subscribeWorkflow: (callback: (event: WorkflowEvent) => void) => () => void;
    subscribeTask: (callback: (event: TaskEvent) => void) => () => void;
    subscribeKnowledge: (callback: (event: KnowledgeScanProgress) => void) => () => void;
  };
}
