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
import type { GitDiffSummary, ProjectSummary } from "./project";
import type {
  AppIdentity,
  AppIdentityInput,
  ProviderConnection,
  ProviderConnectionAuthRequest,
  ProviderConnectionAuthResult,
  ProviderConnectionInput,
} from "./settings";
import type { SystemDiagnostics } from "./system";
import type { TaskPlanInput, TaskPlanResult, TaskRecord, TaskSaveInput, TaskScheduleTickResult, TaskStatus } from "./task";
import type {
  WorkflowActivityEntry,
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
    diagnostics: () => Promise<SystemDiagnostics>;
  };
  projects: {
    selectFolder: () => Promise<ProjectSummary | null>;
    listRecent: () => Promise<ProjectSummary[]>;
  };
  settings: {
    getIdentity: () => Promise<AppIdentity>;
    saveIdentity: (input: AppIdentityInput) => Promise<AppIdentity>;
    listProviderConnections: () => Promise<ProviderConnection[]>;
    saveProviderConnection: (input: ProviderConnectionInput) => Promise<ProviderConnection>;
    deleteProviderConnection: (id: string) => Promise<void>;
    openProviderAuth: (input: ProviderConnectionAuthRequest) => Promise<ProviderConnectionAuthResult>;
  };
  agents: {
    catalog: () => Promise<AgentCliDescriptor[]>;
    ping: (cliId: AgentCliId, commandOverride?: string) => Promise<AgentPingResult>;
    pingAll: () => Promise<AgentPingResult[]>;
    models: (cliId: AgentCliId) => Promise<AgentModelProbe>;
    start: (input: AgentRunInput) => Promise<AgentProcess>;
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
    cancel: (workflowRunId: string) => Promise<void>;
    exportDefinition: (workflowId: string) => Promise<WorkflowExportResult | null>;
    importDefinition: () => Promise<WorkflowDefinition | null>;
  };
  git: {
    diff: (cwd: string) => Promise<GitDiffSummary>;
  };
  events: {
    subscribe: (callback: (event: AgentEvent) => void) => () => void;
    subscribeWorkflow: (callback: (event: WorkflowEvent) => void) => () => void;
  };
}
