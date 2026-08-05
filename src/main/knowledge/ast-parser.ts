import path from "node:path";
import ts from "typescript";

/**
 * AST-based import/export/symbol extraction for TypeScript and JavaScript.
 *
 * The regex extractors this replaces ran over raw text, so they could not tell
 * code from a comment or a string literal: a commented-out import produced a real
 * graph edge, and `"import x from 'y'"` inside a template string did too. They
 * also missed `export * from "./x"` entirely, because no pattern covered it.
 *
 * Regex extraction is deliberately kept for every other language (see
 * `knowledge-service.ts`). A wrong parser is worse than a crude one, and the
 * TypeScript compiler cannot parse Python or Go.
 */

export interface ParsedModule {
  imports: string[];
  exports: string[];
  symbols: string[];
}

/** Extensions the TypeScript parser can handle correctly. */
const PARSEABLE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** True when `relativePath` should go through the AST parser rather than regex. */
export function isAstParseable(relativePath: string): boolean {
  return PARSEABLE.has(path.extname(relativePath).toLowerCase());
}

/**
 * Parses a module and returns its imports, exports, and declared symbols.
 *
 * Returns null when the file is not a language this can parse, letting the caller
 * fall back to regex. A *syntax error* does not return null: `createSourceFile`
 * recovers and still yields a usable tree, and partial results from a file the
 * user is mid-edit are better than none.
 */
export function parseModule(relativePath: string, content: string): ParsedModule | null {
  if (!isAstParseable(relativePath)) return null;

  const extension = path.extname(relativePath).toLowerCase();
  const source = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    // No parent pointers needed; skipping them is measurably cheaper per file.
    false,
    scriptKindFor(extension),
  );

  const imports: string[] = [];
  const exports: string[] = [];
  const symbols: string[] = [];

  const addImport = (specifier: string | undefined): void => {
    if (specifier) imports.push(specifier);
  };

  /** Statements at any nesting level that declare or re-export something. */
  const visit = (node: ts.Node): void => {
    // import x from "y" / import "y" / import type { T } from "y"
    if (ts.isImportDeclaration(node)) {
      addImport(stringLiteralValue(node.moduleSpecifier));
      // A type-only import is still a real dependency edge in the graph: it tells
      // you which module owns the shape, which is exactly what the graph is for.
    } else if (ts.isExportDeclaration(node)) {
      // export * from "y" — the case no regex covered.
      addImport(stringLiteralValue(node.moduleSpecifier));
      collectExportClause(node, exports);
    } else if (ts.isImportEqualsDeclaration(node)) {
      // import fs = require("fs")
      if (ts.isExternalModuleReference(node.moduleReference)) {
        addImport(stringLiteralValue(node.moduleReference.expression));
      }
    } else if (ts.isCallExpression(node)) {
      // require("y") and dynamic import("y"), including inside functions.
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) addImport(stringLiteralValue(node.arguments[0]));
    }

    ts.forEachChild(node, visit);
  };

  for (const statement of source.statements) {
    collectDeclaration(statement, symbols, exports);
  }
  // A dynamic import or require can sit anywhere, so the import walk covers the
  // whole tree rather than only top-level statements. `visit` recurses itself, so
  // this is the single entry point — walking the children again here would double
  // every specifier.
  ts.forEachChild(source, visit);

  return {
    imports: dedupe(imports),
    exports: dedupe(exports),
    symbols: dedupe(symbols),
  };
}

/** Records the name a top-level statement declares, and whether it is exported. */
function collectDeclaration(node: ts.Node, symbols: string[], exports: string[]): void {
  const exported = hasExportModifier(node);
  const isDefault = hasDefaultModifier(node);

  const record = (name: string | undefined): void => {
    if (!name) return;
    symbols.push(name);
    if (exported) exports.push(name);
  };

  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    record(node.name && ts.isIdentifier(node.name) ? node.name.text : undefined);
    // `export default function foo()` exports the name *and* the default slot;
    // `export default function()` only the latter.
    if (exported && isDefault) exports.push("default");
    return;
  }

  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        record(declaration.name.text);
        continue;
      }
      // Destructured declarations (`export const { a, b } = obj`) contribute each
      // bound name, which is what a reader searching for `a` expects to find.
      for (const bound of bindingNames(declaration.name)) record(bound);
    }
    return;
  }

  if (ts.isExportAssignment(node)) {
    // export default <expr> / export = <expr>
    exports.push("default");
    return;
  }

  if (ts.isExportDeclaration(node)) {
    collectExportClause(node, exports);
  }
}

/** Names in `export { a, b as c }`, using the exported name where renamed. */
function collectExportClause(node: ts.ExportDeclaration, exports: string[]): void {
  const clause = node.exportClause;
  if (!clause) {
    // `export * from "y"`: no local names, but the re-export itself is worth
    // recording so the file does not look like it exports nothing.
    if (node.moduleSpecifier) exports.push("*");
    return;
  }
  if (ts.isNamespaceExport(clause)) {
    exports.push(clause.name.text);
    return;
  }
  for (const element of clause.elements) {
    exports.push(element.name.text);
  }
}

/** Every identifier bound by an object/array destructuring pattern. */
function bindingNames(name: ts.BindingName): string[] {
  const found: string[] = [];
  const walk = (binding: ts.BindingName): void => {
    if (ts.isIdentifier(binding)) {
      found.push(binding.text);
      return;
    }
    for (const element of binding.elements) {
      if (ts.isBindingElement(element)) walk(element.name);
    }
  };
  walk(name);
  return found;
}

function hasExportModifier(node: ts.Node): boolean {
  return canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    : false;
}

function hasDefaultModifier(node: ts.Node): boolean {
  return canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    : false;
}

function canHaveModifiers(node: ts.Node): node is ts.HasModifiers {
  return ts.canHaveModifiers(node);
}

/** The text of a string-literal node, or undefined for a computed specifier. */
function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text.trim() || undefined;
  // `import(someVariable)` has no statically-known target; skipping it is correct.
  return undefined;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Maps an extension to the ScriptKind that enables the right syntax (JSX). */
function scriptKindFor(extension: string): ts.ScriptKind {
  switch (extension) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      // Parsed as JS so a `.js` file using JSX-like generics is not misread, and
      // TS-only syntax in a .js file is ignored rather than treated as an error.
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}
