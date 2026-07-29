import { app, BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { DesktopDatabase } from "./database/desktop-database";
import { registerIpcHandlers } from "./ipc/register-ipc";
import { AgentProcessManager } from "./processes/agent-process-manager";
import { ProjectService } from "./projects/project-service";
import { ProviderSecretVault } from "./settings/provider-secret-vault";
import { SettingsService } from "./settings/settings-service";
import { TaskAutomationService } from "./tasks/task-automation-service";
import { WorkflowService } from "./workflows/workflow-service";
import { createMainWindow } from "./windows/main-window";

let mainWindow: BrowserWindow | null = null;
let database: DesktopDatabase | null = null;
let processManager: AgentProcessManager | null = null;
let taskAutomationService: TaskAutomationService | null = null;

if (require("electron-squirrel-startup")) {
  app.quit();
}

app.whenReady().then(async () => {
  database = await DesktopDatabase.open(app.getPath("userData"));

  const agentProcessManager = new AgentProcessManager(database, () => mainWindow?.webContents ?? null);
  processManager = agentProcessManager;
  const projectService = new ProjectService(database);
  const settingsService = new SettingsService(database, new ProviderSecretVault(app.getPath("userData")));
  const workflowService = new WorkflowService(database, () => mainWindow?.webContents ?? null);
  taskAutomationService = new TaskAutomationService(database, agentProcessManager, () => mainWindow?.webContents ?? null);

  registerIpcHandlers({
    agentProcessManager,
    database,
    projectService,
    settingsService,
    taskAutomationService,
    workflowService,
  });

  mainWindow = createMainWindow();
  taskAutomationService.start();

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
      mainWindow = createMainWindow();
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
  processManager?.stopAll();
  database?.close();
});
