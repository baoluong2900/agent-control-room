import { app, BrowserWindow, safeStorage, shell } from "electron";
import { writeFile } from "node:fs/promises";
import { ensureAgentPath } from "./agents/path-env";
import { DesktopDatabase } from "./database/desktop-database";
import { registerIpcHandlers } from "./ipc/register-ipc";
import { AgentProcessManager } from "./processes/agent-process-manager";
import { ProjectService } from "./projects/project-service";
import { ProviderSecretVault } from "./settings/provider-secret-vault";
import { SettingsService } from "./settings/settings-service";
import { KnowledgeService } from "./knowledge/knowledge-service";
import { TaskAutomationService } from "./tasks/task-automation-service";
import { WorkflowSchedulerService } from "./workflows/workflow-scheduler";
import { WorkflowService } from "./workflows/workflow-service";
import { createMainWindow } from "./windows/main-window";

let mainWindow: BrowserWindow | null = null;
let database: DesktopDatabase | null = null;
let processManager: AgentProcessManager | null = null;
let taskAutomationService: TaskAutomationService | null = null;
let workflowSchedulerService: WorkflowSchedulerService | null = null;

/**
 * The schedulers keep ticking after the last window closes (macOS keeps the app
 * alive), so every emit has to go through a window that is still alive. Sending
 * to a destroyed webContents throws from inside the timer.
 */
function activeWebContents(): Electron.WebContents | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  return mainWindow.webContents;
}

/** Tracks window death so `activeWebContents` stops handing out a dead target. */
function trackWindow(window: BrowserWindow): BrowserWindow {
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

if (require("electron-squirrel-startup")) {
  app.quit();
}

app.whenReady().then(async () => {
  // Launching from Finder/Dock gives Electron a bare PATH, so agent CLIs
  // installed under ~/.local/bin or Homebrew resolve to nothing. Repair the
  // env before anything probes or spawns a CLI.
  ensureAgentPath();

  database = await DesktopDatabase.open(app.getPath("userData"));

  const providerSecretVault = new ProviderSecretVault(app.getPath("userData"), safeStorage);
  const agentProcessManager = new AgentProcessManager(database, activeWebContents, providerSecretVault);
  processManager = agentProcessManager;
  const projectService = new ProjectService(database);
  const settingsService = new SettingsService(database, providerSecretVault, shell);
  const knowledgeService = new KnowledgeService(database);
  const workflowService = new WorkflowService(database, activeWebContents, providerSecretVault);
  taskAutomationService = new TaskAutomationService(database, agentProcessManager, activeWebContents);
  workflowSchedulerService = new WorkflowSchedulerService(workflowService, activeWebContents);

  registerIpcHandlers({
    agentProcessManager,
    database,
    knowledgeService,
    projectService,
    settingsService,
    taskAutomationService,
    workflowSchedulerService,
    workflowService,
  });

  mainWindow = trackWindow(createMainWindow());
  taskAutomationService.start();
  workflowSchedulerService.start();

  // Dev-only visual QA hook: AGENTIC_SNAPSHOT=<path> writes one PNG of the
  // rendered window, then quits. Never runs in packaged builds.
  if (!app.isPackaged && process.env.AGENTIC_SNAPSHOT) {
    const target = process.env.AGENTIC_SNAPSHOT;
    const window = mainWindow;
    window.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const nav = process.env.AGENTIC_SNAPSHOT_NAV;
          if (nav) {
            await window.webContents.executeJavaScript(
              `(() => {
                 const target = ${JSON.stringify(nav)};
                 const button = Array.from(document.querySelectorAll("nav button, .sidebar button"))
                   .find((element) => element.textContent?.trim().startsWith(target));
                 button?.click();
                 return Boolean(button);
               })()`,
            );
            await new Promise((resolve) => setTimeout(resolve, 4000));
          }

          const image = await window.webContents.capturePage();
          await writeFile(target, image.toPNG());
        } catch (error) {
          console.error("snapshot failed", error);
        } finally {
          app.quit();
        }
      }, Number(process.env.AGENTIC_SNAPSHOT_DELAY ?? 6000));
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = trackWindow(createMainWindow());
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  taskAutomationService?.stop();
  workflowSchedulerService?.stop();
  processManager?.stopAll();
  database?.close();
});
