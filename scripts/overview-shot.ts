/**
 * Overview screenshot harness: boots the real main-process services, loads the
 * built renderer with the real preload bridge, and captures the Overview screen
 * at the reference viewport (1680x945) for visual comparison with
 * `image/overview.png`.
 *
 * Usage: electron .verify/overview-shot.js
 *   AGENTIC_RENDERER_DIR  built renderer directory (index.html inside)
 *   AGENTIC_PRELOAD       path to the built preload bundle
 *   AGENTIC_OUT_DIR       where PNGs are written
 */
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { DesktopDatabase } from "../apps/desktop/src/main/database/desktop-database";
import { registerIpcHandlers } from "../apps/desktop/src/main/ipc/register-ipc";
import { AgentProcessManager } from "../apps/desktop/src/main/processes/agent-process-manager";
import { ProjectService } from "../apps/desktop/src/main/projects/project-service";
import { ProviderSecretVault } from "../apps/desktop/src/main/settings/provider-secret-vault";
import { SettingsService } from "../apps/desktop/src/main/settings/settings-service";
import { TaskAutomationService } from "../apps/desktop/src/main/tasks/task-automation-service";
import { WorkflowService } from "../apps/desktop/src/main/workflows/workflow-service";

const rendererDir = process.env.AGENTIC_RENDERER_DIR ?? "/tmp/agentic-renderer-check";
const preloadPath = process.env.AGENTIC_PRELOAD ?? "/tmp/agentic-shot/preload.js";
const outDir = process.env.AGENTIC_OUT_DIR ?? "/tmp/agentic-shot";
const shotName = process.env.AGENTIC_SHOT_NAME ?? "overview";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  fs.mkdirSync(outDir, { recursive: true });

  const userDataPath = path.join(outDir, "userdata");
  const database = await DesktopDatabase.open(userDataPath);
  let window: BrowserWindow | null = null;
  const manager = new AgentProcessManager(database, () => window?.webContents ?? null);
  const taskAutomationService = new TaskAutomationService(database, manager, () => window?.webContents ?? null);
  const workflowService = new WorkflowService(database, () => window?.webContents ?? null);
  registerIpcHandlers({
    agentProcessManager: manager,
    database,
    projectService: new ProjectService(database),
    settingsService: new SettingsService(database, new ProviderSecretVault(userDataPath)),
    taskAutomationService,
    workflowService,
  });

  window = new BrowserWindow({
    width: 1680,
    height: 945,
    show: false,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
    },
  });

  const logs: string[] = [];
  window.webContents.on("console-message", (event) => {
    const text = typeof event === "object" && event && "message" in event ? String(event.message) : String(event);
    if (/error|warn/i.test(text)) logs.push(text);
  });

  await window.loadFile(path.join(rendererDir, "index.html"));
  await wait(5000);

  const audit = await window.webContents.executeJavaScript(
    `(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
      };
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        scrollHeight: document.documentElement.scrollHeight,
        sidebar: box('.app-sidebar') ?? box('aside'),
        topbar: box('.desktop-topbar') ?? box('header'),
        hero: box('.hero-heading'),
        scene: box('.workspace-scene'),
        rail: box('.analytics-rail'),
        bottom: box('.bottom-grid'),
        canvas: box('canvas'),
        floatingTasks: [...document.querySelectorAll('.floating-task')].length,
        navLabels: [...document.querySelectorAll('.primary-nav button')].map((n) => n.textContent.trim()),
      };
    })()`,
  );
  console.log(`AUDIT ${JSON.stringify(audit, null, 2)}`);

  const image = await window.webContents.capturePage();
  const file = path.join(outDir, `${shotName}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`SHOT ${file}`);

  if (logs.length) console.log(`CONSOLE ${JSON.stringify(logs.slice(0, 12), null, 2)}`);
  console.log("DONE");
  app.exit(0);
}

void main().catch((error) => {
  console.error("HARNESS FAILED", error);
  app.exit(1);
});
