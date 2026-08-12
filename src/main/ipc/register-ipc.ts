import type {
  AgentCliId,
  AgentProfileInput,
  AgentRunInput,
  AppIdentityInput,
  GatewayChatRequest,
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
  fetchGitRemote,
  pullGitRemote,
  pushGitBranch,
  readGitBlame,
  readGitBranches,
  readGitDiff,
  readGitFileDiff,
  readGitLog,
  readGitPushPlan,
  readGitStashDetail,
  readGitStashes,
  readGitTracking,
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
import type { GatewayChatService } from "../gateway/gateway-chat-service";
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

export interface IpcRegistry {
  handle(channel: string, handler: (event: any, ...args: any[]) => any): void;
}

export function registerIpcHandlers(
  registry: IpcRegistry,
  {
    agentProcessManager,
    database,
    knowledgeService,
    projectService,
    settingsService,
    taskAutomationService,
    gatewayUsageService,
    gatewayChatService,
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
    /** Optional: harnesses run without gateway chat routing. */
    gatewayChatService?: GatewayChatService;
    /** Optional: harnesses and tests run without a gateway sidecar. */
    sidecarManager?: SidecarManager;
    webhookCoordinator: WebhookCoordinator;
    workflowSchedulerService: WorkflowSchedulerService;
    workflowService: WorkflowService;
  }
): void {
  registry.handle("system:diagnostics", (_event, projectPath?: string | null) =>
    collectDiagnostics(database, settingsService, projectPath, {
      // Optional so the harnesses, which have no sidecar, keep working unchanged.
      sidecarStatus: sidecarManager?.status(),
      probeSidecarHealth: sidecarManager
        ? (baseUrl) => probeSidecarHealth(baseUrl, sidecarManager.ensureLocalKey())
        : undefined,
    }),
  );

  registry.handle("system:storage", () => database.storageReport());
  registry.handle("system:cleanup-storage", () => database.runMaintenance());

  registry.handle("project:select-folder", () => projectService.selectFolder());
  registry.handle("project:list-recent", () => projectService.listRecent());
  registry.handle("project:remove", (_event, projectPath: string) => projectService.remove(projectPath));

  registry.handle("settings:get-identity", () => settingsService.getIdentity());
  registry.handle("settings:save-identity", (_event, input: AppIdentityInput) => settingsService.saveIdentity(input));
  registry.handle("settings:list-provider-connections", () => settingsService.listProviderConnections());
  registry.handle("settings:save-provider-connection", (_event, input: ProviderConnectionInput) =>
    settingsService.saveProviderConnection(input),
  );
  registry.handle("settings:delete-provider-connection", (_event, id: string) =>
    settingsService.deleteProviderConnection(id),
  );
  registry.handle("settings:verify-provider-connection", (_event, id: string) =>
    settingsService.verifyProviderConnection(id),
  );
  registry.handle("settings:open-provider-site", (_event, input: ProviderConnectionAuthRequest) =>
    settingsService.openProviderSite(input),
  );

  registry.handle("agent:catalog", () => listAgentCatalog());
  registry.handle("agent:ping", (_event, cliId: AgentCliId, commandOverride?: string) =>
    pingAgentCli(cliId, commandOverride),
  );
  registry.handle("agent:ping-all", () => pingAllAgentClis());
  registry.handle("agent:models", (_event, cliId: AgentCliId) => probeAgentModels(cliId));

  registry.handle("agent:start", (_event, input: AgentRunInput) => agentProcessManager.start(input));
  registry.handle("agent:restart", (_event, runId: string) => agentProcessManager.restart(runId));
  registry.handle("agent:stop", (_event, runId: string) => agentProcessManager.stop(runId));
  registry.handle("agent:send", (_event, runId: string, data: string) => agentProcessManager.send(runId, data));
  registry.handle("agent:sessions", () => agentProcessManager.sessions());
  registry.handle("agent:history", () => database.listAgentRuns());
  registry.handle("agent:logs", (_event, runId: string) => database.listTerminalLogs(runId));

  registry.handle("agent:profiles", () => database.listAgentProfiles());
  registry.handle("agent:profile-save", (_event, input: AgentProfileInput) => database.saveAgentProfile(input));
  registry.handle("agent:profile-delete", (_event, id: string) => database.deleteAgentProfile(id));

  registry.handle("task:list", (_event, projectPath?: string | null) => database.listTasks(projectPath));
  registry.handle("task:save", (_event, input: TaskSaveInput) => database.saveTask(input));
  registry.handle("task:plan", (_event, input: TaskPlanInput) => taskAutomationService.planTask(input));
  registry.handle("task:run-due", () => taskAutomationService.runDueTasks());
  registry.handle("task:set-status", (_event, id: string, status: TaskStatus) => database.setTaskStatus(id, status));
  registry.handle("task:retry-now", (_event, id: string) => taskAutomationService.retryTaskNow(id));
  registry.handle("task:remove", (_event, id: string) => database.deleteTask(id));

  registry.handle("workflow:list", () => workflowService.list());
  registry.handle("workflow:get", (_event, workflowId: string) => workflowService.get(workflowId));
  registry.handle("workflow:save", (_event, input: WorkflowSaveInput) => workflowService.save(input));
  registry.handle("workflow:remove", (_event, workflowId: string) => workflowService.remove(workflowId));
  registry.handle("workflow:duplicate", (_event, workflowId: string) => workflowService.duplicate(workflowId));
  registry.handle("workflow:set-status", (_event, workflowId: string, status: WorkflowStatus) =>
    workflowService.setStatus(workflowId, status),
  );
  registry.handle("workflow:toggle-favorite", (_event, workflowId: string) =>
    workflowService.toggleFavorite(workflowId),
  );
  registry.handle("workflow:metrics", () => workflowService.metrics());
  registry.handle("workflow:activity", (_event, limit?: number) => workflowService.activity(limit));
  registry.handle("workflow:runs", (_event, workflowId: string, limit?: number) =>
    workflowService.runs(workflowId, limit),
  );
  registry.handle("workflow:run", (_event, options: WorkflowRunOptions) => workflowService.run(options));
  registry.handle("workflow:run-due", () => workflowSchedulerService.runDueWorkflows());
  registry.handle("workflow:webhook-status", async () => {
    // Sync first: the user may have just enabled a webhook workflow, and opening the
    // panel should show the resulting endpoint rather than the pre-edit state.
    await webhookCoordinator.sync();
    return describeWebhook(webhookCoordinator);
  });
  registry.handle("workflow:rotate-webhook-token", async () => {
    webhookCoordinator.rotateToken();
    // The running listener still holds the old token, so it has to be rebound for
    // the rotation to take effect.
    await webhookCoordinator.stop();
    await webhookCoordinator.sync();
    return describeWebhook(webhookCoordinator);
  });
  registry.handle("workflow:cancel", (_event, workflowRunId: string) => workflowService.cancel(workflowRunId));
  registry.handle("workflow:approve", (_event, workflowRunId: string) => workflowService.approve(workflowRunId));
  registry.handle("workflow:reject", (_event, workflowRunId: string, reason?: string) =>
    workflowService.reject(workflowRunId, reason),
  );
  registry.handle("workflow:export", (_event, workflowId: string) => workflowService.exportDefinition(workflowId));
  registry.handle("workflow:import", () => workflowService.importDefinition());

  // Registered only when the service exists so a harness without it fails loudly
  // on invoke rather than silently resolving undefined into the panel.
  if (gatewayUsageService) {
    registry.handle("gateway:usage-settings", () => gatewayUsageService.getSettings());
    registry.handle("gateway:save-usage-settings", (_event, input: GatewayUsageSettingsInput) =>
      gatewayUsageService.saveSettings(input),
    );
    registry.handle("gateway:usage-snapshot", (_event, days?: number) => gatewayUsageService.getSnapshot(days));
  }

  // Same optionality rule: a harness without chat routing should fail loudly on
  // invoke rather than resolve undefined into a panel that then renders nothing.
  if (gatewayChatService) {
    registry.handle("gateway:chat-targets", () => gatewayChatService.listTargets());
    registry.handle("gateway:chat-send", (_event, request: GatewayChatRequest) =>
      gatewayChatService.sendChat(request),
    );
    registry.handle("gateway:chat-cancel", (_event, requestId: string) => gatewayChatService.cancel(requestId));
  }

  // Renderer-provided paths are untrusted IPC input. Every Git operation — reads
  // included, because file diff/log expose repository contents — is scoped to a
  // folder selected through the native project picker and stored in recent projects.
  const approvedGitCwd = (cwd: string) => projectService.requireApprovedPath(cwd);

  registry.handle("git:diff", (_event, cwd: string) => readGitDiff(approvedGitCwd(cwd)));
  registry.handle("git:file-diff", (_event, cwd: string, filePath: string, staged?: boolean) =>
    readGitFileDiff(approvedGitCwd(cwd), filePath, staged),
  );
  registry.handle("git:log", (_event, cwd: string, limit?: number) => readGitLog(approvedGitCwd(cwd), limit));
  registry.handle("git:stage", (_event, cwd: string, filePath: string) =>
    stageGitFile(approvedGitCwd(cwd), filePath),
  );
  registry.handle("git:unstage", (_event, cwd: string, filePath: string) =>
    unstageGitFile(approvedGitCwd(cwd), filePath),
  );
  registry.handle("git:commit", (_event, cwd: string, message: string) =>
    commitGitChanges(approvedGitCwd(cwd), message),
  );
  registry.handle("git:branches", (_event, cwd: string) => readGitBranches(approvedGitCwd(cwd)));
  registry.handle("git:checkout", (_event, cwd: string, name: string, create?: boolean) =>
    checkoutGitBranch(approvedGitCwd(cwd), name, create),
  );
  registry.handle("git:stashes", (_event, cwd: string) => readGitStashes(approvedGitCwd(cwd)));
  registry.handle("git:stash-detail", (_event, cwd: string, ref: string) =>
    readGitStashDetail(approvedGitCwd(cwd), ref),
  );
  registry.handle("git:stash-push", (_event, cwd: string, message?: string, includeUntracked?: boolean) =>
    createGitStash(approvedGitCwd(cwd), message, includeUntracked),
  );
  registry.handle("git:stash-apply", (_event, cwd: string, ref: string, expectedOid: string, keep?: boolean) =>
    applyGitStash(approvedGitCwd(cwd), ref, expectedOid, keep),
  );
  registry.handle("git:stash-drop", (_event, cwd: string, ref: string, expectedOid: string) =>
    dropGitStash(approvedGitCwd(cwd), ref, expectedOid),
  );

  // Outbound Git. `approvedGitCwd` matters more here than anywhere else in this
  // file: fetch and push contact a network host, so an unapproved path would let
  // the renderer choose which repository's code leaves the machine.
  registry.handle("git:tracking", (_event, cwd: string) => readGitTracking(approvedGitCwd(cwd)));
  registry.handle("git:fetch", (_event, cwd: string, remote?: string) =>
    fetchGitRemote(approvedGitCwd(cwd), remote),
  );
  registry.handle("git:pull", (_event, cwd: string, remote?: string) =>
    pullGitRemote(approvedGitCwd(cwd), remote),
  );
  registry.handle("git:push-plan", (_event, cwd: string, remote?: string) =>
    readGitPushPlan(approvedGitCwd(cwd), remote),
  );
  registry.handle(
    "git:push",
    (_event, cwd: string, options?: { remote?: string; allowProtected?: boolean; expectedBranch?: string }) =>
      pushGitBranch(approvedGitCwd(cwd), options ?? {}),
  );
  registry.handle("git:blame", (_event, cwd: string, filePath: string) =>
    readGitBlame(approvedGitCwd(cwd), filePath),
  );

  registry.handle("knowledge:get", (_event, projectPath: string) => knowledgeService.get(projectPath));
  registry.handle("knowledge:scan", (_event, input: KnowledgeScanInput) => knowledgeService.scan(input));
  registry.handle("knowledge:cancel", (_event, scanId: string) => knowledgeService.cancelScan(scanId));
  registry.handle("knowledge:search", (_event, input: KnowledgeSearchInput) => knowledgeService.search(input));
  registry.handle("knowledge:export", (_event, projectPath: string, format: KnowledgeExportFormat) =>
    knowledgeService.export(projectPath, format),
  );
}
