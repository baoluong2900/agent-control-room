import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { KnowledgeService } from "../src/main/knowledge/knowledge-service.ts";

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
