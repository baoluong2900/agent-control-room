/**
 * Task navigation UI harness: boots the real desktop renderer, clicks Agents,
 * then Tasks, and verifies both modules stay inside the AgenticOS shell.
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
const preloadPath = process.env.AGENTIC_PRELOAD ?? "/tmp/agentic-task-nav/preload.js";
const outDir = process.env.AGENTIC_OUT_DIR ?? "/tmp/agentic-task-nav";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const helpers = `
  const byNavLabel = (label) =>
    [...document.querySelectorAll('.primary-nav button')]
      .find((node) => node.querySelector('span')?.textContent?.trim() === label);
`;

async function main() {
  await app.whenReady();
  fs.mkdirSync(outDir, { recursive: true });

  const userDataPath = path.join(outDir, "userdata-task-nav");
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
    width: 1440,
    height: 900,
    show: false,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath, sandbox: true },
  });

  const pageErrors: string[] = [];
  window.webContents.on("console-message", (event: unknown) => {
    const message = (event as { message?: string; level?: string })?.message ?? String(event);
    const level = (event as { level?: string })?.level ?? "";
    if (level === "error" || /Uncaught|TypeError|is not a function/.test(message)) pageErrors.push(message);
  });

  const run = async <T,>(script: string): Promise<T> => {
    const wrapped = `(() => {${helpers}
      try {
        return { ok: true, value: (() => {${script}})() };
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) };
      }
    })()`;
    const result = (await window!.webContents.executeJavaScript(wrapped)) as
      | { ok: true; value: T }
      | { ok: false; message: string };
    if (!result || result.ok !== true) {
      throw new Error(`step failed: ${result?.message ?? "no result"}\n--- script ---\n${script.trim().slice(0, 400)}`);
    }
    return result.value;
  };

  const waitFor = async (label: string, expression: string, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ready = (await window!.webContents.executeJavaScript(
        `(() => {${helpers}
          try { return !!(${expression}); } catch { return false; }
        })()`,
      )) as boolean;
      if (ready) return;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
      await wait(100);
    }
  };

  await window.loadFile(path.join(rendererDir, "index.html"));
  await waitFor("app shell mounted", `byNavLabel('Agents')`);

  await run(`byNavLabel('Agents').click(); return true;`);
  await waitFor("agents rendered inside AgenticOS", `document.querySelector('.agents-page') && !document.querySelector('.app-shell-agents')`);

  await run(`byNavLabel('Tasks').click(); return true;`);
  await waitFor("tasks page rendered", `document.querySelector('.tasks-page h1')?.textContent === 'Tasks'`);

  const audit = await run<Record<string, unknown>>(`
    const navLabels = [...document.querySelectorAll('.primary-nav button span')].map((node) => node.textContent.trim());
    return {
      title: document.querySelector('.tasks-page h1')?.textContent ?? null,
      brand: document.querySelector('.brand-name')?.textContent ?? null,
      appShellPlatform: Boolean(document.querySelector('main.app-shell-agents')),
      dashboardPlatform: Boolean(document.querySelector('.dashboard.dashboard-agents')),
      topbarVisible: Boolean(document.querySelector('.topbar')),
      sidebarStatus: Boolean(document.querySelector('.active-agents-card')),
      activeNav: document.querySelector('.primary-nav button.active span')?.textContent?.trim() ?? null,
      navLabels,
      agentDeck: Boolean(document.querySelector('.task-agent-command')),
      agentSlots: [...document.querySelectorAll('.agent-slot')].map((node) => ({
        name: node.querySelector('.agent-slot-copy strong')?.textContent?.trim() ?? '',
        loadout: node.querySelector('.agent-slot-loadout')?.textContent?.trim() ?? '',
      })),
      modelHeader: document.querySelector('.task-model-overview h2')?.textContent?.trim() ?? null,
      modelRows: [...document.querySelectorAll('.task-model-row')].map((node) => node.textContent?.trim() ?? ''),
    };
  `);

  check("tasks route rendered", audit.title === "Tasks", JSON.stringify(audit));
  check("tasks uses AgenticOS brand", audit.brand === "AgenticOS", String(audit.brand));
  check("platform app shell is removed", audit.appShellPlatform === false && audit.dashboardPlatform === false);
  check("desktop topbar is visible on task surface", audit.topbarVisible === true);
  check("AgenticOS active agents card remains visible", audit.sidebarStatus === true);
  check("tasks nav item is active", audit.activeNav === "Tasks", String(audit.activeNav));
  check(
    "AgenticOS nav keeps Tasks next to Agents",
    Array.isArray(audit.navLabels) &&
      audit.navLabels.indexOf("Tasks") >= 0 &&
      audit.navLabels.indexOf("Agents") >= 0 &&
      audit.navLabels.indexOf("Tasks") < audit.navLabels.indexOf("Agents"),
    JSON.stringify(audit.navLabels),
  );
  check(
    "tasks renders agent deck",
    audit.agentDeck === true && Array.isArray(audit.agentSlots) && audit.agentSlots.length >= 6,
    JSON.stringify(audit.agentSlots),
  );
  check(
    "tasks renders model loadouts",
    audit.modelHeader === "Overview Models Working" && Array.isArray(audit.modelRows) && audit.modelRows.length >= 4,
    JSON.stringify({ header: audit.modelHeader, rows: audit.modelRows }),
  );

  await wait(750);
  const image = await window.webContents.capturePage();
  const shotFile = path.join(outDir, "tasks-page.png");
  fs.writeFileSync(shotFile, image.toPNG());
  console.log(`SHOT ${shotFile}`);

  if (pageErrors.length) console.log(`PAGE_ERRORS ${JSON.stringify(pageErrors.slice(0, 6), null, 2)}`);
  check("no renderer errors", pageErrors.length === 0, `${pageErrors.length} errors`);

  database.close();
  console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  app.exit(failures.length === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error("HARNESS FAILED", error);
  app.exit(1);
});
