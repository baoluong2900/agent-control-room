import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent } from "../src/contracts/agent.ts";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { AgentProcessManager } from "../src/main/processes/agent-process-manager.ts";

/**
 * Output coalescing: a streaming CLI writes stdout in whatever size the pipe
 * hands over, and publishing each chunk on its own cost one sqlite INSERT plus
 * one IPC message plus one renderer store update apiece. These tests pin the
 * two properties that make batching safe: no byte is lost or reordered, and a
 * burst really does collapse into far fewer events than it had chunks.
 */

async function openDatabase(label: string): Promise<DesktopDatabase> {
  return DesktopDatabase.open(path.join(os.tmpdir(), `agentic-${label}-${Date.now()}-${Math.random()}`));
}

async function waitForExitEvent(events: AgentEvent[], runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (events.some((event) => event.runId === runId && (event.type === "run:exit" || event.type === "run:error"))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never reported an exit`);
}

test("coalesced stdout keeps every byte and the order the CLI produced", async () => {
  const db = await openDatabase("coalesce-order");
  const events: AgentEvent[] = [];
  const manager = new AgentProcessManager(db, () => ({ send: (_channel: string, event: AgentEvent) => void events.push(event) }) as never);

  // 200 separate writes: without coalescing this is 200 INSERTs and 200 IPC
  // messages. The sequence is what proves nothing was dropped or reordered.
  const started = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "seq 1 200",
    shellCommand: "seq 1 200",
  });

  await waitForExitEvent(events, started.runId);

  const streamed = events
    .filter((event) => event.runId === started.runId && event.type === "run:stdout")
    .map((event) => event.message ?? "")
    .join("");

  const numbers = streamed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  assert.equal(numbers.length, 200, `expected 200 lines, got ${numbers.length}`);
  assert.equal(numbers[0], "1");
  assert.equal(numbers[199], "200");

  // The persisted log must agree with what the renderer was shown.
  const logged = db
    .listTerminalLogs(started.runId)
    .filter((row) => row.stream === "stdout")
    .map((row) => row.message)
    .join("");
  assert.equal(
    logged.replace(/\s+/g, " ").trim(),
    streamed.replace(/\s+/g, " ").trim(),
    "database log and emitted output disagree",
  );

  db.close();
});

test("a burst of writes is published as fewer events than it had chunks", async () => {
  const db = await openDatabase("coalesce-count");
  const events: AgentEvent[] = [];
  const manager = new AgentProcessManager(db, () => ({ send: (_channel: string, event: AgentEvent) => void events.push(event) }) as never);

  const started = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "seq 1 400",
    shellCommand: "seq 1 400",
  });

  await waitForExitEvent(events, started.runId);

  const stdoutEvents = events.filter((event) => event.runId === started.runId && event.type === "run:stdout");
  const lines = stdoutEvents
    .map((event) => event.message ?? "")
    .join("")
    .split("\n")
    .filter((line) => line.trim());

  assert.equal(lines.length, 400, "output was lost while batching");
  // The point of the change: far fewer publishes than lines of output. Batching
  // 400 lines into more than 100 events would mean the buffer is not working.
  assert.ok(
    stdoutEvents.length < 100,
    `expected coalesced output, got ${stdoutEvents.length} events for 400 lines`,
  );

  db.close();
});

test("output buffered when a run is stopped still lands before the stop event", async () => {
  const db = await openDatabase("coalesce-stop");
  const events: AgentEvent[] = [];
  const manager = new AgentProcessManager(db, () => ({ send: (_channel: string, event: AgentEvent) => void events.push(event) }) as never);

  // A steady stream rather than one echo, because "wait N ms then stop" cannot
  // express what this test needs: on this machine `zsh -lc` takes 65-82ms to
  // reach its first write, so a 10ms wait killed the shell before it printed
  // anything at all and there was no buffered output to lose. Writing every 5ms
  // — well inside OUTPUT_FLUSH_MS — guarantees the buffer is non-empty whenever
  // stop() arrives, whatever the shell's startup cost happens to be.
  const started = await manager.start({
    cliId: "shell",
    cwd: process.cwd(),
    prompt: "stream markers",
    shellCommand: "while true; do echo marker-before-stop; sleep 0.005; done",
  });

  // Synchronise on the stream actually flowing instead of on wall-clock time.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (events.some((event) => event.runId === started.runId && event.type === "run:stdout")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  // Put a chunk in the buffer and stop in the same synchronous turn, so the
  // flush timer provably cannot have fired in between. Racing a real write
  // against a 32ms timer instead would pass even with stop()'s flush deleted —
  // the timer flushes it anyway — which is a test that cannot fail.
  const buffered = "marker-before-stop\n";
  (manager as unknown as { handleOutput(runId: string, type: "run:stdout", message: string): void }).handleOutput(
    started.runId,
    "run:stdout",
    buffered,
  );
  const beforeCount = events.filter(
    (event) => event.runId === started.runId && event.type === "run:stdout",
  ).length;
  await manager.stop(started.runId);

  const own = events.filter((event) => event.runId === started.runId);
  const stopIndex = own.findIndex((event) => event.status === "stopped");
  assert.ok(stopIndex >= 0, "expected a stop event");

  // Only the events up to the stop are this test's subject. A signalled child
  // stays alive for up to the kill grace period and an agent CLI prints on its
  // way out, so stdout *after* the stop event is real late output from a dying
  // process — not a buffer that was flushed too late. Asserting its absence
  // would be asserting the child's exit timing, which is not ours to control.
  const beforeStop = own.slice(0, stopIndex);
  const stdout = beforeStop
    .filter((event) => event.type === "run:stdout")
    .map((event) => event.message ?? "")
    .join("");

  assert.match(stdout, /marker-before-stop/, "buffered output was discarded by stop()");
  // The chunk that was still buffered when stop() was called has to be one of
  // the events published above the stop, not merely present somewhere.
  const publishedByStop = beforeStop.filter((event) => event.type === "run:stdout").length;
  assert.ok(
    publishedByStop > beforeCount,
    `stop() published nothing: ${publishedByStop} stdout events before the stop, ${beforeCount} before the buffered write`,
  );

  // And the persisted log has to contain that same text: the flush must write
  // to sqlite as well as publish, or the terminal would replay short after a
  // reload.
  const logged = db
    .listTerminalLogs(started.runId)
    .filter((row) => row.stream === "stdout")
    .map((row) => row.message)
    .join("");
  assert.ok(logged.includes(buffered), "database log is missing output that was already published");

  db.close();
});
