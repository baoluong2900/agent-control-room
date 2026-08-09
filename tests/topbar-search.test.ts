import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { KnowledgeSearchHit, KnowledgeSearchResult } from "../src/contracts/knowledge.ts";
import {
  MAX_FILE_RESULTS,
  chooseEnterTarget,
  describeHit,
  matchNavigationAreas,
  sourceSearchMessage,
  summarizeSourceSearch,
} from "../src/renderer/components/topbar-search.ts";

/**
 * The top-bar search box used to filter the navigation list only, so "Search
 * workspace" meant "open a menu item". These tests pin the ranked-source half and,
 * more importantly, the state machine that decides what the popover says — the
 * distinction between "nothing indexed" and "nothing matched" is the whole point
 * of the change, and it is invisible to the type checker.
 */

function hit(overrides: Partial<KnowledgeSearchHit> & { path: string }): KnowledgeSearchHit {
  return {
    language: "TypeScript",
    category: "main",
    purpose: "",
    score: 100,
    matches: ["path"],
    ...overrides,
  };
}

function result(overrides: Partial<KnowledgeSearchResult> & { query: string }): KnowledgeSearchResult {
  return { hits: [], scanned: 200, ...overrides };
}

test("an empty query lists every area so the box still works as a launcher", () => {
  const areas = matchNavigationAreas("   ");
  assert.ok(areas.length >= 9, `expected the full navigation list, got ${areas.length}`);
});

test("area matching reads the summary as well as the label", () => {
  // "codegraph" appears only in Knowledge's summary, never in its label.
  const areas = matchNavigationAreas("codegraph");
  assert.deepEqual(
    areas.map((area) => area.key),
    ["Knowledge"],
  );
});

test("an empty query leaves the source half idle", () => {
  const state = summarizeSourceSearch({ query: "  ", hasProject: true, result: null });
  assert.equal(state.kind, "idle");
  assert.equal(sourceSearchMessage(state), null, "idle must render no row at all");
});

test("a query with no project asks for a project instead of searching", () => {
  const state = summarizeSourceSearch({ query: "workflow", hasProject: false, result: null });
  assert.equal(state.kind, "no-project");
  assert.match(sourceSearchMessage(state) ?? "", /Select a project/);
});

test("a result for an older query counts as still searching", () => {
  // The debounce means a stale result is in state while the user keeps typing.
  // Rendering it would show rows that do not match the visible query.
  const state = summarizeSourceSearch({
    query: "workflow-service",
    hasProject: true,
    result: result({ query: "workflow", hits: [hit({ path: "src/a.ts" })] }),
  });
  assert.equal(state.kind, "searching");
});

test("a never-scanned project is reported as not indexed, not as empty", () => {
  // `scanned: 0` means there is no snapshot: the fix is to scan, not to retype.
  const state = summarizeSourceSearch({
    query: "workflow",
    hasProject: true,
    result: result({ query: "workflow", scanned: 0 }),
  });
  assert.equal(state.kind, "not-indexed");
  assert.match(sourceSearchMessage(state) ?? "", /No CodeGraph yet/);
});

test("no match across an indexed project reports how much was searched", () => {
  const state = summarizeSourceSearch({
    query: "nothing-here",
    hasProject: true,
    result: result({ query: "nothing-here", scanned: 812 }),
  });
  assert.equal(state.kind, "empty");
  assert.match(sourceSearchMessage(state) ?? "", /812 indexed files/);
});

test("hits are capped and carry no message row", () => {
  const many = Array.from({ length: 20 }, (_, index) => hit({ path: `src/file-${index}.ts` }));
  const state = summarizeSourceSearch({
    query: "file",
    hasProject: true,
    result: result({ query: "file", hits: many }),
  });
  assert.equal(state.kind, "hits");
  assert.equal(state.kind === "hits" ? state.hits.length : -1, MAX_FILE_RESULTS);
  assert.equal(sourceSearchMessage(state), null);
});

test("a hit explains itself with its match reasons and matched symbol", () => {
  assert.equal(
    describeHit(hit({ path: "src/a.ts", matches: ["symbol", "export"], matchedTerm: "startAgent" })),
    "symbol · export · startAgent",
  );
  assert.equal(describeHit(hit({ path: "src/a.ts", matches: [] })), "match");
});

test("an exact area name wins over a file of the same name", () => {
  // Typing "Tasks" and landing in tasks.ts would be surprising.
  const areas = matchNavigationAreas("tasks");
  const state = summarizeSourceSearch({
    query: "tasks",
    hasProject: true,
    result: result({ query: "tasks", hits: [hit({ path: "src/renderer/tasks/tasks.ts" })] }),
  });
  assert.deepEqual(chooseEnterTarget("tasks", areas, state), { kind: "area", key: "Tasks" });
});

test("a strong source match beats a fuzzy area match", () => {
  const areas = matchNavigationAreas("workflow");
  assert.ok(areas.length > 0, "fixture assumes 'workflow' fuzzily matches an area");
  const state = summarizeSourceSearch({
    query: "workflow",
    hasProject: true,
    result: result({
      query: "workflow",
      hits: [hit({ path: "src/main/workflows/workflow-service.ts", matches: ["path"] })],
    }),
  });
  assert.deepEqual(chooseEnterTarget("workflow", areas, state), {
    kind: "file",
    path: "src/main/workflows/workflow-service.ts",
  });
});

test("a weak (prose-only) source match does not steal Enter from an area", () => {
  const areas = matchNavigationAreas("analytics");
  const state = summarizeSourceSearch({
    query: "analytics",
    hasProject: true,
    result: result({ query: "analytics", hits: [hit({ path: "docs/notes.md", matches: ["purpose"] })] }),
  });
  assert.deepEqual(chooseEnterTarget("analytics", areas, state), { kind: "area", key: "Analytics" });
});

test("Enter does nothing when neither half has a candidate", () => {
  const state = summarizeSourceSearch({
    query: "zzzz",
    hasProject: true,
    result: result({ query: "zzzz" }),
  });
  assert.equal(chooseEnterTarget("zzzz", [], state), null);
});

test("the top bar is wired to the shared ranked search, not a second filter", async () => {
  const [topbar, app, css] = await Promise.all([
    readFile(new URL("../src/renderer/components/TopBar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(topbar, /knowledge\s*\n?\s*\.search\(/, "must call knowledge:search rather than re-filtering locally");
  assert.match(topbar, /onOpenSourceFile/);
  assert.doesNotMatch(topbar, /Search workspace"\s*\n?\s*value/, "placeholder must no longer claim only navigation");
  assert.match(app, /focusRequest=\{sourceFocus\}/, "App must hand the focused path to Knowledge");

  // Invented class names typecheck and render unstyled, so pin that both exist.
  assert.match(css, /\.search-results-popover \.search-source-group/);
  assert.match(css, /p\.search-source-hit/);
});
