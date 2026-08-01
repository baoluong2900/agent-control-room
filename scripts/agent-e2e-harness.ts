/**
 * End-to-end UI harness: creates an agent through the New Agent modal, runs it,
 * and verifies the interactive terminal streams real output.
 */
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { DesktopDatabase } from "../src/main/database/desktop-database";
import { registerIpcHandlers } from "../src/main/ipc/register-ipc";
import { KnowledgeService } from "../src/main/knowledge/knowledge-service";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager";
import { ProjectService } from "../src/main/projects/project-service";
import { ProviderSecretVault } from "../src/main/settings/provider-secret-vault";
import { SettingsService } from "../src/main/settings/settings-service";
import { TaskAutomationService } from "../src/main/tasks/task-automation-service";
import { WorkflowSchedulerService } from "../src/main/workflows/workflow-scheduler";
import { WorkflowService } from "../src/main/workflows/workflow-service";

const rendererDir = process.env.AGENTIC_RENDERER_DIR ?? "/tmp/agentic-renderer-check";
const preloadPath = process.env.AGENTIC_PRELOAD ?? "/tmp/agentic-shot/preload.js";
const outDir = process.env.AGENTIC_OUT_DIR ?? "/tmp/agentic-shot";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const helpers = `
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const byText = (selector, text) =>
    [...document.querySelectorAll(selector)].find((node) => node.textContent.includes(text));
`;

/**
 * Stand-in for Electron's `safeStorage`. NOT encryption — it only base64-wraps
 * the value so the vault has a working backend in dev harnesses, which run
 * without an OS keychain session. Never use outside these scripts.
 */
const harnessSecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText: string) => Buffer.from(plainText, "utf8"),
};

async function main() {
  await app.whenReady();
  fs.mkdirSync(outDir, { recursive: true });

  const userDataPath = path.join(outDir, "userdata-e2e");
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

  await database.saveAppIdentity({
    displayName: "Local Workspace",
    email: "owner@agentic.local",
    loginMethod: "email",
    status: "signed-in",
  });

  window = new BrowserWindow({
    width: 1680,
    height: 945,
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
      throw new Error(
        `step failed: ${result?.message ?? "no result"}\n--- script ---\n${script.trim().slice(0, 400)}`,
      );
    }
    return result.value;
  };
  /** Poll a boolean expression in the page instead of sleeping a fixed amount. */
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
  const capture = async (name: string) => {
    const image = await window!.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
    console.log(`SHOT ${path.join(outDir, `${name}.png`)}`);
  };

  await window.loadFile(path.join(rendererDir, "index.html"));
  await waitFor("app shell mounted", `byText('.primary-nav button', 'Agents')`);

  await run(`byText('.primary-nav button', 'Agents').click(); return true;`);
  await waitFor("agents view rendered", `document.querySelector('.agents-top-actions .primary-action')`);

  // 1. Open the builder and configure a deterministic Shell agent.
  await run(`document.querySelector('.agents-top-actions .primary-action').click(); return true;`);
  await waitFor("new-agent modal open", `byText('.module-option', 'Tester') && byText('.cli-option', 'Shell')`);
  await run(`byText('.module-option', 'Tester').click(); return true;`);
  await waitFor(
    "Tester module selected Shell CLI",
    `document.querySelector('.module-option.selected strong')?.textContent === 'Tester'
       && document.querySelector('.cli-option.selected strong')?.textContent === 'Shell'
       && document.querySelector('.agent-modal .field input')`,
  );

  const configured = await run<Record<string, unknown>>(`
    const inputs = [...document.querySelectorAll('.agent-modal .field input')];
    const nameInput = inputs.find((node) => node.placeholder && node.placeholder.includes('Local Agent'));
    const roleInput = inputs.find((node) => node.placeholder && node.placeholder.includes('Senior Developer'));
    const cwdInput = inputs.find((node) => node.placeholder && node.placeholder.includes('/path/to/project'));
    setValue(nameInput, 'E2E Shell Runner');
    setValue(roleInput, 'Build Verifier');
    setValue(cwdInput, ${JSON.stringify(process.cwd())});
    return {
      name: nameInput.value,
      role: roleInput.value,
      cwd: cwdInput.value,
      selectedModule: document.querySelector('.module-option.selected strong').textContent,
      selectedCli: document.querySelector('.cli-option.selected strong').textContent,
      preview: document.querySelector('.preview-command code').textContent,
    };
  `);
  check(
    "builder configured for Tester Shell module",
    configured.selectedModule === "Tester" && configured.selectedCli === "Shell" && configured.name === "E2E Shell Runner",
    JSON.stringify(configured),
  );
  await capture("e2e-1-builder");

  await run(`byText('.agent-modal-foot .primary-action', 'Create agent').click(); return true;`);
  await waitFor(
    "agent card rendered + modal closed",
    `!document.querySelector('.agent-modal')
       && document.querySelector('.agent-card .agent-card-copy strong')`,
  );

  // 2. Card should exist with the new agent.
  const card = await run<Record<string, unknown>>(`
    const node = document.querySelector('.agent-card');
    return node
      ? {
          modalClosed: !document.querySelector('.agent-modal'),
          name: node.querySelector('.agent-card-copy strong').textContent,
          role: node.querySelector('.agent-card-copy small').textContent,
          chips: [...node.querySelectorAll('.chip')].map((chip) => chip.textContent.trim()),
          tabs: [...document.querySelectorAll('.agents-tabs button')].map((b) => b.textContent.trim()),
          totalAgents: document.querySelector('.stat-pill strong').textContent.trim(),
        }
      : null;
  `);
  check(
    "agent card created + persisted with module chip",
    Boolean(card && card.name === "E2E Shell Runner" && Array.isArray(card.chips) && card.chips.some((chip) => String(chip).includes("Tester"))),
    JSON.stringify(card),
  );
  await capture("e2e-2-card");

  // 3. Robot overview should render a real WebGL canvas and open chat for the configured module.
  await waitFor(
    "3D robot arena rendered",
    `document.querySelector('.agent-robot-arena canvas')
       && byText('.robot-nameplate', 'E2E Shell Runner')`,
  );
  const robotAudit = await run<Record<string, unknown>>(`
    const canvas = document.querySelector('.agent-robot-arena canvas');
    const labels = [...document.querySelectorAll('.robot-nameplate')].map((node) => node.textContent.trim());
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const samples = [
      [0.25, 0.35],
      [0.5, 0.5],
      [0.72, 0.56],
      [0.46, 0.74],
      [0.82, 0.28],
    ];
    let nonBlankPixels = 0;
    if (gl && canvas) {
      for (const [xRatio, yRatio] of samples) {
        const pixel = new Uint8Array(4);
        gl.readPixels(
          Math.floor(canvas.width * xRatio),
          Math.floor(canvas.height * yRatio),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixel,
        );
        if (pixel[0] + pixel[1] + pixel[2] + pixel[3] > 0) nonBlankPixels += 1;
      }
    }
    return {
      canvasWidth: canvas?.clientWidth ?? 0,
      canvasHeight: canvas?.clientHeight ?? 0,
      labels,
      nonBlankPixels,
      selected: document.querySelector('.robot-nameplate.selected')?.textContent?.trim() ?? null,
    };
  `);
  check(
    "3D robot module rendered in overview",
    Number(robotAudit.canvasWidth) > 100
      && Number(robotAudit.canvasHeight) > 100
      && Number(robotAudit.nonBlankPixels) > 0
      && Array.isArray(robotAudit.labels)
      && robotAudit.labels.some((label) => String(label).includes("E2E Shell Runner") && String(label).includes("Deployment")),
    JSON.stringify(robotAudit),
  );
  await capture("e2e-3-robots");

  await run(`byText('.agent-card-actions .ghost-button', 'Chat').click(); return true;`);
  await waitFor(
    "agent chat panel mounted",
    `document.querySelector('.agent-chat-panel .agent-chat-messages')
       && document.querySelector('.agent-chat-input textarea')`,
  );
  await run(`
    const textarea = document.querySelector('.agent-chat-input textarea');
    setValue(textarea, 'echo E2E-CHAT-OK');
    return true;
  `);
  await waitFor(
    "chat command text committed to input state",
    `document.querySelector('.agent-chat-input textarea')?.value === 'echo E2E-CHAT-OK'`,
  );
  await run(`document.querySelector('.agent-chat-send').click(); return true;`);

  let chatText = "";
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await wait(300);
    chatText = await run<string>(`
      return document.querySelector('.agent-chat-messages')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
    `);
    if (chatText.includes("E2E-CHAT-OK") && chatText.includes("exited with code 0")) break;
  }
  check("chat panel streamed real agent output", chatText.includes("E2E-CHAT-OK"), chatText.slice(0, 180));
  await capture("e2e-4-chat");

  // 4. Open the terminal and run a real command.
  await run(`byText('.agent-card-actions .ghost-button', 'Terminal').click(); return true;`);
  await waitFor(
    "terminal panel mounted",
    `document.querySelector('.agent-terminal .terminal-surface')
       && document.querySelector('.terminal-input textarea')`,
  );
  const terminalOpen = await run<boolean>(`return !!document.querySelector('.agent-terminal .terminal-surface');`);
  check("terminal panel opened", terminalOpen);

  await run(`
    const textarea = document.querySelector('.terminal-input textarea');
    setValue(textarea, 'echo E2E-TERMINAL-OK && ls package.json');
    return true;
  `);
  await waitFor(
    "command text committed to input state",
    `document.querySelector('.terminal-input textarea')?.value === 'echo E2E-TERMINAL-OK && ls package.json'`,
  );
  await run(`document.querySelector('.terminal-input .primary-action').click(); return true;`);

  // Poll until the xterm write buffer has flushed the real stdout.
  let terminalText = "";
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await wait(400);
    terminalText = await run<string>(`
      const rows = document.querySelector('.agent-terminal .xterm-rows');
      return rows ? rows.textContent.replace(/\\s+/g, ' ').trim() : '';
    `);
    if (terminalText.includes("package.json") && terminalText.includes("exited with code 0")) break;
  }

  const terminalState = await run<Record<string, unknown>>(`
    const rows = document.querySelector('.agent-terminal .xterm-rows');
    const runs = [...document.querySelectorAll('.agent-terminal')];
    document.querySelector('.agent-terminal').scrollIntoView({ block: 'center' });
    return {
      text: rows ? rows.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400) : null,
      rowCount: rows ? rows.children.length : 0,
      screenText: document.querySelector('.agent-terminal .xterm-screen')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 400) ?? null,
      panels: runs.length,
      command: document.querySelector('.terminal-command')?.textContent ?? null,
      livePill: document.querySelector('.live-pill')?.textContent?.trim() ?? null,
      activityCount: document.querySelectorAll('.activity-list li').length,
      statusPill: document.querySelector('.agent-card .status-pill')?.textContent ?? null,
    };
  `);
  check(
    "terminal streamed real stdout (echo + ls)",
    terminalText.includes("E2E-TERMINAL-OK") && terminalText.includes("package.json"),
    terminalText.slice(0, 160),
  );
  check("terminal reported process exit", terminalText.includes("exited with code 0"));
  check("activity feed recorded events", Number(terminalState.activityCount) > 0, `${terminalState.activityCount} entries`);
  console.log(`TERMINAL ${JSON.stringify(terminalState, null, 2)}`);
  await capture("e2e-5-terminal");

  // 5. Metrics refresh after the run finishes.
  await waitFor(
    "card metrics refreshed after run",
    `Number(document.querySelectorAll('.agent-card .agent-metrics strong')[1]?.textContent) >= 1`,
  );
  const metrics = await run<Record<string, unknown>>(`
    const card = document.querySelector('.agent-card');
    return {
      successRate: card.querySelector('.agent-metrics strong').textContent,
      tasksCompleted: card.querySelectorAll('.agent-metrics strong')[1].textContent,
      history: document.querySelectorAll('.activity-list li').length,
    };
  `);
  check("run stats surfaced on the card", Number(metrics.tasksCompleted) >= 1, JSON.stringify(metrics));
  await capture("e2e-6-metrics");

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
