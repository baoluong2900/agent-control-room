/**
 * Screenshot harness: boots the real main-process services, loads the built
 * renderer with the real preload bridge, navigates to Agents, and captures PNGs.
 *
 * Usage: npx electron /tmp/agentic-shot/screenshot-harness.js
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
  await wait(2500);

  const clickNav = async (label: string) => {
    const ok = await window!.webContents.executeJavaScript(
      `(() => {
        const button = [...document.querySelectorAll('.primary-nav button')]
          .find((node) => node.textContent.trim().startsWith(${JSON.stringify(label)}));
        if (!button) return false;
        button.click();
        return true;
      })()`,
    );
    return Boolean(ok);
  };

  const capture = async (name: string) => {
    const image = await window!.webContents.capturePage();
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    console.log(`SHOT ${file}`);
  };

  const targetNav = process.env.AGENTIC_SNAPSHOT_NAV ?? "Agents";
  const navigated = await clickNav(targetNav);
  console.log(`NAV ${targetNav}=${navigated}`);
  await wait(3500);

  if (targetNav === "Settings") {
    const settingsAudit = await window.webContents.executeJavaScript(
      `(() => ({
        page: !!document.querySelector('.settings-page'),
        title: document.querySelector('.settings-hero h1')?.textContent ?? null,
        providerCards: [...document.querySelectorAll('.provider-card')].map((node) => node.querySelector('strong')?.textContent ?? ''),
        stats: [...document.querySelectorAll('.settings-stat')].map((node) => node.textContent.trim()),
      }))()`,
    );
    console.log(`SETTINGS ${JSON.stringify(settingsAudit, null, 2)}`);
    await capture("settings-page");
    if (logs.length) console.log(`CONSOLE ${JSON.stringify(logs.slice(0, 10), null, 2)}`);
    console.log("DONE");
    app.exit(0);
    return;
  }

  const audit = await window.webContents.executeJavaScript(
    `(() => {
      const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
      return {
        title: text('.agents-head h1'),
        subtitle: text('.agents-head p'),
        statPills: [...document.querySelectorAll('.stat-pill')].map((node) => node.textContent.trim()),
        fleetNodes: [...document.querySelectorAll('.fleet-column li')].map((node) => ({
          label: node.querySelector('strong')?.textContent ?? '',
          online: node.classList.contains('online'),
          detail: node.querySelector('small')?.textContent ?? '',
        })),
        tabs: [...document.querySelectorAll('.agents-tabs button')].map((node) => node.textContent.trim()),
        quickStarts: [...document.querySelectorAll('.quick-starts button strong')].map((node) => node.textContent),
        railCards: [...document.querySelectorAll('.rail-card h2')].map((node) => node.textContent),
        viewSwitch: [...document.querySelectorAll('.view-switch button')].map((node) => node.textContent.trim()),
        newAgentButton: !!document.querySelector('.agents-head-actions .primary-action'),
      };
    })()`,
  );
  console.log(`AUDIT ${JSON.stringify(audit, null, 2)}`);
  await capture("agents-page");

  // Open the New Agent modal and audit CLI + model pickers.
  await window.webContents.executeJavaScript(
    `document.querySelector('.agents-head-actions .primary-action').click()`,
  );
  await wait(2500);
  const modalAudit = await window.webContents.executeJavaScript(
    `(() => ({
      open: !!document.querySelector('.agent-modal'),
      clis: [...document.querySelectorAll('.cli-option')].map((node) => ({
        name: node.querySelector('strong')?.textContent ?? '',
        state: node.querySelector('.cli-state')?.textContent?.trim() ?? '',
        selected: node.classList.contains('selected'),
      })),
      models: [...document.querySelectorAll('.model-chip strong')].map((node) => node.textContent),
      pingLine: document.querySelector('.ping-line')?.textContent?.trim() ?? null,
      preview: document.querySelector('.preview-command code')?.textContent ?? null,
    }))()`,
  );
  console.log(`MODAL ${JSON.stringify(modalAudit, null, 2)}`);
  await capture("agents-new-modal");

  // Switch the CLI selection to Claude Code and re-check the model list + preview.
  await window.webContents.executeJavaScript(
    `(() => {
      const option = [...document.querySelectorAll('.cli-option')]
        .find((node) => node.textContent.includes('Claude Code'));
      option?.click();
      return true;
    })()`,
  );
  await wait(1800);
  const switched = await window.webContents.executeJavaScript(
    `(() => ({
      selected: document.querySelector('.cli-option.selected strong')?.textContent ?? null,
      models: [...document.querySelectorAll('.model-chip strong')].map((node) => node.textContent),
      preview: document.querySelector('.preview-command code')?.textContent ?? null,
    }))()`,
  );
  console.log(`SWITCH ${JSON.stringify(switched)}`);
  await capture("agents-model-picker");

  if (logs.length) console.log(`CONSOLE ${JSON.stringify(logs.slice(0, 10), null, 2)}`);
  console.log("DONE");
  app.exit(0);
}

void main().catch((error) => {
  console.error("HARNESS FAILED", error);
  app.exit(1);
});
