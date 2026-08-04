import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentCliId,
  AgentEvent,
  AgentProfileInput,
  AgentRunInput,
  AgenticDesktopApi,
  AppIdentityInput,
  KnowledgeExportFormat,
  KnowledgeScanInput,
  ProviderConnectionAuthRequest,
  ProviderConnectionInput,
  TaskEvent,
  TaskPlanInput,
  TaskSaveInput,
  TaskStatus,
  WorkflowEvent,
  WorkflowRunOptions,
  WorkflowSaveInput,
  WorkflowStatus,
} from "@contracts";

const api: AgenticDesktopApi = {
  system: {
    diagnostics: () => ipcRenderer.invoke("system:diagnostics"),
  },
  projects: {
    selectFolder: () => ipcRenderer.invoke("project:select-folder"),
    listRecent: () => ipcRenderer.invoke("project:list-recent"),
    remove: (projectPath: string) => ipcRenderer.invoke("project:remove", projectPath),
  },
  settings: {
    getIdentity: () => ipcRenderer.invoke("settings:get-identity"),
    saveIdentity: (input: AppIdentityInput) => ipcRenderer.invoke("settings:save-identity", input),
    listProviderConnections: () => ipcRenderer.invoke("settings:list-provider-connections"),
    saveProviderConnection: (input: ProviderConnectionInput) =>
      ipcRenderer.invoke("settings:save-provider-connection", input),
    deleteProviderConnection: (id: string) => ipcRenderer.invoke("settings:delete-provider-connection", id),
    verifyProviderConnection: (id: string) => ipcRenderer.invoke("settings:verify-provider-connection", id),
    openProviderAuth: (input: ProviderConnectionAuthRequest) => ipcRenderer.invoke("settings:open-provider-auth", input),
  },
  agents: {
    catalog: () => ipcRenderer.invoke("agent:catalog"),
    ping: (cliId: AgentCliId, commandOverride?: string) => ipcRenderer.invoke("agent:ping", cliId, commandOverride),
    pingAll: () => ipcRenderer.invoke("agent:ping-all"),
    models: (cliId: AgentCliId) => ipcRenderer.invoke("agent:models", cliId),
    start: (input: AgentRunInput) => ipcRenderer.invoke("agent:start", input),
    stop: (runId: string) => ipcRenderer.invoke("agent:stop", runId),
    send: (runId: string, data: string) => ipcRenderer.invoke("agent:send", runId, data),
    sessions: () => ipcRenderer.invoke("agent:sessions"),
    history: () => ipcRenderer.invoke("agent:history"),
    listProfiles: () => ipcRenderer.invoke("agent:profiles"),
    saveProfile: (input: AgentProfileInput) => ipcRenderer.invoke("agent:profile-save", input),
    deleteProfile: (id: string) => ipcRenderer.invoke("agent:profile-delete", id),
    logs: (runId: string) => ipcRenderer.invoke("agent:logs", runId),
  },
  tasks: {
    list: (projectPath?: string | null) => ipcRenderer.invoke("task:list", projectPath),
    save: (input: TaskSaveInput) => ipcRenderer.invoke("task:save", input),
    plan: (input: TaskPlanInput) => ipcRenderer.invoke("task:plan", input),
    runDue: () => ipcRenderer.invoke("task:run-due"),
    setStatus: (id: string, status: TaskStatus) => ipcRenderer.invoke("task:set-status", id, status),
    remove: (id: string) => ipcRenderer.invoke("task:remove", id),
  },
  workflows: {
    list: () => ipcRenderer.invoke("workflow:list"),
    get: (workflowId: string) => ipcRenderer.invoke("workflow:get", workflowId),
    save: (input: WorkflowSaveInput) => ipcRenderer.invoke("workflow:save", input),
    remove: (workflowId: string) => ipcRenderer.invoke("workflow:remove", workflowId),
    duplicate: (workflowId: string) => ipcRenderer.invoke("workflow:duplicate", workflowId),
    setStatus: (workflowId: string, status: WorkflowStatus) =>
      ipcRenderer.invoke("workflow:set-status", workflowId, status),
    toggleFavorite: (workflowId: string) => ipcRenderer.invoke("workflow:toggle-favorite", workflowId),
    metrics: () => ipcRenderer.invoke("workflow:metrics"),
    activity: (limit?: number) => ipcRenderer.invoke("workflow:activity", limit),
    runs: (workflowId: string, limit?: number) => ipcRenderer.invoke("workflow:runs", workflowId, limit),
    run: (options: WorkflowRunOptions) => ipcRenderer.invoke("workflow:run", options),
    runDueSchedules: () => ipcRenderer.invoke("workflow:run-due"),
    cancel: (workflowRunId: string) => ipcRenderer.invoke("workflow:cancel", workflowRunId),
    approve: (workflowRunId: string) => ipcRenderer.invoke("workflow:approve", workflowRunId),
    reject: (workflowRunId: string, reason?: string) => ipcRenderer.invoke("workflow:reject", workflowRunId, reason),
    exportDefinition: (workflowId: string) => ipcRenderer.invoke("workflow:export", workflowId),
    importDefinition: () => ipcRenderer.invoke("workflow:import"),
  },
  git: {
    diff: (cwd: string) => ipcRenderer.invoke("git:diff", cwd),
  },
  knowledge: {
    get: (projectPath: string) => ipcRenderer.invoke("knowledge:get", projectPath),
    scan: (input: KnowledgeScanInput) => ipcRenderer.invoke("knowledge:scan", input),
    export: (projectPath: string, format: KnowledgeExportFormat) =>
      ipcRenderer.invoke("knowledge:export", projectPath, format),
  },
  events: {
    subscribe: (callback: (event: AgentEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => callback(payload);
      ipcRenderer.on("agent:event", listener);
      return () => ipcRenderer.removeListener("agent:event", listener);
    },
    subscribeWorkflow: (callback: (event: WorkflowEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WorkflowEvent) => callback(payload);
      ipcRenderer.on("workflow:event", listener);
      return () => ipcRenderer.removeListener("workflow:event", listener);
    },
    subscribeTask: (callback: (event: TaskEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TaskEvent) => callback(payload);
      ipcRenderer.on("task:event", listener);
      return () => ipcRenderer.removeListener("task:event", listener);
    },
  },
};

contextBridge.exposeInMainWorld("agentic", api);
