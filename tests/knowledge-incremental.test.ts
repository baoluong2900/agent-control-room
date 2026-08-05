import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { KnowledgeScanProgress } from "../src/contracts/knowledge.ts";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { KnowledgeService } from "../src/main/knowledge/knowledge-service.ts";

type Harness = {
  service: KnowledgeService;
  db: DesktopDatabase;
  root: string;
  /** `reused` from the most recent `done` event. */
  lastReused: () => number;
  events: KnowledgeScanProgress[];
};

async function harness(t: { after: (fn: () => void | Promise<void>) => void }, fileCount: number): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-incr-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    await fs.writeFile(
      path.join(root, "src", `mod-${index}.ts`),
      `export const value${index} = ${index};\n`,
      "utf8",
    );
  }

  const events: KnowledgeScanProgress[] = [];
  const webContents = {
    send: (channel: string, payload: KnowledgeScanProgress) => {
      if (channel === "knowledge:progress") events.push(payload);
    },
  };

  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-incr-db-${Date.now()}-${Math.random()}`));
  t.after(() => db.close());

  return {
    db,
    root,
    events,
    service: new KnowledgeService(db, () => webContents as never),
    lastReused: () => events.filter((event) => event.phase === "done").at(-1)?.reused ?? 0,
  };
}

test("a first scan populates the per-file index and reuses nothing", async (t) => {
  const h = await harness(t, 10);

  const snapshot = await h.service.scan({ projectPath: h.root, scanId: "first" });

  assert.equal(snapshot.indexedFiles, 10);
  assert.equal(h.lastReused(), 0, "a cold index has nothing to reuse");
  assert.equal(h.db.listKnowledgeFiles(path.resolve(h.root)).size, 10, "every indexed file is recorded");
});

test("an unchanged rescan reuses every file instead of re-reading it", async (t) => {
  const h = await harness(t, 10);
  await h.service.scan({ projectPath: h.root, scanId: "first" });
  h.events.length = 0;

  const snapshot = await h.service.scan({ projectPath: h.root, scanId: "second" });

  assert.equal(snapshot.indexedFiles, 10, "the snapshot is identical in content");
  assert.equal(h.lastReused(), 10, "nothing changed on disk, so nothing needed re-parsing");
});

test("a changed file is re-analyzed while its neighbours are reused", async (t) => {
  const h = await harness(t, 10);
  const first = await h.service.scan({ projectPath: h.root, scanId: "first" });
  assert.ok(first.files.some((file) => file.symbols.includes("value3")));
  h.events.length = 0;

  // Change both the bytes and the symbol, so a stale cache hit would be visible
  // in the snapshot rather than only in the counters.
  await fs.writeFile(path.join(h.root, "src", "mod-3.ts"), "export const renamedSymbol = 99;\n", "utf8");

  const second = await h.service.scan({ projectPath: h.root, scanId: "second" });

  assert.equal(h.lastReused(), 9, "only the edited file is re-read");
  const changed = second.files.find((file) => file.path === "src/mod-3.ts");
  assert.ok(changed?.symbols.includes("renamedSymbol"), "the new symbol reached the snapshot");
  assert.equal(
    second.files.some((file) => file.symbols.includes("value3")),
    false,
    "the stale analysis must not survive the edit",
  );
});

test("an mtime bump with identical bytes does not re-parse", async (t) => {
  const h = await harness(t, 6);
  await h.service.scan({ projectPath: h.root, scanId: "first" });
  h.events.length = 0;

  const target = path.join(h.root, "src", "mod-2.ts");
  const original = await fs.readFile(target, "utf8");
  // Rewrite identical content and push mtime forward: the size/mtime shortcut misses,
  // so this only stays cheap if the content hash short-circuits the analysis.
  await fs.writeFile(target, original, "utf8");
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(target, future, future);

  const snapshot = await h.service.scan({ projectPath: h.root, scanId: "second" });

  assert.equal(h.lastReused(), 6, "the content hash matched, so the parse was skipped");
  assert.equal(snapshot.indexedFiles, 6);
});

test("a deleted file disappears from the index and the snapshot", async (t) => {
  const h = await harness(t, 8);
  await h.service.scan({ projectPath: h.root, scanId: "first" });

  await fs.rm(path.join(h.root, "src", "mod-5.ts"));
  const snapshot = await h.service.scan({ projectPath: h.root, scanId: "second" });

  assert.equal(snapshot.indexedFiles, 7);
  assert.equal(
    snapshot.files.some((file) => file.path === "src/mod-5.ts"),
    false,
    "the snapshot must not carry a file that no longer exists",
  );
  const index = h.db.listKnowledgeFiles(path.resolve(h.root));
  assert.equal(index.size, 7);
  assert.equal(index.has("src/mod-5.ts"), false, "the stale row is removed, not merely ignored");
});

test("force ignores the cache so a changed analyzer can be re-applied", async (t) => {
  const h = await harness(t, 10);
  await h.service.scan({ projectPath: h.root, scanId: "first" });
  h.events.length = 0;

  const snapshot = await h.service.scan({ projectPath: h.root, scanId: "forced", force: true });

  assert.equal(h.lastReused(), 0, "force must re-read everything even when nothing changed");
  assert.equal(snapshot.indexedFiles, 10);
});

test("the graph is rebuilt from cached insights, not just the re-read files", async (t) => {
  const h = await harness(t, 4);
  await fs.writeFile(path.join(h.root, "src", "helper.ts"), "export const helper = 1;\n", "utf8");
  await fs.writeFile(
    path.join(h.root, "src", "uses-helper.ts"),
    'import { helper } from "./helper";\nexport const used = helper;\n',
    "utf8",
  );
  await h.service.scan({ projectPath: h.root, scanId: "first" });
  h.events.length = 0;

  // Nothing changes: every file is a cache hit, so the graph can only be correct
  // if it is rebuilt from the cached insights rather than from files read this run.
  const snapshot = await h.service.scan({ projectPath: h.root, scanId: "second" });

  assert.ok(h.lastReused() > 0, "this run was served from the cache");
  const edge = snapshot.graph.edges.find((candidate) => candidate.kind === "imports" && candidate.label === "./helper");
  assert.ok(edge, "the import edge survives a fully-cached rescan");
  const target = snapshot.graph.nodes.find((node) => node.id === edge?.target);
  assert.equal(target?.path, "src/helper.ts", "and it still resolves to the real local file");
});

test("a corrupt cached insight is discarded rather than served", async (t) => {
  const h = await harness(t, 4);
  await h.service.scan({ projectPath: h.root, scanId: "first" });

  // Simulate a row written by an older/broken build.
  h.db.replaceKnowledgeFiles(path.resolve(h.root), [
    { path: "src/mod-0.ts", hash: "deadbeef", mtime: "1970-01-01T00:00:00.000Z", bytes: 1, insight: null as never },
  ]);

  const index = h.db.listKnowledgeFiles(path.resolve(h.root));
  assert.equal(index.size, 0, "an unparseable insight must not be offered as a cache hit");

  // And the next scan still produces a complete snapshot.
  const snapshot = await h.service.scan({ projectPath: h.root, scanId: "second" });
  assert.equal(snapshot.indexedFiles, 4);
});
