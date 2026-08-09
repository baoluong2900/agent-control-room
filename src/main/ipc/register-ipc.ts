import { ipcMain } from "electron";
import type {
  AgentCliId,
  AgentProfileInput,
  AgentRunInput,
  AppIdentityInput,
  GatewayUsageSettingsInput,
  ProviderConnectionAuthRequest,
  ProviderConnectionInput,
  KnowledgeExportFormat,
  KnowledgeScanInput,
  KnowledgeSearchInput,
  TaskPlanInput,
  TaskSaveInput,
  TaskStatus,
  WorkflowRunOptions,
  WebhookEndpointStatus,
  WorkflowSaveInput,
  WorkflowStatus,
} from "@contracts";
import { listAgentCatalog } from "../agents/catalog";
import { pingAgentCli, pingAllAgentClis, probeAgentModels } from "../agents/probe";
import type { DesktopDatabase } from "../database/desktop-database";
import {
  applyGitStash,
  checkoutGitBranch,
  commitGitChanges,
  createGitStash,
  dropGitStash,
  readGitBranches,
  readGitDiff,
  readGitFileDiff,
  readGitLog,
  readGitStashDetail,
  readGitStashes,
  stageGitFile,
  unstageGitFile,
} from "../git/git-service";
import type { KnowledgeService } from "../knowledge/knowledge-service";
import { AgentProcessManager } from "../processes/agent-process-manager";
import { ProjectService } from "../projects/project-service";
import type { SettingsService } from "../settings/settings-service";
import type { TaskAutomationService } from "../tasks/task-automation-service";
import type { WebhookCoordinator } from "../workflows/webhook-coordinator";
import type { WorkflowSchedulerService } from "../workflows/workflow-scheduler";
import type { WorkflowService } from "../workflows/workflow-service";
import { type SidecarManager, probeSidecarHealth } from "../gateway/sidecar-manager";
import type { GatewayUsageService } from "../gateway/gateway-usage-service";
import { collectDiagnostics } from "./diagnostics";

/**
 * Listener status plus the token the user needs to configure a sender.
 *
 * The token is only minted when it is actually going to be shown; asking for status
 * should not create a credential as a side effect if the feature is unused.
 */
function describeWebhook(coordinator: WebhookCoordinator): WebhookEndpointStatus {
  const status = coordinator.status();
  return { ...status, token: status.running ? coordinator.ensureToken() : null };
}

export function registerIpcHandlers({
  agentProcessManager,
  database,
  knowledgeService,
  projectService,
  settingsService,
  taskAutomationService,
  gatewayUsageService,
  sidecarManager,
  webhookCoordinator,
  workflowSchedulerService,
  workflowService,
}: {
  agentProcessManager: AgentProcessManager;
  database: DesktopDatabase;
  knowledgeService: KnowledgeService;
  projectService: ProjectService;
  settingsService: SettingsService;
  taskAutomationService: TaskAutomationService;
  /** Optional: harnesses run without the Pool API dashboard wiring. */
  gatewayUsageService?: GatewayUsageService;
  /** Optional: harnesses and tests run without a gateway sidecar. */
  sidecarManager?: SidecarManager;
  webhookCoordinator: WebhookCoordinator;
  workflowSchedulerService: WorkflowSchedulerService;
  workflowService: WorkflowService;
}): void {
  ipcMain.handle("system:diagnostics", (_event, projectPath?: string | null) =>
    collectDiagnostics(database, settingsService, projectPath, {
      // Optional so the harnesses, which have no sidecar, keep working unchanged.
      sidecarStatus: sidecarManager?.status(),
      probeSidecarHealth: sidecarManager
        ? (baseUrl) => probeSidecarHealth(baseUrl, sidecarManager.ensureLocalKey())
        : undefined,
    }),
  );

  ipcMain.handle("system:storage", () => database.storageReport());
  ipcMain.handle("system:cleanup-storage", () => database.runMaintenance());

  ipcMain.handle("project:select-folder", () => projectService.selectFolder());
  ipcMain.handle("project:list-recent", () => projectService.listRecent());
  ipcMain.handle("project:remove", (_event, projectPath: string) => projectService.remove(projectPath));

  ipcMain.handle("settings:get-identity", () => settingsService.getIdentity());
  ipcMain.handle("settings:save-identity", (_event, input: AppIdentityInput) => settingsService.saveIdentity(input));
  ipcMain.handle("settings:list-provider-connections", () => settingsService.listProviderConnections());
  ipcMain.handle("settings:save-provider-connection", (_event, input: ProviderConnectionInput) =>
    settingsService.saveProviderConnection(input),
  );
  ipcMain.handle("settings:delete-provider-connection", (_event, id: string) =>
    settingsService.deleteProviderConnection(id),
  );
  ipcMain.handle("settings:verify-provider-connection", (_event, id: string) =>
    settingsService.verifyProviderConnection(id),
  );
  ipcMain.handle("settings:open-provider-site", (_event, input: ProviderConnectionAuthRequest) =>
    settingsService.openProviderSite(input),
  );

  ipcMain.handle("agent:catalog", () => listAgentCatalog());
  ipcMain.handle("agent:ping", (_event, cliId: AgentCliId, commandOverride?: string) =>
    pingAgentCli(cliId, commandOverride),
  );
  ipcMain.handle("agent:ping-all", () => pingAllAgentClis());
  ipcMain.handle("agent:models", (_event, cliId: AgentCliId) => probeAgentModels(cliId));

  ipcMain.handle("agent:start", (_event, input: AgentRunInput) => agentProcessManager.start(input));
  ipcMain.handle("agent:restart", (_event, runId: string) => agentProcessManager.restart(runId));
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
  ipcMain.handle("task:retry-now", (_event, id: string) => taskAutomationService.retryTaskNow(id));
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
  ipcMain.handle("workflow:run-due", () => workflowSchedulerService.runDueWorkflows());
  ipcMain.handle("workflow:webhook-status", async () => {
    // Sync first: the user may have just enabled a webhook workflow, and opening the
    // panel should show the resulting endpoint rather than the pre-edit state.
    await webhookCoordinator.sync();
    return describeWebhook(webhookCoordinator);
  });
  ipcMain.handle("workflow:rotate-webhook-token", async () => {
    webhookCoordinator.rotateToken();
    // The running listener still holds the old token, so it has to be rebound for
    // the rotation to take effect.
    await webhookCoordinator.stop();
    await webhookCoordinator.sync();
    return describeWebhook(webhookCoordinator);
  });
  ipcMain.handle("workflow:cancel", (_event, workflowRunId: string) => workflowService.cancel(workflowRunId));
  ipcMain.handle("workflow:approve", (_event, workflowRunId: string) => workflowService.approve(workflowRunId));
  ipcMain.handle("workflow:reject", (_event, workflowRunId: string, reason?: string) =>
    workflowService.reject(workflowRunId, reason),
  );
  ipcMain.handle("workflow:export", (_event, workflowId: string) => workflowService.exportDefinition(workflowId));
  ipcMain.handle("workflow:import", () => workflowService.importDefinition());

  // Registered only when the service exists so a harness without it fails loudly
  // on invoke rather than silently resolving undefined into the panel.
  if (gatewayUsageService) {
    ipcMain.handle("gateway:usage-settings", () => gatewayUsageService.getSettings());
    ipcMain.handle("gateway:save-usage-settings", (_event, input: GatewayUsageSettingsInput) =>
      gatewayUsageService.saveSettings(input),
    );
    ipcMain.handle("gateway:usage-snapshot", (_event, days?: number) => gatewayUsageService.getSnapshot(days));
  }

  // Renderer-provided paths are untrusted IPC input. Every Git operation — reads
  // included, because file diff/log expose repository contents — is scoped to a
  // folder selected through the native project picker and stored in recent projects.
  const approvedGitCwd = (cwd: string) => projectService.requireApprovedPath(cwd);

  ipcMain.handle("git:diff", (_event, cwd: string) => readGitDiff(approvedGitCwd(cwd)));
  ipcMain.handle("git:file-diff", (_event, cwd: string, filePath: string, staged?: boolean) =>
    readGitFileDiff(approvedGitCwd(cwd), filePath, staged),
  );
  ipcMain.handle("git:log", (_event, cwd: string, limit?: number) => readGitLog(approvedGitCwd(cwd), limit));
  ipcMain.handle("git:stage", (_event, cwd: string, filePath: string) =>
    stageGitFile(approvedGitCwd(cwd), filePath),
  );
  ipcMain.handle("git:unstage", (_event, cwd: string, filePath: string) =>
    unstageGitFile(approvedGitCwd(cwd), filePath),
  );
  ipcMain.handle("git:commit", (_event, cwd: string, message: string) =>
    commitGitChanges(approvedGitCwd(cwd), message),
  );
  ipcMain.handle("git:branches", (_event, cwd: string) => readGitBranches(approvedGitCwd(cwd)));
  ipcMain.handle("git:checkout", (_event, cwd: string, name: string, create?: boolean) =>
    checkoutGitBranch(approvedGitCwd(cwd), name, create),
  );
  ipcMain.handle("git:stashes", (_event, cwd: string) => readGitStashes(approvedGitCwd(cwd)));
  ipcMain.handle("git:stash-detail", (_event, cwd: string, ref: string) =>
    readGitStashDetail(approvedGitCwd(cwd), ref),
  );
  ipcMain.handle("git:stash-push", (_event, cwd: string, message?: string, includeUntracked?: boolean) =>
    createGitStash(approvedGitCwd(cwd), message, includeUntracked),
  );
  ipcMain.handle("git:stash-apply", (_event, cwd: string, ref: string, expectedOid: string, keep?: boolean) =>
    applyGitStash(approvedGitCwd(cwd), ref, expectedOid, keep),
  );
  ipcMain.handle("git:stash-drop", (_event, cwd: string, ref: string, expectedOid: string) =>
    dropGitStash(approvedGitCwd(cwd), ref, expectedOid),
  );

  ipcMain.handle("knowledge:get", (_event, projectPath: string) => knowledgeService.get(projectPath));
  ipcMain.handle("knowledge:scan", (_event, input: KnowledgeScanInput) => knowledgeService.scan(input));
  ipcMain.handle("knowledge:cancel", (_event, scanId: string) => knowledgeService.cancelScan(scanId));
  ipcMain.handle("knowledge:search", (_event, input: KnowledgeSearchInput) => knowledgeService.search(input));
  ipcMain.handle("knowledge:export", (_event, projectPath: string, format: KnowledgeExportFormat) =>
    knowledgeService.export(projectPath, format),
  );
}
