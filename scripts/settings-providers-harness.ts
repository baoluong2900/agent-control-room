/**
 * End-to-end UI harness for the Settings → AI providers surface.
 *
 * Verifies the redesigned provider cards render, that the Hermes Agent gateway
 * is offered with its default endpoint, and that saving + verifying a
 * connection round-trips through real IPC. The endpoint probe is stubbed so the
 * harness never depends on a proxy actually running on this machine.
 */
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { DesktopDatabase } from "../src/main/database/desktop-database";
import { registerIpcHandlers } from "../src/main/ipc/register-ipc";
import { KnowledgeService } from "../src/main/knowledge/knowledge-service";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager";
import { ProjectService } from "../src/main/projects/project-service";
import { ProviderSecretVault } from "../src/main/settings/provider-secret-vault";
import { SettingsService } from "../src/main/settings/settings-service";
import { TaskAutomationService } from "../src/main/tasks/task-automation-service";
import { WebhookCoordinator } from "../src/main/workflows/webhook-coordinator";
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
  const cardFor = (label) =>
    [...document.querySelectorAll('.provider-card')].find(
      (node) => node.querySelector('.provider-head-copy strong')?.textContent.trim() === label,
    );
`;

/** See the note in agent-e2e-harness.ts — base64 wrapping, not encryption. */
const harnessSecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText: string) => Buffer.from(plainText, "utf8"),
  decryptString: (cipherText: Buffer) => cipherText.toString("utf8"),
};

async function main() {
  await app.whenReady();
  fs.mkdirSync(outDir, { recursive: true });

  const userDataPath = path.join(outDir, "userdata-settings-e2e");
  fs.rmSync(userDataPath, { recursive: true, force: true });
  const database = await DesktopDatabase.open(userDataPath);
  let window: BrowserWindow | null = null;
  const manager = new AgentProcessManager(database, () => window?.webContents ?? null);
  const taskAutomationService = new TaskAutomationService(database, manager, () => window?.webContents ?? null);
  const workflowService = new WorkflowService(database, () => window?.webContents ?? null);
  const workflowSchedulerService = new WorkflowSchedulerService(workflowService, () => window?.webContents ?? null);
  const harnessVault = new ProviderSecretVault(userDataPath, harnessSecretStorage);
  const webhookCoordinator = new WebhookCoordinator(
    database,
    harnessVault,
    workflowSchedulerService,
    () => window?.webContents ?? null,
  );

  const probedEndpoints: string[] = [];
  const settingsService = new SettingsService(
    database,
    new ProviderSecretVault(userDataPath, harnessSecretStorage),
    { openExternal: async () => {} },
    async () => ({ installed: true, detail: "harness" }),
    // Stubbed so the check is about the UI wiring, not whether a proxy is up here.
    async (baseUrl: string) => {
      probedEndpoints.push(baseUrl);
      return { reachable: true, statusCode: 200 };
    },
  );

  registerIpcHandlers(ipcMain, {
    agentProcessManager: manager,
    database,
    knowledgeService: new KnowledgeService(database),
    projectService: new ProjectService(database),
    settingsService,
    taskAutomationService,
    webhookCoordinator,
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

  const capture = async (name: string) => {
    const image = await window!.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
    console.log(`SHOT ${path.join(outDir, `${name}.png`)}`);
  };

  await window.loadFile(path.join(rendererDir, "index.html"));
  await waitFor("app shell mounted", `byText('.primary-nav button', 'Settings')`);

  await run(`byText('.primary-nav button', 'Settings').click(); return true;`);
  await waitFor("provider cards rendered", `document.querySelectorAll('.provider-card').length >= 6`);

  // 1. The catalog renders every provider, with the gateway first.
  const catalogAudit = await run<Record<string, unknown>>(`
    const cards = [...document.querySelectorAll('.provider-card')];
    return {
      count: cards.length,
      labels: cards.map((node) => node.querySelector('.provider-head-copy strong').textContent.trim()),
      first: cards[0].querySelector('.provider-head-copy strong').textContent.trim(),
      hermesTags: [...cardFor('Hermes Agent').querySelectorAll('.provider-tag')].map((t) => t.textContent.trim()),
      hermesEndpointPlaceholder:
        [...cardFor('Hermes Agent').querySelectorAll('input')].pop().placeholder,
      customApiHasKeyField: [...cardFor('Custom API').querySelectorAll('input')].some((i) => i.type === 'password'),
      hermesHasKeyField: [...cardFor('Hermes Agent').querySelectorAll('input')].some((i) => i.type === 'password'),
    };
  `);
  check(
    "all six providers render with Hermes Agent surfaced first",
    Number(catalogAudit.count) === 6 && catalogAudit.first === "Hermes Agent",
    JSON.stringify(catalogAudit.labels),
  );
  check(
    "gateway card offers an endpoint with the documented proxy default and needs no key",
    String(catalogAudit.hermesEndpointPlaceholder) === "http://127.0.0.1:8645/v1" &&
      catalogAudit.hermesHasKeyField === false &&
      catalogAudit.customApiHasKeyField === true,
    JSON.stringify(catalogAudit),
  );
  await capture("settings-1-providers");

  // 2. Saving the gateway with no typed endpoint should still be usable.
  await run(`cardFor('Hermes Agent').querySelector('.provider-create-foot button').click(); return true;`);
  await waitFor(
    "gateway connection saved and listed",
    `cardFor('Hermes Agent').querySelector('.provider-connection-row')`,
  );

  const savedAudit = await run<Record<string, unknown>>(`
    const card = cardFor('Hermes Agent');
    return {
      isLive: card.classList.contains('is-live'),
      status: card.querySelector('.provider-connection-row .status-chip').textContent.trim(),
      shownEndpoint: card.querySelector('.provider-connection-copy small .mono')?.textContent.trim() ?? null,
      banner: document.querySelector('.settings-banner')?.textContent?.trim() ?? null,
    };
  `);
  check(
    "saved gateway is marked unchecked and shows the endpoint it will use",
    savedAudit.status === "Not checked" && savedAudit.shownEndpoint === "http://127.0.0.1:8645/v1",
    JSON.stringify(savedAudit),
  );
  check("saved provider card is visually flagged as set up", savedAudit.isLive === true);
  await capture("settings-2-saved");

  // 3. Verify promotes it to connected, and probes the right endpoint.
  await run(`cardFor('Hermes Agent').querySelector('.settings-mini-button.primary').click(); return true;`);
  await waitFor(
    "gateway verified",
    `cardFor('Hermes Agent').querySelector('.status-chip')?.textContent.trim() === 'Connected'`,
  );
  const verifyAudit = await run<Record<string, unknown>>(`
    const card = cardFor('Hermes Agent');
    return {
      status: card.querySelector('.provider-connection-row .status-chip').textContent.trim(),
      detail: card.querySelector('.provider-connection-detail')?.textContent.trim() ?? null,
      connectedStat: document.querySelectorAll('.settings-stat strong')[1].textContent.trim(),
    };
  `);
  check(
    "verify reached the default proxy endpoint and promoted the connection",
    verifyAudit.status === "Connected" && probedEndpoints[0] === "http://127.0.0.1:8645/v1",
    JSON.stringify({ ...verifyAudit, probedEndpoints }),
  );
  check("summary stat counts the connected provider", verifyAudit.connectedStat === "1", String(verifyAudit.connectedStat));
  await capture("settings-3-verified");

  // 4. A typed key in one card must not leak into another card's save.
  await run(`
    const customKey = [...cardFor('Custom API').querySelectorAll('input')].find((i) => i.type === 'password');
    setValue(customKey, 'sk-should-stay-here');
    return true;
  `);
  const isolation = await run<Record<string, unknown>>(`
    const codexInputs = [...cardFor('OpenAI Codex').querySelectorAll('input')];
    return {
      customKey: [...cardFor('Custom API').querySelectorAll('input')].find((i) => i.type === 'password').value,
      codexHasPasswordField: codexInputs.some((i) => i.type === 'password'),
      codexValues: codexInputs.map((i) => i.value),
    };
  `);
  check(
    "an API key typed in one card stays scoped to that card",
    isolation.customKey === "sk-should-stay-here" && isolation.codexHasPasswordField === false,
    JSON.stringify(isolation),
  );
  await capture("settings-4-isolation");

  const persisted = settingsService.listProviderConnections();
  check(
    "connection persisted through real IPC, not just react state",
    persisted.length === 1 && persisted[0].provider === "hermes-agent" && persisted[0].status === "connected",
    JSON.stringify(persisted.map((c) => ({ provider: c.provider, status: c.status, baseUrl: c.baseUrl }))),
  );

  // 5. Measure the rendered boxes. A screenshot can look fine while text is
  //    clipped or a control has overflowed its card, so assert on geometry.
  const layout = await run<Record<string, unknown>>(`
    const cards = [...document.querySelectorAll('.provider-card')];
    const overflowing = [];
    const clipped = [];
    for (const card of cards) {
      const label = card.querySelector('.provider-head-copy strong').textContent.trim();
      const cardBox = card.getBoundingClientRect();
      if (card.scrollWidth > card.clientWidth + 1) overflowing.push(label + ' (card scrolls)');
      for (const child of card.querySelectorAll('input, button, .provider-tag')) {
        const box = child.getBoundingClientRect();
        if (box.right > cardBox.right + 1 || box.left < cardBox.left - 1) {
          overflowing.push(label + ' > ' + (child.className || child.tagName));
        }
        // A control squeezed under ~90px is unreadable regardless of theme.
        if (box.width > 0 && box.width < 44) clipped.push(label + ' > ' + (child.className || child.tagName) + ' @' + Math.round(box.width) + 'px');
      }
    }
    const heights = cards.map((c) => Math.round(c.getBoundingClientRect().height));
    const widths = cards.map((c) => Math.round(c.getBoundingClientRect().width));
    return {
      overflowing,
      clipped,
      widths,
      uniformWidth: new Set(widths).size <= 2,
      minHeight: Math.min(...heights),
      columns: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size,
      docScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  `);
  check(
    "no control overflows its provider card",
    Array.isArray(layout.overflowing) && layout.overflowing.length === 0,
    JSON.stringify(layout.overflowing),
  );
  check(
    "no control is squeezed below a usable width",
    Array.isArray(layout.clipped) && layout.clipped.length === 0,
    JSON.stringify(layout.clipped),
  );
  check(
    "cards form an even two-column grid with no horizontal page scroll",
    layout.uniformWidth === true && layout.columns === 2 && layout.docScrollsSideways === false,
    JSON.stringify({ widths: layout.widths, columns: layout.columns, sideways: layout.docScrollsSideways }),
  );

  // 6. The same page at a narrow window must collapse rather than overflow.
  window.setContentSize(900, 900);
  await wait(400);
  const narrow = await run<Record<string, unknown>>(`
    const cards = [...document.querySelectorAll('.provider-card')];
    const overflowing = cards.filter((card) => card.scrollWidth > card.clientWidth + 1).length;
    return {
      columns: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size,
      overflowing,
      docScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  `);
  check(
    "narrow window collapses to one column without sideways scroll",
    narrow.columns === 1 && narrow.overflowing === 0 && narrow.docScrollsSideways === false,
    JSON.stringify(narrow),
  );
  await capture("settings-5-narrow");
  window.setContentSize(1680, 945);
  await wait(300);

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
