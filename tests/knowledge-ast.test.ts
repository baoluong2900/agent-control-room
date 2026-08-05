import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isAstParseable, parseModule } from "../src/main/knowledge/ast-parser.ts";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import { KnowledgeService } from "../src/main/knowledge/knowledge-service.ts";

/** Parses TS source and returns the result, asserting the parser engaged at all. */
function parse(source: string, fileName = "sample.ts") {
  const parsed = parseModule(fileName, source);
  assert.ok(parsed, `expected ${fileName} to be AST-parseable`);
  return parsed;
}

test("isAstParseable covers TS/JS and nothing else", () => {
  for (const name of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs"]) {
    assert.equal(isAstParseable(name), true, `${name} should use the parser`);
  }
  // These keep the regex extractors: the TS compiler cannot parse them, and a
  // wrong parser is worse than a crude one.
  for (const name of ["a.py", "a.go", "a.rs", "a.css", "a.md", "a.json", "Dockerfile"]) {
    assert.equal(isAstParseable(name), false, `${name} must fall back to regex`);
  }
});

test("an import inside a comment or a string does not become a dependency", () => {
  const parsed = parse(`
// import { fake } from "commented-package";
/* import { alsoFake } from "block-commented-package"; */
const docs = 'import { quoted } from "string-package";';
const template = \`import { templated } from "template-package";\`;
import { real } from "real-package";
export const use = { real, docs, template };
`);

  // This is the headline regex failure: text-level matching could not tell code
  // from prose, so a commented-out import produced a real graph edge.
  assert.deepEqual(parsed.imports, ["real-package"]);
});

test("export * from is captured as both an import and an export", () => {
  const parsed = parse('export * from "./barrel";\nexport { named } from "./other";\n');

  // No regex in the old extractor covered `export * from`, so re-export barrels —
  // the whole of src/contracts/index.ts, for instance — looked like dead ends.
  assert.deepEqual(parsed.imports, ["./barrel", "./other"]);
  assert.ok(parsed.exports.includes("*"), "a star re-export is recorded rather than dropped");
  assert.ok(parsed.exports.includes("named"));
});

test("every import form the app actually uses is recognised", () => {
  const parsed = parse(`
import defaultExport from "./default";
import * as namespace from "./namespace";
import { named, other as renamed } from "./named";
import type { OnlyAType } from "./types";
import "./side-effect";
const required = require("./required");
const lazy = await import("./dynamic");
import legacy = require("./equals");
export const all = { defaultExport, namespace, named, renamed, required, lazy, legacy };
export type Alias = OnlyAType;
`);

  assert.deepEqual(
    [...parsed.imports].sort(),
    [
      "./default",
      "./dynamic",
      "./equals",
      "./named",
      "./namespace",
      "./required",
      "./side-effect",
      "./types",
    ].sort(),
  );
});

test("a computed specifier is skipped rather than guessed at", () => {
  const parsed = parse('const name = "./x";\nconst mod = await import(name);\nexport const m = mod;\n');
  assert.deepEqual(parsed.imports, [], "import(variable) has no statically-known target");
});

test("declarations and their export status are read from the tree", () => {
  const parsed = parse(`
export function exportedFn() {}
function privateFn() {}
export class ExportedClass {}
export interface ExportedInterface { a: string }
export type ExportedType = string;
export enum ExportedEnum { A }
export const exportedConst = 1;
const privateConst = 2;
export const { destructuredA, destructuredB } = { destructuredA: 1, destructuredB: 2 };
export default function defaultFn() {}
`);

  for (const name of ["exportedFn", "privateFn", "ExportedClass", "ExportedInterface", "ExportedType", "ExportedEnum", "exportedConst", "privateConst"]) {
    assert.ok(parsed.symbols.includes(name), `${name} should be a declared symbol`);
  }

  assert.ok(parsed.exports.includes("exportedFn"));
  assert.ok(parsed.exports.includes("ExportedClass"));
  assert.ok(parsed.exports.includes("default"), "the default slot is an export");
  assert.equal(parsed.exports.includes("privateFn"), false, "a non-exported declaration is not an export");
  assert.equal(parsed.exports.includes("privateConst"), false);
  // Destructured exports contribute each bound name, which is what someone
  // searching for `destructuredA` expects to find.
  assert.ok(parsed.exports.includes("destructuredA"));
  assert.ok(parsed.exports.includes("destructuredB"));
});

test("renamed exports are recorded under their exported name", () => {
  const parsed = parse("const internal = 1;\nexport { internal as publicName };\n");
  assert.ok(parsed.exports.includes("publicName"), "consumers import the exported name, not the local one");
});

test("a syntax error yields partial results instead of failing the file", () => {
  // Someone mid-edit must not lose their file from the index. createSourceFile
  // recovers, so the imports before the damage still land.
  const parsed = parse('import { good } from "./good";\nexport function broken( {\n');
  assert.deepEqual(parsed.imports, ["./good"]);
});

test("TSX and JSX parse without their syntax being mistaken for type assertions", () => {
  const tsx = parse('import React from "react";\nexport const El = () => <div className="x">hi</div>;\n', "El.tsx");
  assert.deepEqual(tsx.imports, ["react"]);
  assert.ok(tsx.symbols.includes("El"));

  const jsx = parse('import React from "react";\nexport const J = () => <span>hi</span>;\n', "J.jsx");
  assert.deepEqual(jsx.imports, ["react"]);
});

test("a scan uses the AST for TS and regex for other languages", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-ast-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const db = await DesktopDatabase.open(path.join(os.tmpdir(), `agentic-ast-db-${Date.now()}`));
  t.after(() => db.close());

  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "real.ts"), "export const real = 1;\n", "utf8");
  await fs.writeFile(
    path.join(root, "src", "entry.ts"),
    '// import { ghost } from "./ghost";\nimport { real } from "./real";\nexport const entry = real;\n',
    "utf8",
  );
  // Python keeps the regex path; its imports must still be extracted.
  await fs.writeFile(path.join(root, "src", "script.py"), "from os import path\nimport sys\n", "utf8");

  const snapshot = await new KnowledgeService(db).scan({ projectPath: root });

  const entry = snapshot.files.find((file) => file.path === "src/entry.ts");
  assert.deepEqual(entry?.imports, ["./real"], "the commented import must not reach the snapshot");
  assert.equal(
    snapshot.graph.nodes.some((node) => node.detail?.includes("./ghost")),
    false,
    "and it must not produce a graph node either",
  );

  const script = snapshot.files.find((file) => file.path === "src/script.py");
  assert.ok(script, "the Python file is still indexed");
  assert.ok(
    script.imports.includes("os") || script.imports.includes("sys"),
    `regex extraction still works for Python, got ${JSON.stringify(script.imports)}`,
  );
});
