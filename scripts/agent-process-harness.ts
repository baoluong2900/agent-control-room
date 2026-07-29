/**
 * Headless verification of AgentProcessManager: spawn, stream, stdin, stop.
 * Bundled with rolldown, run under node --experimental-sqlite.
 */
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "@contracts";
import { DesktopDatabase } from "../apps/desktop/src/main/database/desktop-database";
import { AgentProcessManager } from "../apps/desktop/src/main/processes/agent-process-manager";

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const tempDir = path.join(os.tmpdir(), `agentic-proc-${Date.now()}`);
  const db = await DesktopDatabase.open(tempDir);

  const events: AgentEvent[] = [];
  const fakeWebContents = { send: (_channel: string, payload: AgentEvent) => void events.push(payload) };
  const manager = new AgentProcessManager(db, () => fakeWebContents as never);

  // 1. One-shot shell run
  const oneShot = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "echo harness-one-shot",
  });
  check("one-shot run started", Boolean(oneShot.runId && oneShot.command), `${oneShot.command} pid=${oneShot.pid}`);

  const exitEvent = await waitFor(events, (event) => event.runId === oneShot.runId && event.type === "run:exit", 8000);
  check("one-shot exited", Boolean(exitEvent), exitEvent?.message ?? "no exit event");

  const stdout = events
    .filter((event) => event.runId === oneShot.runId && event.type === "run:stdout")
    .map((event) => event.message)
    .join("");
  check("stdout streamed to renderer channel", stdout.includes("harness-one-shot"), stdout.trim().slice(0, 40));

  const logs = db.listTerminalLogs(oneShot.runId);
  check("output persisted to sqlite", logs.some((log) => log.message.includes("harness-one-shot")), `${logs.length} rows`);

  const record = db.listAgentRuns().find((run) => run.id === oneShot.runId);
  check("run marked completed", record?.status === "completed", `${record?.status} exit=${record?.exitCode}`);

  // 2. Interactive session with stdin
  const session = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "",
    interactive: true,
    shellCommand: process.platform === "win32" ? "cmd.exe" : "sh -i",
  });
  check("interactive session started", session.interactive, `${session.command} ${session.args.join(" ")}`);

  const live = manager.sessions();
  check("session listed as live", live.some((entry) => entry.runId === session.runId), `${live.length} live`);

  await wait(250);
  const delivered = manager.send(session.runId, "echo harness-stdin\n");
  check("stdin write accepted", delivered);

  const stdinEcho = await waitFor(
    events,
    (event) =>
      event.runId === session.runId &&
      (event.type === "run:stdout" || event.type === "run:stderr") &&
      Boolean(event.message?.includes("harness-stdin")),
    6000,
  );
  check("interactive output received after stdin", Boolean(stdinEcho), stdinEcho?.message?.trim().slice(0, 40) ?? "none");

  const stdinLogged = db.listTerminalLogs(session.runId).some((log) => log.stream === "stdin");
  check("stdin persisted for replay", stdinLogged);

  await manager.stop(session.runId);
  await wait(200);
  check("session stopped", manager.sessions().every((entry) => entry.runId !== session.runId));
  const stopped = db.listAgentRuns().find((run) => run.id === session.runId);
  check("stopped status recorded", stopped?.status === "stopped", stopped?.status ?? "unknown");

  // 3. Missing CLI produces a clear error instead of a crash
  let errorMessage = "";
  try {
    await manager.start({
      cliId: "custom",
      cwd: process.cwd(),
      prompt: "hello",
      commandOverride: "definitely-not-a-real-binary-xyz",
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  check("missing binary rejected with message", errorMessage.includes("not found"), errorMessage);
  check(
    "failure emitted as run:error event",
    events.some((event) => event.type === "run:error"),
    `${events.filter((event) => event.type === "run:error").length} error events`,
  );

  // 4. Optional: run a real AI CLI end to end (AGENTIC_REAL_CLI=claude|kiro|codex)
  const realCli = process.env.AGENTIC_REAL_CLI;
  if (realCli) {
    const realRun = await manager.start({
      cliId: realCli as never,
      cwd: process.cwd(),
      prompt: "Reply with exactly the word AGENTOK and nothing else.",
      model: process.env.AGENTIC_REAL_MODEL,
    });
    console.log(`      real run: ${realRun.command} ${realRun.args.join(" ")}`);
    const realExit = await waitFor(events, (event) => event.runId === realRun.runId && event.type === "run:exit", 180_000);
    const realOutput = events
      .filter((event) => event.runId === realRun.runId && (event.type === "run:stdout" || event.type === "run:stderr"))
      .map((event) => event.message)
      .join("");
    check(`real ${realCli} run exited`, Boolean(realExit), realExit?.message ?? "timed out");
    check(`real ${realCli} produced output`, realOutput.trim().length > 0, realOutput.trim().slice(0, 160));
  }

  db.close();
  console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

async function waitFor(
  events: AgentEvent[],
  predicate: (event: AgentEvent) => boolean,
  timeoutMs: number,
): Promise<AgentEvent | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await wait(60);
  }
  return null;
}

void main();
