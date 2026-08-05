import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { KnowledgeScanProgress } from "../src/contracts/knowledge.ts";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { KnowledgeService } from "../src/main/knowledge/knowledge-service.ts";

/** Collects progress, and can run a hook when a chosen phase arrives. */
function progressRecorder(onPhase?: (event: KnowledgeScanProgress) => void) {
  const events: KnowledgeScanProgress[] = [];
  const webContents = {
    send: (channel: string, payload: KnowledgeScanProgress) => {
      if (channel !== "knowledge:progress") return;
      events.push(payload);
      onPhase?.(payload);
    },
  };
  return { events, provider: () => webContents as unknown as never };
}

async function projectWithFiles(
  t: { after: (fn: () => void | Promise<void>) => void },
  count: number,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-progress-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await fs.writeFile(
      path.join(dir, "src", `mod-${index}.ts`),
      `import { helper } from "./helper";\nexport const value${index} = helper + ${index};\n`,
      "utf8",
    );
  }
  await fs.writeFile(path.join(dir, "src", "helper.ts"), "export const helper = 1;\n", "utf8");
  return dir;
}

async function serviceFor(
  t: { after: (fn: () => void | Promise<void>) => void },
  provider?: () => never,
): Promise<{ service: KnowledgeService; db: DesktopDatabase }> {
  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-progress-db-${Date.now()}-${Math.random()}`));
  t.after(() => db.close());
  return { service: new KnowledgeService(db, provider), db };
}

test("a scan with a scanId reports progress through to done", async (t) => {
  const root = await projectWithFiles(t, 40);
  const recorder = progressRecorder();
  const { service } = await serviceFor(t, recorder.provider);

  const snapshot = await service.scan({ projectPath: root, scanId: "scan-1" });

  assert.ok(snapshot.indexedFiles >= 40, "the scan indexed the project");
  assert.ok(recorder.events.length >= 3, `expected several progress events, got ${recorder.events.length}`);

  const phases = recorder.events.map((event) => event.phase);
  assert.equal(phases[0], "collecting", "the tree walk is announced before it starts");
  assert.ok(phases.includes("analyzing"), "per-file progress is reported");
  assert.ok(phases.includes("graphing"), "graph building is a distinct phase");
  assert.equal(phases.at(-1), "done", "the final event closes the progress UI");

  assert.ok(
    recorder.events.every((event) => event.scanId === "scan-1" && event.projectPath === path.resolve(root)),
    "every event is attributable to the scan that produced it",
  );

  const analyzing = recorder.events.filter((event) => event.phase === "analyzing");
  assert.ok(
    analyzing.every((event) => event.total >= event.processed),
    "processed never exceeds total",
  );
  // Monotonic progress: a bar that goes backwards is worse than no bar.
  const counts = analyzing.map((event) => event.processed);
  assert.deepEqual(counts, [...counts].sort((a, b) => a - b), "progress only moves forward");
  assert.equal(analyzing.at(-1)?.processed, analyzing.at(-1)?.total, "the last analyze event reaches the total");
});

test("a scan without a scanId stays silent", async (t) => {
  const root = await projectWithFiles(t, 8);
  const recorder = progressRecorder();
  const { service } = await serviceFor(t, recorder.provider);

  await service.scan({ projectPath: root });

  // Callers that never opted into progress (harnesses, the export path) must not
  // pay for events nobody is listening to.
  assert.deepEqual(recorder.events, []);
});

test("cancelScan stops a scan and leaves the previous snapshot intact", async (t) => {
  const root = await projectWithFiles(t, 200);

  // Cancel from inside the progress hook, the moment the first analyze batch
  // reports. That makes the abort land mid-scan deterministically instead of
  // racing a timer against the walk.
  let service!: KnowledgeService;
  const recorder = progressRecorder((event) => {
    if (event.phase === "analyzing") service.cancelScan("scan-cancel");
  });
  const created = await serviceFor(t, recorder.provider);
  service = created.service;

  // Establish a baseline snapshot the cancelled scan must not damage.
  const baseline = await service.scan({ projectPath: root });
  assert.ok(baseline.indexedFiles > 0);
  recorder.events.length = 0;

  const result = await service.scan({ projectPath: root, scanId: "scan-cancel", maxFiles: 5_000 });

  assert.equal(
    recorder.events.some((event) => event.phase === "cancelled"),
    true,
    "the renderer is told the scan stopped rather than being left spinning",
  );
  assert.equal(
    recorder.events.some((event) => event.phase === "done"),
    false,
    "a cancelled scan must not also report done",
  );
  // The contract is that scan() resolves to a snapshot; a cancelled scan wrote
  // nothing, so the previous one is still the truth.
  assert.equal(result.generatedAt, baseline.generatedAt, "the stored snapshot was not overwritten");
});

test("a cancelled scanId does not poison the next scan", async (t) => {
  const root = await projectWithFiles(t, 12);
  const recorder = progressRecorder();
  const { service } = await serviceFor(t, recorder.provider);

  service.cancelScan("reused-id");
  // First use of the id is cancelled before it starts...
  await service.scan({ projectPath: root, scanId: "reused-id" }).catch(() => undefined);

  recorder.events.length = 0;
  // ...and the same id must work normally afterwards, because scan() retires it.
  const snapshot = await service.scan({ projectPath: root, scanId: "reused-id" });

  assert.ok(snapshot.indexedFiles > 0, "the second scan ran to completion");
  assert.equal(recorder.events.at(-1)?.phase, "done");
});

test("cancelScan reports whether it had an id to act on", async (t) => {
  const { service } = await serviceFor(t);
  assert.equal(service.cancelScan(""), false, "an empty id is not a cancellable scan");
  assert.equal(service.cancelScan("anything"), true);
});
