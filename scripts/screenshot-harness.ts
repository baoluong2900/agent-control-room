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
import { DesktopDatabase } from "../src/main/database/desktop-database";
import { registerIpcHandlers } from "../src/main/ipc/register-ipc";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager";
import { ProjectService } from "../src/main/projects/project-service";
import { ProviderSecretVault } from "../src/main/settings/provider-secret-vault";
import { SettingsService } from "../src/main/settings/settings-service";
import { KnowledgeService } from "../src/main/knowledge/knowledge-service";
import { TaskAutomationService } from "../src/main/tasks/task-automation-service";
import { WorkflowSchedulerService } from "../src/main/workflows/workflow-scheduler";
import { WorkflowService } from "../src/main/workflows/workflow-service";

const rendererDir = process.env.AGENTIC_RENDERER_DIR ?? "/tmp/agentic-renderer-check";
const preloadPath = process.env.AGENTIC_PRELOAD ?? "/tmp/agentic-shot/preload.js";
const outDir = process.env.AGENTIC_OUT_DIR ?? "/tmp/agentic-shot";
const authSmoke = process.env.AGENTIC_AUTH_SMOKE === "1";
const profileLogoutSmoke = process.env.AGENTIC_PROFILE_LOGOUT_SMOKE === "1";
const skipSeedSignedIn = process.env.AGENTIC_SKIP_SEED_SIGNIN === "1";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stand-in for Electron's `safeStorage`. NOT encryption — it only base64-wraps
 * the value so the vault has a working backend in dev harnesses, which run
 * without an OS keychain session. Never use outside these scripts.
 */
const harnessSecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText: string) => Buffer.from(plainText, "utf8"),
  decryptString: (cipherText: Buffer) => cipherText.toString("utf8"),
};

async function main() {
  await app.whenReady();
  fs.mkdirSync(outDir, { recursive: true });

  const userDataPath = path.join(outDir, "userdata");
  const database = await DesktopDatabase.open(userDataPath);
  let window: BrowserWindow | null = null;
  const manager = new AgentProcessManager(database, () => window?.webContents ?? null);
  const taskAutomationService = new TaskAutomationService(database, manager, () => window?.webContents ?? null);
  const workflowService = new WorkflowService(database, () => window?.webContents ?? null);
  const workflowSchedulerService = new WorkflowSchedulerService(workflowService, () => window?.webContents ?? null);
  registerIpcHandlers({
    agentProcessManager: manager,
    database,
    knowledgeService: new KnowledgeService(database),
    projectService: new ProjectService(database),
    // Harness never opens a real browser window.
    settingsService: new SettingsService(database, new ProviderSecretVault(userDataPath, harnessSecretStorage), {
      openExternal: async () => {},
    }),
    taskAutomationService,
    workflowSchedulerService,
    workflowService,
  });

  if (!skipSeedSignedIn) {
    await database.saveAppIdentity({
      displayName: "Local Workspace",
      email: "owner@agentic.local",
      loginMethod: "email",
      status: "signed-in",
    });
  }

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

  if (profileLogoutSmoke) {
    const opened = await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('.user-profile');
        button?.click();
        return Boolean(button);
      })()`,
    );
    await wait(800);
    const menuAudit = await window.webContents.executeJavaScript(
      `(() => ({
        opened: !!document.querySelector('.profile-popover'),
        signOut: [...document.querySelectorAll('.profile-popover button')]
          .find((node) => node.textContent?.includes('Sign out'))?.textContent?.trim() ?? null,
        settings: [...document.querySelectorAll('.profile-popover button')]
          .find((node) => node.textContent?.includes('Account settings'))?.textContent?.trim() ?? null,
      }))()`,
    );
    console.log(`PROFILE_MENU ${JSON.stringify(menuAudit, null, 2)}`);
    const signedOut = await window.webContents.executeJavaScript(
      `(() => {
        const button = [...document.querySelectorAll('.profile-popover button')]
          .find((node) => node.textContent?.includes('Sign out'));
        button?.click();
        return Boolean(button);
      })()`,
    );
    console.log(`PROFILE_SIGNOUT_CLICK ${signedOut}`);
    await wait(2000);
    const afterAudit = await window.webContents.executeJavaScript(
      `(() => ({
        authPage: !!document.querySelector('.settings-page.auth-only'),
        title: document.querySelector('.settings-hero h1')?.textContent ?? null,
        shell: !!document.querySelector('.app-shell'),
      }))()`,
    );
    console.log(`PROFILE_AFTER ${JSON.stringify(afterAudit, null, 2)}`);
    if (!opened || !menuAudit.opened || !menuAudit.signOut || !signedOut || !afterAudit.authPage || afterAudit.shell) {
      throw new Error("profile logout smoke failed");
    }
    const image = await window.webContents.capturePage();
    const file = path.join(outDir, "profile-logout-smoke.png");
    fs.writeFileSync(file, image.toPNG());
    console.log(`SHOT ${file}`);
    if (logs.length) console.log(`CONSOLE ${JSON.stringify(logs.slice(0, 12), null, 2)}`);
    console.log("DONE");
    app.exit(0);
    return;
  }

  if (authSmoke) {
    const authAudit = await window.webContents.executeJavaScript(
      `(() => ({
        authPage: !!document.querySelector('.settings-page.auth-only'),
        title: document.querySelector('.settings-hero h1')?.textContent ?? null,
        signInButton: [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Sign in'))?.textContent?.trim() ?? null,
      }))()`,
    );
    console.log(`AUTH ${JSON.stringify(authAudit, null, 2)}`);
    const clicked = await window.webContents.executeJavaScript(
      `(() => {
        const button = [...document.querySelectorAll('button')]
          .find((node) => node.textContent?.trim().includes('Sign in'));
        button?.click();
        return Boolean(button);
      })()`,
    );
    console.log(`AUTH_CLICK ${clicked}`);
    await wait(2000);
    const signedInAudit = await window.webContents.executeJavaScript(
      `(() => ({
        shell: !!document.querySelector('.app-shell'),
        authPage: !!document.querySelector('.settings-page.auth-only'),
        sidebar: !!document.querySelector('.sidebar'),
        settingsPage: !!document.querySelector('.settings-page'),
      }))()`,
    );
    console.log(`AUTH_AFTER ${JSON.stringify(signedInAudit, null, 2)}`);
    if (!clicked || !signedInAudit.shell || signedInAudit.authPage || !signedInAudit.sidebar) {
      throw new Error("auth smoke failed");
    }
    const image = await window.webContents.capturePage();
    const file = path.join(outDir, "auth-smoke.png");
    fs.writeFileSync(file, image.toPNG());
    console.log(`SHOT ${file}`);
    if (logs.length) console.log(`CONSOLE ${JSON.stringify(logs.slice(0, 12), null, 2)}`);
    console.log("DONE");
    app.exit(0);
    return;
  }

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

  if (targetNav !== "Agents") {
    const routeAudit = await window.webContents.executeJavaScript(
      `(() => ({
        activeNav: document.querySelector('.primary-nav button.active span')?.textContent?.trim() ?? null,
        title: document.querySelector('main h1, .dashboard h1')?.textContent?.trim() ?? null,
        page:
          document.querySelector('.analytics-page') ? 'analytics'
          : document.querySelector('.integrations-page') ? 'integrations'
          : document.querySelector('.projects-page') ? 'projects'
          : document.querySelector('.tasks-page') ? 'tasks'
          : document.querySelector('.knowledge-page') ? 'knowledge'
          : document.querySelector('.wf-page') ? 'workflows'
          : 'unknown',
        navLabels: [...document.querySelectorAll('.primary-nav button span')].map((node) => node.textContent.trim()),
        panels: document.querySelectorAll('.analytics-panel, .integrations-panel, .projects-list-panel, .tasks-board, .knowledge-layout, .wf-panel').length,
      }))()`,
    );
    console.log(`ROUTE ${JSON.stringify(routeAudit, null, 2)}`);
    await capture(`${targetNav.toLowerCase()}-page`);
    if (logs.length) console.log(`CONSOLE ${JSON.stringify(logs.slice(0, 10), null, 2)}`);
    if (routeAudit.activeNav !== targetNav || routeAudit.page === "unknown") {
      throw new Error(`${targetNav} route smoke failed`);
    }
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
        robotArena: !!document.querySelector('.agent-robot-arena canvas'),
        robotCanvas: {
          width: document.querySelector('.agent-robot-arena canvas')?.clientWidth ?? 0,
          height: document.querySelector('.agent-robot-arena canvas')?.clientHeight ?? 0,
        },
        robotLabels: [...document.querySelectorAll('.robot-nameplate')].map((node) => node.textContent.trim()),
        tabs: [...document.querySelectorAll('.agents-tabs button')].map((node) => node.textContent.trim()),
        quickStarts: [...document.querySelectorAll('.reference-agent-card .reference-agent-copy strong')].map((node) => node.textContent),
        railCards: [...document.querySelectorAll('.rail-card h2')].map((node) => node.textContent),
        viewSwitch: [...document.querySelectorAll('.view-switch button')].map((node) => node.textContent.trim()),
        newAgentButton: !!document.querySelector('.agents-top-actions .primary-action'),
      };
    })()`,
  );
  console.log(`AUDIT ${JSON.stringify(audit, null, 2)}`);
  await capture("agents-page");

  // Open the New Agent modal and audit CLI + model pickers.
  await window.webContents.executeJavaScript(
    `document.querySelector('.agents-top-actions .primary-action').click()`,
  );
  await wait(2500);
  const modalAudit = await window.webContents.executeJavaScript(
    `(() => ({
      open: !!document.querySelector('.agent-modal'),
      modules: [...document.querySelectorAll('.module-option')].map((node) => ({
        name: node.querySelector('strong')?.textContent ?? '',
        role: node.querySelector('small')?.textContent ?? '',
        selected: node.classList.contains('selected'),
      })),
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
      module: document.querySelector('.module-option.selected strong')?.textContent ?? null,
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
