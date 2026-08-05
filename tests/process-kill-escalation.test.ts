import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager.ts";
import { collectDescendants, terminateProcessTree } from "../src/main/processes/process-tree.ts";

/** True while the OS still has a process with this pid. */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering
    // anything, which is exactly the "is it still there" question.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, label: string, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function openDatabase(label: string): Promise<DesktopDatabase> {
  return DesktopDatabase.open(path.join(os.tmpdir(), `agentic-${label}-${Date.now()}-${Math.random()}`));
}

function statusOf(db: DesktopDatabase, runId: string): string | undefined {
  return db.listAgentRuns().find((run) => run.id === runId)?.status;
}

/**
 * A shell workload that ignores SIGTERM, and announces the fact once the trap is
 * actually installed.
 *
 * The marker is not decoration. Agent runs spawn through `$SHELL -lc`, and a
 * login shell sources the user's profile before it reaches the first command —
 * tens of milliseconds during which the trap does not exist yet and SIGTERM
 * still kills the process. Waiting on run status alone made the escalation test
 * signal an unprotected shell and conclude, wrongly, that no escalation was
 * needed.
 */
const TRAP_READY = "trap-installed";
const TRAP_SIGTERM_COMMAND = `trap '' TERM; echo ${TRAP_READY}; while true; do sleep 0.2; done`;

/**
 * Same trap, but noisy: it keeps printing while it refuses to die. The quit-path
 * test needs output that is still arriving *after* the database has closed, which
 * a silently sleeping workload never produces.
 */
const TRAP_SIGTERM_CHATTY_COMMAND = `trap '' TERM; echo ${TRAP_READY}; while true; do echo tick; sleep 0.05; done`;

/** Waits until the trapping workload has confirmed its handler is live. */
async function waitForTrapInstalled(db: DesktopDatabase, runId: string): Promise<void> {
  await waitFor(
    () =>
      // `stdout` only. The manager logs the command line itself as an `event`
      // row on spawn, and that row quotes the whole shell command — marker text
      // included — so an unfiltered search matches before the shell has run a
      // single byte, which is the very race this helper exists to close.
      db.listTerminalLogs(runId).some((row) => row.stream === "stdout" && row.message.includes(TRAP_READY)),
    "SIGTERM trap to be installed",
  );
}

test("collectDescendants walks the whole tree, not just direct children", () => {
  const table = [
    { pid: 1, ppid: 0 },
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 }, // child of the root we care about
    { pid: 12, ppid: 11 }, // grandchild: the one a naive kill leaves orphaned
    { pid: 20, ppid: 1 }, // unrelated sibling subtree
    { pid: 21, ppid: 20 },
  ];

  assert.deepEqual(collectDescendants(10, table).sort((a, b) => a - b), [11, 12]);
  assert.deepEqual(collectDescendants(12, table), [], "a leaf has no descendants");
  assert.deepEqual(collectDescendants(999, table), [], "an unknown pid yields nothing");
});

test("collectDescendants survives a torn process table without looping forever", () => {
  // A `ps` snapshot taken while pids are being recycled can describe a cycle.
  // The real tree cannot loop, so the only requirement is that this returns.
  const table = [
    { pid: 5, ppid: 6 },
    { pid: 6, ppid: 5 },
  ];
  const descendants = collectDescendants(5, table);
  assert.ok(descendants.includes(6));
  assert.ok(descendants.length <= 2);
});

test("terminateProcessTree reports a cooperative child as exited on SIGTERM", async () => {
  const child = spawn("sh", ["-c", "sleep 30"]);
  await waitFor(() => Boolean(child.pid), "child pid");

  const escalations: number[] = [];
  const outcome = await terminateProcessTree(child, {
    graceMs: 2_000,
    onEscalate: ({ pid }) => escalations.push(pid),
  });

  assert.equal(outcome, "exited-on-term");
  assert.deepEqual(escalations, [], "a well-behaved child must not be SIGKILLed");
});

test("terminateProcessTree escalates to SIGKILL when SIGTERM is trapped", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal semantics");
    return;
  }

  // A shell that installs a SIGTERM trap and keeps going is exactly the process
  // the old stop() could not kill: it deleted its bookkeeping right after
  // signalling, so nothing was left to escalate with.
  const child = spawn("sh", ["-c", "trap '' TERM; while true; do sleep 0.2; done"]);
  await waitFor(() => Boolean(child.pid), "child pid");
  const pid = child.pid as number;
  await waitFor(() => isAlive(pid), "child alive");

  const escalations: Array<{ pid: number; graceMs: number }> = [];
  const outcome = await terminateProcessTree(child, {
    graceMs: 300,
    onEscalate: ({ pid: escalatedPid, graceMs }) => escalations.push({ pid: escalatedPid, graceMs }),
  });

  assert.equal(outcome, "escalated", "the trapped child had to be SIGKILLed");
  assert.equal(escalations.length, 1, "escalation is reported exactly once");
  assert.equal(escalations[0].graceMs, 300);
  await waitFor(() => !isAlive(pid), "child reaped");
});

test("terminateProcessTree kills grandchildren the shell would otherwise orphan", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process tree semantics");
    return;
  }

  // `sh -lc` is how every shell step and shell agent run is spawned, so the pid
  // the manager holds is the shell's, not the workload's. Killing only the shell
  // leaves the real process running and re-parented to init, invisible to the app.
  const child = spawn("sh", ["-c", "sleep 300 & echo $! ; wait"]);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  await waitFor(() => /\d/.test(stdout), "grandchild pid on stdout");
  const grandchildPid = Number.parseInt(stdout.trim().split("\n")[0], 10);
  assert.ok(Number.isInteger(grandchildPid), `expected a pid, got ${JSON.stringify(stdout)}`);
  await waitFor(() => isAlive(grandchildPid), "grandchild alive");

  await terminateProcessTree(child, { graceMs: 500 });

  await waitFor(() => !isAlive(grandchildPid), "grandchild reaped with the tree");
});

test("terminateProcessTree is a no-op for a child that already exited", async () => {
  const child = spawn("sh", ["-c", "exit 0"]);
  await new Promise((resolve) => child.once("exit", resolve));

  const outcome = await terminateProcessTree(child, { graceMs: 100 });
  assert.equal(outcome, "already-exited");
});

test("stop() does not return until a SIGTERM-trapping agent is actually dead", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal semantics");
    return;
  }

  const db = await openDatabase("kill-escalation");
  // 300ms grace so the test exercises the real escalation path without sleeping
  // out the production window.
  const manager = new AgentProcessManager(db, () => null, undefined, 300);

  const started = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "trap term",
    shellCommand: TRAP_SIGTERM_COMMAND,
  });

  await waitFor(() => statusOf(db, started.runId) === "planning", "run to start");
  await waitForTrapInstalled(db, started.runId);
  const pid = manager.sessions().find((session) => session.runId === started.runId)?.pid;
  assert.ok(pid, "a live session reports its pid");
  await waitFor(() => isAlive(pid as number), "agent process alive");

  await manager.stop(started.runId);

  // The whole point: once stop() resolves, "stopped" is a fact about the OS.
  assert.equal(isAlive(pid as number), false, "stop() left an orphaned process behind");
  assert.equal(statusOf(db, started.runId), "stopped");
  assert.equal(
    manager.sessions().some((session) => session.runId === started.runId),
    false,
    "a stopped run must not linger in the session list",
  );

  const logs = db.listTerminalLogs(started.runId);
  assert.ok(
    logs.some((row) => row.message.includes("escalating to SIGKILL")),
    "escalation is recorded so a CLI that always needs SIGKILL is visible",
  );

  manager.stopAll();
  db.close();
});

test("a stopped run frees its concurrency slot without waiting out the grace period", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal semantics");
    return;
  }

  const db = await openDatabase("kill-slot");
  // A grace period far longer than the assertions below: if the queue waited for
  // the kill to finish, this test would time out rather than fail cheaply.
  const manager = new AgentProcessManager(db, () => null, undefined, 5_000);

  const runs = await Promise.all(
    Array.from({ length: 4 }, () =>
      manager.start({
        cliId: "shell",
        cwd: process.cwd(),
        prompt: "trap term",
        shellCommand: TRAP_SIGTERM_COMMAND,
      }),
    ),
  );

  await waitFor(
    () => manager.sessions().filter((session) => session.status !== "queued").length === 3,
    "three concurrent runs",
  );
  assert.equal(statusOf(db, runs[3].runId), "queued");

  // Not awaited: the queued run must start while the kill is still in flight.
  const stopping = manager.stop(runs[0].runId);
  await waitFor(() => statusOf(db, runs[3].runId) === "planning", "queued run to take the freed slot");

  await stopping;
  manager.stopAll();
  db.close();
});

test("the quit path survives output that arrives after the database closes", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal semantics");
    return;
  }

  // Reproduces the real `before-quit` sequence from src/main/main.ts:
  //
  //     processManager?.stopAll();
  //     database?.close();
  //
  // Both calls are synchronous, but the children they signal outlive them by up
  // to the full SIGTERM grace period — and an agent CLI prints on its way out.
  // That trailing stdout landed in handleOutput() -> appendTerminalLog() on an
  // already-closed handle, throwing "database is not open" from inside a stream
  // callback: an uncaughtException on the way to exit, once per live agent.
  const db = await openDatabase("quit-race");
  // A grace period long enough that the children are guaranteed to still be
  // alive, and still talking, when close() lands.
  const manager = new AgentProcessManager(db, () => null, undefined, 3_000);

  const runs = await Promise.all(
    Array.from({ length: 2 }, () =>
      manager.start({
        cliId: "shell",
        cwd: process.cwd(),
        prompt: "chatty trap",
        shellCommand: TRAP_SIGTERM_CHATTY_COMMAND,
      }),
    ),
  );

  for (const run of runs) {
    await waitFor(() => statusOf(db, run.runId) === "planning", "run to start");
    await waitForTrapInstalled(db, run.runId);
  }

  const pids = runs.map((run) => manager.sessions().find((session) => session.runId === run.runId)?.pid);
  for (const pid of pids) assert.ok(pid, "a live session reports its pid");

  const failures: unknown[] = [];
  const onUncaught = (error: unknown) => failures.push(error);
  process.on("uncaughtException", onUncaught);
  t.after(() => {
    process.off("uncaughtException", onUncaught);
  });

  manager.stopAll();
  db.close();

  // Long enough to cover the grace period, the SIGKILL escalation that follows
  // it, and the stdout still in flight across both.
  await new Promise((resolve) => setTimeout(resolve, 4_000));

  assert.deepEqual(
    failures.map((error) => (error instanceof Error ? error.message : String(error))),
    [],
    "late child output must not throw on the closed database",
  );

  // The kill itself must still have happened: silencing the writes cannot come at
  // the cost of leaving the processes behind.
  for (const pid of pids) {
    await waitFor(() => !isAlive(pid as number), "agent process reaped on quit");
  }
});
