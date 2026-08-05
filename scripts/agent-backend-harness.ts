/**
 * Headless verification harness for the agent backend.
 * Bundled with rolldown, then run under node --experimental-sqlite.
 */
import os from "node:os";
import path from "node:path";
import { listAgentCatalog, defaultModelFor } from "../src/main/agents/catalog";
import { buildInvocation, parseArgs, quoteCommand } from "../src/main/agents/commands";
import { pingAllAgentClis, probeAgentModels } from "../src/main/agents/probe";
import { DesktopDatabase } from "../src/main/database/desktop-database";

async function main() {
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(label);
  };

  // 1. Catalog
  const catalog = listAgentCatalog();
  check("catalog exposes >= 12 CLIs", catalog.length >= 12, `${catalog.length} entries`);
  for (const id of ["kiro", "claude", "codex", "gemini", "shell", "custom"]) {
    const entry = catalog.find((item) => item.id === id);
    check(`catalog has ${id}`, Boolean(entry), entry ? `${entry.models.length} models` : "missing");
  }
  check("default model for kiro", defaultModelFor("kiro") === "claude-sonnet-4-5", defaultModelFor("kiro"));

  // 2. Arg parsing
  const parsed = parseArgs(`--flag "two words" 'single quoted' plain`);
  check(
    "parseArgs handles quotes",
    parsed.length === 4 && parsed[1] === "two words" && parsed[2] === "single quoted",
    JSON.stringify(parsed),
  );
  check("quoteCommand escapes spaces", quoteCommand(["cmd", "a b"]) === "cmd 'a b'", quoteCommand(["cmd", "a b"]));

  // 3. Invocation building (shell always resolvable)
  const shellRun = await buildInvocation({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "echo hello-from-harness",
  });
  check("shell invocation built", shellRun.args.join(" ").includes("echo hello-from-harness"), shellRun.executable);

  const ttyRun = await buildInvocation({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "echo tty",
    forceTty: true,
  });
  check(
    "forceTty wraps in script",
    process.platform === "win32" ? true : ttyRun.executable === "script",
    ttyRun.executable,
  );

  const customRun = await buildInvocation({
    cliId: "custom",
    cwd: process.cwd(),
    prompt: "do the thing",
    commandOverride: "/bin/echo",
    model: "my-model",
    extraArgs: "--verbose",
  });
  check(
    "custom CLI honours override + extra args",
    customRun.executable === "/bin/echo" && customRun.args.includes("--verbose") && customRun.args.includes("do the thing"),
    `${customRun.executable} ${customRun.args.join(" ")}`,
  );

  const agyRun = await buildInvocation({
    cliId: "agy",
    cwd: process.cwd(),
    prompt: "ship it",
    commandOverride: "/bin/echo",
    model: "default",
    autoApprove: true,
    options: {
      effort: "high",
      mode: "plan",
      sandbox: true,
      agent: "ops",
      addDir: ["/tmp/work-a", "/tmp/work-b"],
    },
  });
  check(
    "agy emits declared options",
    agyRun.args.includes("--dangerously-skip-permissions") &&
      agyRun.args.includes("--effort") &&
      agyRun.args.includes("high") &&
      agyRun.args.includes("--mode") &&
      agyRun.args.includes("plan") &&
      agyRun.args.includes("--sandbox") &&
      agyRun.args.filter((arg) => arg === "--add-dir").length === 2,
    `${agyRun.executable} ${agyRun.args.join(" ")}`,
  );
  check("agy sentinel model omits --model", !agyRun.args.includes("--model"), agyRun.args.join(" "));

  const claudeRun = await buildInvocation({
    cliId: "claude",
    cwd: process.cwd(),
    prompt: "review",
    commandOverride: "/bin/echo",
    systemPrompt: "Keep diffs small.",
    options: { permissionMode: "plan", allowedTools: ["Read", "Grep"] },
  });
  check(
    "claude emits system prompt and list options",
    claudeRun.args.includes("--append-system-prompt") &&
      claudeRun.args.includes("Keep diffs small.") &&
      claudeRun.args.includes("--permission-mode") &&
      claudeRun.args.includes("plan") &&
      claudeRun.args.filter((arg) => arg === "--allowed-tools").length === 2,
    `${claudeRun.executable} ${claudeRun.args.join(" ")}`,
  );

  // 4. Ping all CLIs
  const pings = await pingAllAgentClis();
  check("pingAll returns a result per CLI", pings.length === catalog.length - 1, `${pings.length} results`);
  const shellPing = pings.find((ping) => ping.cliId === "shell");
  check("shell ping ok", Boolean(shellPing?.ok), shellPing?.detail ?? "");
  const installed = pings.filter((ping) => ping.installed);
  console.log(
    `      detected: ${installed.map((ping) => `${ping.cliId}(${(ping.version ?? "").slice(0, 24)} ${ping.latencyMs}ms)`).join(", ") || "none"}`,
  );

  // 5. Model probe
  const kiroModels = await probeAgentModels("kiro");
  check("model probe returns models", kiroModels.models.length > 0, `${kiroModels.source}: ${kiroModels.detail}`);

  // 5b. Invocation matrix for every installed CLI (what the app will actually run)
  console.log("\n      invocation matrix:");
  for (const ping of installed) {
    if (ping.cliId === "shell") continue;
    const model = defaultModelFor(ping.cliId);
    const oneShot = await buildInvocation({ cliId: ping.cliId, cwd: process.cwd(), prompt: "<task>", model });
    const interactive = await buildInvocation({
      cliId: ping.cliId,
      cwd: process.cwd(),
      prompt: "<task>",
      model,
      interactive: true,
    });
    console.log(`      ${ping.cliId} one-shot   : ${quoteCommand([oneShot.executable, ...oneShot.args])}`);
    console.log(`      ${ping.cliId} interactive: ${quoteCommand([interactive.executable, ...interactive.args])} (prompt via stdin)`);
    check(
      `${ping.cliId} invocation carries model`,
      model === "default" ? !oneShot.args.includes("--model") : oneShot.args.includes(model),
      model === "default" ? "sentinel default → no --model flag" : model,
    );
    check(`${ping.cliId} interactive sends prompt on stdin`, interactive.stdinPrompt === "<task>");
  }
  console.log("");

  // 6. Database profile CRUD + stats
  const tempDir = path.join(os.tmpdir(), `agentic-harness-${Date.now()}`);
  const db = await DesktopDatabase.open(tempDir);
  const saved = db.saveAgentProfile({
    name: "Harness Agent",
    role: "QA Engineer",
    cliId: "kiro",
    model: "claude-sonnet-4-5",
    accent: "#a78bfa",
    cwd: process.cwd(),
    interactive: true,
    forceTty: false,
    autoApprove: true,
    options: { effort: "high", addDir: ["/tmp/harness"] },
    tags: ["AWS", "test"],
  });
  check("profile saved", saved.id.length > 0 && saved.name === "Harness Agent", saved.id);
  check("profile defaults", saved.enabled && saved.interactive && saved.tags.length === 2, JSON.stringify(saved.tags));
  check("profile stores runtime flags", saved.autoApprove && saved.options.effort === "high", JSON.stringify(saved.options));

  const renamed = db.saveAgentProfile({ ...saved, name: "Harness Agent v2", role: saved.role });
  check("profile updated in place", db.listAgentProfiles().length === 1 && renamed.name === "Harness Agent v2");

  db.createAgentRun({
    id: "run-1",
    cliId: "kiro",
    cwd: process.cwd(),
    prompt: "task",
    model: "claude-sonnet-4-5",
    profileId: saved.id,
    status: "queued",
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    exitCode: null,
  });
  db.updateAgentRunStatus("run-1", "completed", 0);
  db.appendTerminalLog("run-1", "stdout", "hello\n");
  db.appendTerminalLog("run-1", "stdin", "answer\n");

  const withStats = db.listAgentProfiles()[0];
  check("run stats aggregate", withStats.stats.runs === 1 && withStats.stats.completed === 1, JSON.stringify(withStats.stats));
  check("success rate computed", withStats.stats.successRate === 100, `${withStats.stats.successRate}%`);
  check("duration tracked", withStats.stats.totalMs > 100_000, `${withStats.stats.totalMs}ms`);

  const logs = db.listTerminalLogs("run-1");
  check("terminal logs persisted incl. stdin", logs.length === 2 && logs[1].stream === "stdin", JSON.stringify(logs.map((l) => l.stream)));

  const runs = db.listAgentRuns();
  check("run history carries profileId", runs[0]?.profileId === saved.id, runs[0]?.profileId ?? "none");

  db.deleteAgentProfile(saved.id);
  check("profile deleted", db.listAgentProfiles().length === 0);
  db.close();

  console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
