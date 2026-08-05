import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { KnowledgeFileInsight, KnowledgeSnapshot } from "../src/contracts/knowledge.ts";
import { searchSnapshot } from "../src/main/knowledge/knowledge-search.ts";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { KnowledgeService } from "../src/main/knowledge/knowledge-service.ts";

function file(overrides: Partial<KnowledgeFileInsight> & { path: string }): KnowledgeFileInsight {
  return {
    extension: ".ts",
    language: "TypeScript",
    category: "main",
    purpose: "",
    sizeBytes: 100,
    lines: 10,
    symbols: [],
    imports: [],
    exports: [],
    contentSample: "",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function snapshotOf(files: KnowledgeFileInsight[], edges: KnowledgeSnapshot["graph"]["edges"] = []): KnowledgeSnapshot {
  return {
    projectPath: "/tmp/project",
    projectName: "project",
    generatedAt: "2026-01-01T00:00:00.000Z",
    totalFiles: files.length,
    indexedFiles: files.length,
    skippedFiles: 0,
    totalBytes: 0,
    totalLines: 0,
    languages: [],
    categories: [],
    files,
    graph: {
      nodes: files.map((entry) => ({ id: `file:${entry.path}`, label: entry.path, kind: "file", path: entry.path })),
      edges,
    },
    agentBrief: "",
  };
}

/** Rank of a path in the result, or -1. */
function rankOf(hits: Array<{ path: string }>, filePath: string): number {
  return hits.findIndex((hit) => hit.path === filePath);
}

test("a filename match outranks a mention in the purpose text", () => {
  const snapshot = snapshotOf([
    file({ path: "src/docs/notes.ts", purpose: "Explains how the workflow engine behaves in detail." }),
    file({ path: "src/main/workflow-service.ts", purpose: "Service layer." }),
  ]);

  const { hits } = searchSnapshot(snapshot, "workflow");

  // The plan's acceptance case: the old substring filter ranked these identically
  // because it joined every field into one string and called .includes().
  assert.equal(hits[0].path, "src/main/workflow-service.ts");
  assert.ok(hits[0].score > hits[1].score, "and by a real margin, not a tie");
  assert.ok(hits[0].matches.includes("path"));
  assert.ok(hits[1].matches.includes("purpose"));
});

test("an exact filename beats a prefix, which beats a substring", () => {
  const snapshot = snapshotOf([
    file({ path: "src/a/subtask-helper.ts" }),
    file({ path: "src/b/task.ts" }),
    file({ path: "src/c/task-runner.ts" }),
  ]);

  const { hits } = searchSnapshot(snapshot, "task");

  assert.equal(hits[0].path, "src/b/task.ts", "exact match on the stem wins");
  assert.ok(
    rankOf(hits, "src/c/task-runner.ts") < rankOf(hits, "src/a/subtask-helper.ts"),
    "a prefix match outranks a mid-word substring",
  );
});

test("a symbol match outranks an import of the same name", () => {
  const snapshot = snapshotOf([
    file({ path: "src/consumer.ts", imports: ["./scheduler"] }),
    file({ path: "src/definition.ts", symbols: ["scheduler"], exports: ["scheduler"] }),
  ]);

  const { hits } = searchSnapshot(snapshot, "scheduler");

  // Where a thing is defined is almost always more useful than where it is used.
  assert.equal(hits[0].path, "src/definition.ts");
  assert.ok(hits[0].matches.includes("symbol") || hits[0].matches.includes("export"));
  assert.equal(hits[0].matchedTerm, "scheduler", "the matching term is reported so the UI can explain the hit");
});

test("multi-word queries require every term", () => {
  const snapshot = snapshotOf([
    file({ path: "src/main/workflow-service.ts" }),
    file({ path: "src/main/workflow-repository.ts" }),
    file({ path: "src/main/task-service.ts" }),
  ]);

  const { hits } = searchSnapshot(snapshot, "workflow service");

  // AND, not OR: "workflow service" should find workflow-service.ts, not every
  // file matching either word.
  assert.deepEqual(
    hits.map((hit) => hit.path),
    ["src/main/workflow-service.ts"],
  );
});

test("graph centrality nudges ties but cannot outrank relevance", () => {
  const central = file({ path: "src/hub.ts", purpose: "mentions widget in passing" });
  const named = file({ path: "src/widget.ts" });
  const edges = Array.from({ length: 40 }, (_unused, index) => ({
    id: `e${index}`,
    source: `file:src/hub.ts`,
    target: `file:src/widget.ts`,
    kind: "imports" as const,
    confidence: 0.7,
  }));

  const { hits } = searchSnapshot(snapshotOf([central, named], edges), "widget");

  // hub.ts is wildly more connected, but widget.ts matches by name. The bonus is
  // capped precisely so connectivity cannot reorder that.
  assert.equal(hits[0].path, "src/widget.ts");
});

test("an empty query returns nothing rather than everything", () => {
  const snapshot = snapshotOf([file({ path: "src/a.ts" })]);
  assert.deepEqual(searchSnapshot(snapshot, "   ").hits, []);
  assert.equal(searchSnapshot(snapshot, "").scanned, 1, "but still reports what it would have searched");
});

test("search is case-insensitive and honours the limit", () => {
  const snapshot = snapshotOf(
    Array.from({ length: 30 }, (_unused, index) => file({ path: `src/widget-${index}.ts` })),
  );

  assert.equal(searchSnapshot(snapshot, "WIDGET").hits.length, 20, "default limit applies");
  assert.equal(searchSnapshot(snapshot, "widget", 5).hits.length, 5);
  assert.equal(searchSnapshot(snapshot, "widget", 5).scanned, 30, "scanned reflects the corpus, not the page");
});

test("searching a project that was never scanned is empty, not an error", async (t) => {
  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-search-db-${Date.now()}`));
  t.after(() => db.close());
  const service = new KnowledgeService(db);

  // A search box must never kick off a minute of scanning as a side effect.
  const result = service.search({ projectPath: "/nonexistent/project", query: "anything" });

  assert.deepEqual(result.hits, []);
  assert.equal(result.scanned, 0);
});
