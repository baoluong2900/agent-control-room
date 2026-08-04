import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { KnowledgeService } from "../src/main/knowledge/knowledge-service.ts";
test("knowledge graph caps never leave dangling edges and XML export strips invalid control chars", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-knowledge-large-project-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-knowledge-large-db-"));

  for (let fileIndex = 0; fileIndex < 300; fileIndex += 1) {
    const imports = Array.from({ length: 10 }, (_, importIndex) => `import { z } from "pkg-${fileIndex}-${importIndex}";`);
    const exports = Array.from({ length: 12 }, (_, exportIndex) => `export function fn_${fileIndex}_${exportIndex}() {}`);
    fs.writeFileSync(path.join(root, `mod${fileIndex}.ts`), [...imports, ...exports].join("\n"), "utf8");
  }
  fs.writeFileSync(path.join(root, "ansi.ts"), `export const banner = "${String.fromCharCode(0x1b)}[31mred${String.fromCharCode(0x07)}";\n`, "utf8");

  const db = await DesktopDatabase.open(userData);
  const service = new KnowledgeService(db);
  const snapshot = await service.scan({ projectPath: root });
  const nodeIds = new Set(snapshot.graph.nodes.map((node) => node.id));

  assert.equal(
    snapshot.graph.edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target)),
    false,
  );

  const xml = await service.export(root, "xml");
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(xml.content), false);
  db.close();
});


test("knowledge service scans a project into a persistent codegraph and exports agent context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-knowledge-project-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-knowledge-db-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "sample-agent-project",
      description: "Small project used to verify knowledge graph indexing.",
      scripts: { test: "node --test" },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(root, "README.md"), "# Sample Agent Project\n\nProject overview.\n", "utf8");
  fs.writeFileSync(path.join(root, "docs", "architecture.md"), "# Architecture\n\nRenderer calls services.\n", "utf8");
  fs.writeFileSync(
    path.join(root, "src", "main.ts"),
    [
      'import { formatMessage } from "./utils";',
      "",
      "export function runWorkflow(name: string): string {",
      "  return formatMessage(name);",
      "}",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "src", "utils.ts"),
    [
      "export function formatMessage(name: string): string {",
      '  return `hello ${name}`;',
      "}",
    ].join("\n"),
    "utf8",
  );

  const db = await DesktopDatabase.open(userData);
  const service = new KnowledgeService(db);
  const snapshot = await service.scan({ projectPath: root, maxFiles: 30, maxFileBytes: 50_000 });

  assert.equal(snapshot.projectPath, root);
  assert.ok(snapshot.indexedFiles >= 5);
  assert.ok(snapshot.files.some((file) => file.path === "src/main.ts"));
  assert.ok(snapshot.files.some((file) => file.path === "src/utils.ts"));
  assert.ok(snapshot.files.find((file) => file.path === "src/main.ts")?.imports.includes("./utils"));
  assert.ok(snapshot.files.find((file) => file.path === "src/main.ts")?.exports.includes("runWorkflow"));
  assert.ok(snapshot.graph.nodes.some((node) => node.kind === "file" && node.path === "src/main.ts"));
  assert.ok(snapshot.graph.edges.some((edge) => edge.kind === "imports" && edge.label === "./utils"));
  assert.match(snapshot.agentBrief, /knowledgebase indexed/);

  const stored = service.get(root);
  assert.equal(stored?.indexedFiles, snapshot.indexedFiles);
  assert.equal(stored?.graph.edges.length, snapshot.graph.edges.length);

  const markdown = await service.export(root, "markdown");
  assert.equal(markdown.fileName.endsWith(".knowledge.md"), true);
  assert.match(markdown.content, /CodeGraph Knowledgebase/);
  assert.match(markdown.content, /src\/main\.ts/);

  const json = await service.export(root, "json");
  assert.equal(JSON.parse(json.content).projectPath, root);

  const xml = await service.export(root, "xml");
  assert.match(xml.content, /<knowledgebase/);
  assert.match(xml.content, /<edge kind="imports"/);

  db.close();
});
