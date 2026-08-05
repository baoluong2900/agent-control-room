import assert from "node:assert/strict";
import { createServer } from "node:net";
import process from "node:process";
import test from "node:test";
import {
  SIDECAR_SETTING_KEYS,
  SidecarManager,
  type SidecarConfig,
  generateLocalKey,
  isPortFree,
  readSidecarConfig,
} from "../src/main/gateway/sidecar-manager.ts";

/** A tiny real HTTP server standing in for a router, so nothing is mocked away. */
const FAKE_SIDECAR = [
  "-e",
  `const http = require("http");
   const port = process.env.AGENTIC_GATEWAY_PORT;
   const key = process.env.AGENTIC_GATEWAY_KEY;
   console.log("listening on " + port + " with key " + key);
   http.createServer((req, res) => {
     if (req.headers.authorization !== "Bearer " + key) { res.writeHead(401); res.end(); return; }
     res.writeHead(200, { "content-type": "application/json" });
     res.end(JSON.stringify({ ok: true }));
   }).listen(Number(port), "127.0.0.1");`,
];

/** Printed by the trapping workload once its handler is actually installed. */
const TRAP_READY = "trap-installed";

function manager(t: { after: (fn: () => unknown) => void }, config: SidecarConfig) {
  const events: string[] = [];
  const instance = new SidecarManager({
    readConfig: () => config,
    onEvent: (message) => events.push(message),
  });
  t.after(() => instance.stop());
  return { instance, events };
}

test("an unconfigured sidecar is a no-op, not an error", async (t) => {
  const { instance, events } = manager(t, {});

  const status = await instance.start();

  // The app ships without a bundled router on purpose, so "nobody configured one"
  // must not read as a failure the user has to fix.
  assert.equal(status.state, "stopped");
  assert.equal(status.configured, false);
  assert.equal(status.error, null);
  assert.deepEqual(events, []);
});

test("a configured sidecar starts, serves, and reports a loopback base URL", async (t) => {
  const { instance } = manager(t, { command: process.execPath, args: FAKE_SIDECAR });

  const status = await instance.start();

  assert.equal(status.state, "running");
  assert.ok(status.pid, "a pid was assigned");
  assert.match(status.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(status.error, null);

  // `running` means the process survived startup, not that it is listening — phase 1
  // has no readiness handshake, so wait for the socket before asserting on it.
  const key = instance.ensureLocalKey();
  await waitFor(async () => {
    try {
      await fetch(`${status.baseUrl}/health`, { headers: { authorization: `Bearer ${key}` } });
      return true;
    } catch {
      return false;
    }
  });

  const response = await fetch(`${status.baseUrl}/health`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);

  const unauthorised = await fetch(`${status.baseUrl}/health`);
  assert.equal(unauthorised.status, 401, "the local key is genuinely required");
});

test("stop kills the process and frees the port", async (t) => {
  const { instance } = manager(t, { command: process.execPath, args: FAKE_SIDECAR });
  const status = await instance.start();
  const port = status.port as number;

  await instance.stop();

  assert.equal(instance.status().state, "stopped");
  assert.equal(instance.status().pid, null);
  // Rebinding proves the socket was really released rather than just marked stopped
  // — the difference between a clean quit and an orphan holding the port.
  assert.equal(await isPortFree(port), true);
});

test("a sidecar that ignores SIGTERM is escalated to SIGKILL", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal semantics");
    return;
  }

  // Deliberately not using the `manager` helper: its `t.after(stop)` would race this
  // test's own stop, and the first one to run does the real work.
  const events: string[] = [];
  const instance = new SidecarManager({
    readConfig: () => ({
      // `sh` with a real `trap` rather than `node -e`: a Node child has a window
      // after spawn where the SIGTERM handler is not installed yet, so a stop racing
      // that window kills it outright and no escalation is needed. The existing
      // kill-escalation suite hit the same thing.
      command: "sh",
      args: ["-c", `trap '' TERM; echo ${TRAP_READY}; while true; do sleep 0.2; done`],
    }),
    onEvent: (message) => events.push(message),
  });
  const status = await instance.start();
  const pid = status.pid as number;

  // Wait for the trap to be confirmed live, otherwise this tests nothing.
  await waitFor(() => instance.recentLogs().some((line) => line.message.includes(TRAP_READY)));

  // Takes just over the 3s grace period, which is the point: SIGTERM is ignored.
  await instance.stop();

  assert.equal(instance.status().state, "stopped");
  assert.equal(processAlive(pid), false, "a stubborn sidecar is still gone after stop");
  assert.ok(
    events.some((message) => message.includes("SIGKILL")),
    "and the escalation is reported rather than silent",
  );
});

test("child processes the sidecar spawned do not survive it", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process tree semantics");
    return;
  }

  // A router that forks workers is the realistic case; killing only the parent
  // would leave them holding the port. This is the plan's "no orphan" acceptance.
  const { instance } = manager(t, {
    command: process.execPath,
    args: [
      "-e",
      `const { spawn } = require("child_process");
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
       console.log("worker " + child.pid);
       setInterval(() => {}, 1000);`,
    ],
  });

  await instance.start();
  const workerPid = await waitForWorkerPid(instance);
  assert.ok(workerPid, "the sidecar reported its worker pid");

  await instance.stop();
  await delay(300);

  assert.equal(processAlive(workerPid), false, "the worker was reaped with its parent");
});

test("a bad command fails cleanly with an actionable reason", async (t) => {
  const { instance, events } = manager(t, { command: "definitely-not-a-real-binary-xyz" });

  const status = await instance.start();
  // The spawn may fail synchronously or asynchronously depending on platform.
  await delay(200);

  const settled = instance.status();
  assert.equal(settled.state, "failed");
  assert.ok(settled.error, "the reason is recorded");
  assert.ok(events.length > 0, "and surfaced to the UI");
  assert.equal(status.configured, true, "still configured — it just did not run");
});

test("a sidecar that exits immediately is reported as a config problem", async (t) => {
  const { instance } = manager(t, { command: process.execPath, args: ["-e", "process.exit(3)"] });

  await instance.start();
  await delay(400);

  const status = instance.status();
  assert.equal(status.state, "failed");
  // "exited immediately" points at the command/flags; a late exit would not.
  assert.match(status.error ?? "", /exited immediately/);
  assert.match(status.error ?? "", /exit code 3/);
});

test("a configured port that is taken is reported, not silently swapped", async (t) => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const address = blocker.address();
  const taken = typeof address === "object" && address ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

  const { instance } = manager(t, { command: process.execPath, args: FAKE_SIDECAR, port: taken });

  const status = await instance.start();

  // Falling back to a random port would break whatever the user pointed at this one.
  assert.equal(status.state, "failed");
  assert.match(status.error ?? "", /already in use/);
  assert.equal(status.port, null);
});

test("a free configured port is honoured exactly", async (t) => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const address = probe.address();
  const wanted = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const { instance } = manager(t, { command: process.execPath, args: FAKE_SIDECAR, port: wanted });
  const status = await instance.start();

  assert.equal(status.port, wanted);
});

test("start is idempotent while running", async (t) => {
  const { instance } = manager(t, { command: process.execPath, args: FAKE_SIDECAR });

  const first = await instance.start();
  const second = await instance.start();

  assert.equal(second.pid, first.pid, "a second start does not spawn a duplicate");
  assert.equal(second.port, first.port);
});

test("restart replaces the process", async (t) => {
  const { instance } = manager(t, { command: process.execPath, args: FAKE_SIDECAR });
  const first = await instance.start();

  const second = await instance.restart();

  assert.notEqual(second.pid, first.pid);
  assert.equal(second.state, "running");
  assert.equal(await isPortFree(first.port as number), true, "the old port was released");
});

test("the local key never appears in captured logs", async (t) => {
  // The fake sidecar deliberately echoes its key on startup, which is the most
  // likely way a real router would leak it.
  const { instance } = manager(t, { command: process.execPath, args: FAKE_SIDECAR });
  await instance.start();
  const key = instance.ensureLocalKey();

  await waitFor(() => instance.recentLogs().some((line) => line.message.includes("listening on")));

  const logs = instance.recentLogs();
  assert.ok(logs.length > 0, "output was captured");
  for (const line of logs) {
    assert.equal(line.message.includes(key), false, `key leaked into logs: ${line.message}`);
  }
  assert.ok(
    logs.some((line) => line.message.includes("***")),
    "the key was redacted rather than the line dropped",
  );
});

test("captured logs are capped so a chatty sidecar cannot grow memory forever", async (t) => {
  const { instance } = manager(t, {
    command: process.execPath,
    args: ["-e", `for (let i = 0; i < 2000; i += 1) console.log("line " + i); setInterval(() => {}, 1000);`],
  });
  await instance.start();

  await waitFor(() => instance.recentLogs(1000).length >= 500);

  assert.ok(instance.recentLogs(10_000).length <= 500, "older lines are dropped");
});

test("readSidecarConfig reads the settings table and rejects nonsense", () => {
  const store = (values: Record<string, string>) => ({ getSetting: (key: string) => values[key] });

  assert.deepEqual(readSidecarConfig(store({})), {
    command: undefined,
    args: [],
    port: undefined,
    cwd: undefined,
  });

  const configured = readSidecarConfig(
    store({
      [SIDECAR_SETTING_KEYS.command]: " /usr/local/bin/router ",
      [SIDECAR_SETTING_KEYS.args]: "serve  --verbose",
      [SIDECAR_SETTING_KEYS.port]: "20128",
      [SIDECAR_SETTING_KEYS.cwd]: "/tmp",
    }),
  );
  assert.equal(configured.command, "/usr/local/bin/router");
  assert.deepEqual(configured.args, ["serve", "--verbose"]);
  assert.equal(configured.port, 20128);
  assert.equal(configured.cwd, "/tmp");

  // An out-of-range or non-numeric port falls back to OS assignment rather than
  // spawning a child that dies on a bad bind.
  for (const bad of ["0", "-1", "70000", "abc", ""]) {
    assert.equal(readSidecarConfig(store({ [SIDECAR_SETTING_KEYS.port]: bad })).port, undefined, `port "${bad}"`);
  }
});

test("generated local keys are long and unique", () => {
  const a = generateLocalKey();
  assert.equal(a.length, 64);
  assert.notEqual(a, generateLocalKey());
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the pid still exists. Signal 0 tests for existence without signalling. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("timed out waiting for condition");
}

async function waitForWorkerPid(instance: SidecarManager): Promise<number> {
  let pid = 0;
  await waitFor(() => {
    for (const line of instance.recentLogs()) {
      const match = /worker (\d+)/.exec(line.message);
      if (match) {
        pid = Number(match[1]);
        return true;
      }
    }
    return false;
  });
  return pid;
}
