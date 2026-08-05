import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAliasResolver, stripJsonComments } from "../src/main/knowledge/tsconfig-aliases.ts";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { KnowledgeService } from "../src/main/knowledge/knowledge-service.ts";

/** A scratch project directory, removed when the test ends. */
async function projectDir(t: { after: (fn: () => void | Promise<void>) => void }, label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `agentic-alias-${label}-`));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function scanProject(
  t: { after: (fn: () => void | Promise<void>) => void },
  projectPath: string,
): Promise<Awaited<ReturnType<KnowledgeService["scan"]>>> {
  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-alias-db-${Date.now()}-${Math.random()}`));
  t.after(() => db.close());
  return new KnowledgeService(db).scan({ projectPath });
}

/** The graph node an `imports` edge with this specifier points at. */
function importTarget(
  snapshot: Awaited<ReturnType<KnowledgeService["scan"]>>,
  specifier: string,
): { kind: string; path?: string } | undefined {
  const edge = snapshot.graph.edges.find((candidate) => candidate.kind === "imports" && candidate.label === specifier);
  if (!edge) return undefined;
  const node = snapshot.graph.nodes.find((candidate) => candidate.id === edge.target);
  if (!node) return undefined;
  // `group` is deliberately omitted: for a resolved file it holds whichever value
  // won when the node was first added, so asserting it would assert scan order.
  return node.path === undefined ? { kind: node.kind } : { kind: node.kind, path: node.path };
}

test("stripJsonComments removes comments but preserves string contents", () => {
  const input = `{
  // line comment
  "a": "keep // this",
  /* block
     comment */
  "b": "and /* this */ too",
  "c": [1, 2,],
}`;
  const parsed = JSON.parse(stripJsonComments(input)) as Record<string, unknown>;
  assert.equal(parsed.a, "keep // this", "a comment marker inside a string is data, not a comment");
  assert.equal(parsed.b, "and /* this */ too");
  assert.deepEqual(parsed.c, [1, 2], "trailing commas are legal in tsconfig and fatal to JSON.parse");
});

test("stripJsonComments handles escaped quotes without ending the string early", () => {
  const input = String.raw`{"path": "C:\\dir\\file", "quote": "say \"hi\" // not a comment"}`;
  const parsed = JSON.parse(stripJsonComments(input)) as Record<string, unknown>;
  assert.equal(parsed.quote, 'say "hi" // not a comment');
  assert.equal(parsed.path, "C:\\dir\\file");
});

test("loadAliasResolver reads this repo's own tsconfig, comments and all", async () => {
  // The regression that motivated the JSONC parser: this repo's tsconfig carries
  // `//` comments, so JSON.parse throws on it and a naive reader silently ends up
  // with no aliases — failing the one acceptance case the phase exists for.
  const resolver = await loadAliasResolver(process.cwd());
  assert.ok(resolver.hasAliases, "the repo defines compilerOptions.paths");
  assert.deepEqual(resolver.candidates("@contracts"), ["src/contracts/index.ts"]);
  assert.deepEqual(resolver.candidates("@contracts/workflow"), ["src/contracts/workflow"]);
  assert.deepEqual(resolver.candidates("@desktop/main/main.ts"), ["src/main/main.ts"]);
  assert.deepEqual(resolver.candidates("react"), [], "a real package must not match an alias");
  assert.deepEqual(resolver.candidates("./relative"), [], "relative specifiers are resolved by the caller");
});

test("an exact alias wins over a wildcard that also matches", async (t) => {
  const root = await projectDir(t, "precedence");
  await write(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@contracts/*": ["./src/contracts/*"], "@contracts": ["./src/contracts/index.ts"] } },
    }),
  );

  const resolver = await loadAliasResolver(root);
  // Object key order puts the wildcard first; without longest-prefix ordering the
  // bare specifier would resolve through `@contracts/*` and land on `src/contracts/`.
  assert.deepEqual(resolver.candidates("@contracts"), ["src/contracts/index.ts"]);
});

test("loadAliasResolver honours baseUrl when paths are relative to it", async (t) => {
  const root = await projectDir(t, "baseurl");
  await write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "./src", paths: { "~/*": ["./lib/*"] } } }));

  const resolver = await loadAliasResolver(root);
  assert.deepEqual(resolver.candidates("~/util"), ["src/lib/util"]);
});

test("loadAliasResolver merges an extends chain with the nearest config winning", async (t) => {
  const root = await projectDir(t, "extends");
  await write(root, "tsconfig.base.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["./src/shared/*"] } } }));
  await write(root, "tsconfig.json", JSON.stringify({ extends: "./tsconfig.base.json" }));

  const resolver = await loadAliasResolver(root);
  assert.deepEqual(resolver.candidates("@shared/log"), ["src/shared/log"], "paths inherited from the base config");
});

test("alias resolution degrades quietly instead of failing the scan", async (t) => {
  const missing = await projectDir(t, "no-tsconfig");
  const missingResolver = await loadAliasResolver(missing);
  assert.equal(missingResolver.hasAliases, false, "no tsconfig is normal, not an error");

  const malformed = await projectDir(t, "malformed");
  await write(malformed, "tsconfig.json", "{ this is not json at all ");
  const malformedResolver = await loadAliasResolver(malformed);
  assert.equal(malformedResolver.hasAliases, false, "a broken tsconfig must not throw");

  const cyclic = await projectDir(t, "cycle");
  await write(cyclic, "tsconfig.json", JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { paths: { "@a/*": ["./a/*"] } } }));
  const cyclicResolver = await loadAliasResolver(cyclic);
  assert.deepEqual(cyclicResolver.candidates("@a/b"), ["a/b"], "a self-extending config resolves without hanging");

  const escaping = await projectDir(t, "escaping");
  await write(escaping, "tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@out/*": ["../../elsewhere/*"] } } }));
  const escapingResolver = await loadAliasResolver(escaping);
  assert.deepEqual(escapingResolver.candidates("@out/x"), [], "a target outside the project can never be an indexed file");
});

test("a scanned project resolves aliased imports to local files, not npm packages", async (t) => {
  const root = await projectDir(t, "scan");
  await write(
    root,
    "tsconfig.json",
    `{
  // Comments here are the point: this is what a real tsconfig looks like.
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@contracts": ["./src/contracts/index.ts"],
      "@app/*": ["./src/*"],
    },
  },
}`,
  );
  await write(root, "src/contracts/index.ts", "export interface Task { id: string }\n");
  await write(root, "src/main/service.ts", "export const service = 1;\n");
  await write(
    root,
    "src/main/entry.ts",
    `import type { Task } from "@contracts";
import { service } from "@app/main/service";
import { readFile } from "node:fs/promises";
import react from "react";

export const entry = { service, readFile, react } as unknown as Task;
`,
  );

  const snapshot = await scanProject(t, root);

  // `group` is whichever value won when the node was first added — the file's own
  // category if the file was walked before the import that references it. Only
  // `kind` and `path` are the contract here; asserting the group would be
  // asserting scan order.
  assert.deepEqual(
    importTarget(snapshot, "@contracts"),
    { kind: "file", path: "src/contracts/index.ts" },
    "the exact alias resolves to the real file",
  );
  assert.deepEqual(
    importTarget(snapshot, "@app/main/service"),
    { kind: "file", path: "src/main/service.ts" },
    "a wildcard alias resolves through the extension probe",
  );
  assert.equal(importTarget(snapshot, "react")?.kind, "external", "a real package is still external");
  assert.equal(importTarget(snapshot, "node:fs/promises")?.kind, "external", "node builtins stay external");

  const aliasLeaks = snapshot.graph.nodes.filter((node) => node.kind === "external" && node.label.startsWith("@"));
  assert.deepEqual(
    aliasLeaks.map((node) => node.label),
    [],
    "no aliased specifier may survive as an external package node",
  );
});

test("an unresolvable local import is reported as unindexed, not as a dependency", async (t) => {
  const root = await projectDir(t, "unindexed");
  await write(root, "src/entry.ts", 'import { gone } from "./missing";\nexport const entry = gone;\n');

  const snapshot = await scanProject(t, root);
  const target = importTarget(snapshot, "./missing");

  // The distinction the truncation report needs: a local file the index does not
  // contain is a gap in the graph, whereas an external node claims a dependency
  // that does not exist.
  assert.equal(target?.kind, "unindexed");
  assert.equal(
    snapshot.graph.nodes.find((node) => node.kind === "unindexed")?.group,
    "local",
    "an unindexed node is grouped with local code, not with dependencies",
  );
  assert.equal(
    snapshot.graph.nodes.some((node) => node.kind === "external" && node.label === "."),
    false,
    "a relative path must never be labelled as a package",
  );
});
