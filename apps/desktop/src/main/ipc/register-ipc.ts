import { ipcMain } from "electron";
import type {
  AgentCliId,
  AgentProfileInput,
  AgentRunInput,
  AppIdentityInput,
  ProviderConnectionAuthRequest,
  ProviderConnectionInput,
  TaskPlanInput,
  TaskSaveInput,
  TaskStatus,
  WorkflowRunOptions,
  WorkflowSaveInput,
  WorkflowStatus,
} from "@contracts";
import { listAgentCatalog } from "../agents/catalog";
import { pingAgentCli, pingAllAgentClis, probeAgentModels } from "../agents/probe";
import type { DesktopDatabase } from "../database/desktop-database";
import { readGitDiff } from "../git/git-service";
import { AgentProcessManager } from "../processes/agent-process-manager";
import { ProjectService } from "../projects/project-service";
import type { SettingsService } from "../settings/settings-service";
import type { TaskAutomationService } from "../tasks/task-automation-service";
import type { WorkflowService } from "../workflows/workflow-service";
import { collectDiagnostics } from "./diagnostics";

export function registerIpcHandlers({
  agentProcessManager,
  database,
  projectService,
  settingsService,
  taskAutomationService,
  workflowService,
}: {
  agentProcessManager: AgentProcessManager;
  database: DesktopDatabase;
  projectService: ProjectService;
  settingsService: SettingsService;
  taskAutomationService: TaskAutomationService;
  workflowService: WorkflowService;
}): void {
  ipcMain.handle("system:diagnostics", () => collectDiagnostics());

  ipcMain.handle("project:select-folder", () => projectService.selectFolder());
  ipcMain.handle("project:list-recent", () => projectService.listRecent());

  ipcMain.handle("settings:get-identity", () => settingsService.getIdentity());
  ipcMain.handle("settings:save-identity", (_event, input: AppIdentityInput) => settingsService.saveIdentity(input));
  ipcMain.handle("settings:list-provider-connections", () => settingsService.listProviderConnections());
  ipcMain.handle("settings:save-provider-connection", (_event, input: ProviderConnectionInput) =>
    settingsService.saveProviderConnection(input),
  );
  ipcMain.handle("settings:delete-provider-connection", (_event, id: string) =>
    settingsService.deleteProviderConnection(id),
  );
  ipcMain.handle("settings:open-provider-auth", (_event, input: ProviderConnectionAuthRequest) =>
    settingsService.openProviderAuth(input),
  );

  ipcMain.handle("agent:catalog", () => listAgentCatalog());
  ipcMain.handle("agent:ping", (_event, cliId: AgentCliId, commandOverride?: string) =>
    pingAgentCli(cliId, commandOverride),
  );
  ipcMain.handle("agent:ping-all", () => pingAllAgentClis());
  ipcMain.handle("agent:models", (_event, cliId: AgentCliId) => probeAgentModels(cliId));

  ipcMain.handle("agent:start", (_event, input: AgentRunInput) => agentProcessManager.start(input));
  ipcMain.handle("agent:stop", (_event, runId: string) => agentProcessManager.stop(runId));
  ipcMain.handle("agent:send", (_event, runId: string, data: string) => agentProcessManager.send(runId, data));
  ipcMain.handle("agent:sessions", () => agentProcessManager.sessions());
  ipcMain.handle("agent:history", () => database.listAgentRuns());
  ipcMain.handle("agent:logs", (_event, runId: string) => database.listTerminalLogs(runId));

  ipcMain.handle("agent:profiles", () => database.listAgentProfiles());
  ipcMain.handle("agent:profile-save", (_event, input: AgentProfileInput) => database.saveAgentProfile(input));
  ipcMain.handle("agent:profile-delete", (_event, id: string) => database.deleteAgentProfile(id));

  ipcMain.handle("task:list", (_event, projectPath?: string | null) => database.listTasks(projectPath));
  ipcMain.handle("task:save", (_event, input: TaskSaveInput) => database.saveTask(input));
  ipcMain.handle("task:plan", (_event, input: TaskPlanInput) => taskAutomationService.planTask(input));
  ipcMain.handle("task:run-due", () => taskAutomationService.runDueTasks());
  ipcMain.handle("task:set-status", (_event, id: string, status: TaskStatus) => database.setTaskStatus(id, status));
  ipcMain.handle("task:remove", (_event, id: string) => database.deleteTask(id));

  ipcMain.handle("workflow:list", () => workflowService.list());
  ipcMain.handle("workflow:get", (_event, workflowId: string) => workflowService.get(workflowId));
  ipcMain.handle("workflow:save", (_event, input: WorkflowSaveInput) => workflowService.save(input));
  ipcMain.handle("workflow:remove", (_event, workflowId: string) => workflowService.remove(workflowId));
  ipcMain.handle("workflow:duplicate", (_event, workflowId: string) => workflowService.duplicate(workflowId));
  ipcMain.handle("workflow:set-status", (_event, workflowId: string, status: WorkflowStatus) =>
    workflowService.setStatus(workflowId, status),
  );
  ipcMain.handle("workflow:toggle-favorite", (_event, workflowId: string) =>
    workflowService.toggleFavorite(workflowId),
  );
  ipcMain.handle("workflow:metrics", () => workflowService.metrics());
  ipcMain.handle("workflow:activity", (_event, limit?: number) => workflowService.activity(limit));
  ipcMain.handle("workflow:runs", (_event, workflowId: string, limit?: number) =>
    workflowService.runs(workflowId, limit),
  );
  ipcMain.handle("workflow:run", (_event, options: WorkflowRunOptions) => workflowService.run(options));
  ipcMain.handle("workflow:cancel", (_event, workflowRunId: string) => workflowService.cancel(workflowRunId));
  ipcMain.handle("workflow:export", (_event, workflowId: string) => workflowService.exportDefinition(workflowId));
  ipcMain.handle("workflow:import", () => workflowService.importDefinition());

  ipcMain.handle("git:diff", (_event, cwd: string) => readGitDiff(cwd));
}
