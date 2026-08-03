// On-the-fly TypeScript loader for `node --test`, using the already-installed
// `typescript` package. Handles parameter properties (which Node's strip-only
// mode rejects), extensionless relative imports, and the `@contracts` alias.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const contractsDir = resolvePath(root, "src/contracts");

const fileExtensions = [".ts", ".tsx", ".mjs", ".js", ".cjs", ".json"];
const indexExtensions = [".ts", ".tsx", ".js"];

function resolveFile(basePath) {
  for (const ext of fileExtensions) {
    if (existsSync(basePath + ext)) return basePath + ext;
  }
  for (const ext of indexExtensions) {
    const indexPath = resolvePath(basePath, `index${ext}`);
    if (existsSync(indexPath)) return indexPath;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@contracts") {
    return { url: pathToFileURL(resolvePath(contractsDir, "index.ts")).href, shortCircuit: true };
  }
  if (specifier.startsWith("@contracts/")) {
    const resolved = resolveFile(resolvePath(contractsDir, specifier.slice("@contracts/".length)));
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }

  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExtension = /\.([cm]?[jt]sx?|json)$/.test(specifier);
  if (isRelative && !hasExtension && context.parentURL?.startsWith("file:")) {
    const parentPath = fileURLToPath(context.parentURL);
    const resolved = resolveFile(resolvePath(dirname(parentPath), specifier));
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const filePath = fileURLToPath(url);
    const source = readFileSync(filePath, "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        verbatimModuleSyntax: false,
      },
      fileName: filePath,
    });
    return { format: "module", shortCircuit: true, source: outputText };
  }
  return nextLoad(url, context);
}
