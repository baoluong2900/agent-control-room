import fs from "node:fs/promises";
import path from "node:path";
import type {
  KnowledgeCategoryStat,
  KnowledgeCodeGraph,
  KnowledgeExportFormat,
  KnowledgeExportResult,
  KnowledgeFileInsight,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeLanguageStat,
  KnowledgeScanInput,
  KnowledgeSnapshot,
  KnowledgeTruncationReport,
} from "@contracts";
import type { DesktopDatabase } from "../database/desktop-database";

type ScanCandidate = {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  updatedAt: string;
};

type CollectResult = {
  files: ScanCandidate[];
  filesSeen: number;
  hitFileLimit: boolean;
  skippedUnsupported: number;
  skippedTooLarge: number;
  skippedUnreadable: number;
  largestSkipped: Array<{ path: string; bytes: number }>;
};

type TruncationAccumulator = Pick<
  KnowledgeTruncationReport,
  | "hitFileLimit"
  | "filesSeen"
  | "filesIndexed"
  | "skippedUnsupported"
  | "skippedTooLarge"
  | "skippedBinary"
  | "skippedUnreadable"
  | "graphNodesDropped"
  | "graphEdgesDropped"
> & { largestSkipped: Array<{ path: string; bytes: number }> };

const defaultMaxFiles = 800;
const defaultMaxFileBytes = 180_000;

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".verify",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "__pycache__",
]);

const ignoredFiles = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const supportedExtensions = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".cs"]);

export class KnowledgeService {
  constructor(private readonly database: DesktopDatabase) {}

  get(projectPath: string): KnowledgeSnapshot | null {
    return this.database.getKnowledgeSnapshot(path.resolve(projectPath));
  }

  async scan(input: KnowledgeScanInput): Promise<KnowledgeSnapshot> {
    const projectPath = path.resolve(input.projectPath);
    const stat = await fs.stat(projectPath).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`Project folder does not exist: ${projectPath}`);
    }

    const maxFiles = clampInt(input.maxFiles ?? defaultMaxFiles, 20, 5_000);
    const maxFileBytes = clampInt(input.maxFileBytes ?? defaultMaxFileBytes, 20_000, 1_000_000);
    const collected = await collectFiles(projectPath, maxFiles, maxFileBytes);
    const files: KnowledgeFileInsight[] = [];
    const truncation: TruncationAccumulator = {
      hitFileLimit: collected.hitFileLimit,
      filesSeen: collected.filesSeen,
      filesIndexed: 0,
      skippedUnsupported: collected.skippedUnsupported,
      skippedTooLarge: collected.skippedTooLarge,
      skippedBinary: 0,
      skippedUnreadable: collected.skippedUnreadable,
      graphNodesDropped: 0,
      graphEdgesDropped: 0,
      largestSkipped: collected.largestSkipped,
    };

    for (const candidate of collected.files) {
      const content = await fs.readFile(candidate.absolutePath, "utf8").catch(() => null);
      if (content === null) {
        truncation.skippedUnreadable += 1;
        trackLargestSkipped(truncation.largestSkipped, candidate.relativePath, candidate.sizeBytes);
        continue;
      }
      if (looksBinary(content)) {
        truncation.skippedBinary += 1;
        trackLargestSkipped(truncation.largestSkipped, candidate.relativePath, candidate.sizeBytes);
        continue;
      }

      files.push(analyzeFile(candidate, content));
    }

    truncation.filesIndexed = files.length;
    const graph = buildCodeGraph(files);
    truncation.graphNodesDropped = graph.nodesDropped;
    truncation.graphEdgesDropped = graph.edgesDropped;

    const skippedFiles =
      truncation.skippedUnsupported + truncation.skippedTooLarge + truncation.skippedBinary + truncation.skippedUnreadable;

    const snapshot: KnowledgeSnapshot = {
      projectPath,
      projectName: path.basename(projectPath),
      generatedAt: new Date().toISOString(),
      totalFiles: truncation.filesSeen,
      indexedFiles: files.length,
      skippedFiles,
      totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      totalLines: files.reduce((sum, file) => sum + file.lines, 0),
      languages: languageStats(files),
      categories: categoryStats(files),
      files,
      graph: graph.graph,
      agentBrief: "",
      truncation: shouldPersistTruncation(truncation) ? finalizeTruncation(truncation) : undefined,
    };
    snapshot.agentBrief = buildAgentBrief(snapshot);

    this.database.saveKnowledgeSnapshot(snapshot);
    return snapshot;
  }

  async export(projectPath: string, format: KnowledgeExportFormat): Promise<KnowledgeExportResult> {
    const snapshot = this.get(projectPath) ?? (await this.scan({ projectPath }));
    const generatedAt = new Date().toISOString();
    const extension = format === "markdown" ? "md" : format;
    return {
      format,
      fileName: `${slug(path.basename(snapshot.projectPath))}.knowledge.${extension}`,
      content: serializeSnapshot(snapshot, format),
      generatedAt,
    };
  }
}

async function collectFiles(root: string, maxFiles: number, maxFileBytes: number): Promise<CollectResult> {
  const files: ScanCandidate[] = [];
  const largestSkipped: Array<{ path: string; bytes: number }> = [];
  let filesSeen = 0;
  let hitFileLimit = false;
  let skippedUnsupported = 0;
  let skippedTooLarge = 0;
  let skippedUnreadable = 0;

  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPosix(path.relative(root, absolutePath));

      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) continue;
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;
      filesSeen += 1;

      if (files.length >= maxFiles) {
        hitFileLimit = true;
        continue;
      }

      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat) {
        skippedUnreadable += 1;
        continue;
      }

      if (!isSupportedKnowledgeFile(entry.name, relativePath)) {
        skippedUnsupported += 1;
        trackLargestSkipped(largestSkipped, relativePath, stat.size);
        continue;
      }

      if (stat.size > maxFileBytes) {
        skippedTooLarge += 1;
        trackLargestSkipped(largestSkipped, relativePath, stat.size);
        continue;
      }

      files.push({
        absolutePath,
        relativePath,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    }
  }

  await visit(root);
  return { files, filesSeen, hitFileLimit, skippedUnsupported, skippedTooLarge, skippedUnreadable, largestSkipped };
}

function isSupportedKnowledgeFile(fileName: string, relativePath: string): boolean {
  if (ignoredFiles.has(fileName)) return false;
  if (/(^|\/)\.env(\.|$)/.test(relativePath)) return false;
  if (/\.(png|jpg|jpeg|gif|webp|avif|ico|icns|pdf|zip|gz|tar|tgz|sqlite|db|lock)$/i.test(fileName)) return false;
  return supportedExtensions.has(path.extname(fileName).toLowerCase()) || fileName === "Dockerfile";
}

function analyzeFile(candidate: ScanCandidate, content: string): KnowledgeFileInsight {
  const extension = path.extname(candidate.relativePath).toLowerCase() || path.basename(candidate.relativePath);
  const language = languageForFile(candidate.relativePath, extension);
  const category = categoryForPath(candidate.relativePath, extension);
  const symbols = unique(extractSymbols(content)).slice(0, 40);
  const exports = unique(extractExports(content)).slice(0, 40);

  return {
    path: candidate.relativePath,
    extension,
    language,
    category,
    purpose: inferPurpose(candidate.relativePath, content, category, language, symbols),
    sizeBytes: candidate.sizeBytes,
    lines: countLines(content),
    symbols,
    imports: unique(extractImports(content)).slice(0, 60),
    exports,
    contentSample: sampleContent(content),
    updatedAt: candidate.updatedAt,
  };
}

function languageStats(files: KnowledgeFileInsight[]): KnowledgeLanguageStat[] {
  const map = new Map<string, KnowledgeLanguageStat>();
  for (const file of files) {
    const current = map.get(file.language) ?? { language: file.language, files: 0, lines: 0, bytes: 0 };
    current.files += 1;
    current.lines += file.lines;
    current.bytes += file.sizeBytes;
    map.set(file.language, current);
  }
  return [...map.values()].sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
}

function categoryStats(files: KnowledgeFileInsight[]): KnowledgeCategoryStat[] {
  const map = new Map<string, KnowledgeCategoryStat>();
  for (const file of files) {
    const current = map.get(file.category) ?? { category: file.category, files: 0, lines: 0 };
    current.files += 1;
    current.lines += file.lines;
    map.set(file.category, current);
  }
  return [...map.values()].sort((a, b) => b.files - a.files || a.category.localeCompare(b.category));
}

function buildCodeGraph(files: KnowledgeFileInsight[]): { graph: KnowledgeCodeGraph; nodesDropped: number; edgesDropped: number } {
  const nodes = new Map<string, KnowledgeGraphNode>();
  const edges = new Map<string, KnowledgeGraphEdge>();
  const filePaths = new Set(files.map((file) => file.path));

  function addNode(node: KnowledgeGraphNode): void {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }

  function addEdge(edge: KnowledgeGraphEdge): void {
    if (!edges.has(edge.id)) edges.set(edge.id, edge);
  }

  for (const file of files) {
    const categoryId = `category:${slug(file.category)}`;
    const fileId = fileNodeId(file.path);
    addNode({ id: categoryId, label: titleCase(file.category), kind: "category", group: file.category });
    addNode({
      id: fileId,
      label: path.posix.basename(file.path),
      kind: "file",
      group: file.category,
      path: file.path,
      detail: file.purpose,
    });
    addEdge({
      id: `${fileId}->${categoryId}:belongs-to`,
      source: fileId,
      target: categoryId,
      kind: "belongs-to",
      confidence: 0.86,
    });

    for (const symbol of file.symbols.slice(0, 8)) {
      const symbolId = symbolNodeId(file.path, symbol);
      addNode({ id: symbolId, label: symbol, kind: "symbol", group: file.category, path: file.path });
      addEdge({
        id: `${fileId}->${symbolId}:contains`,
        source: fileId,
        target: symbolId,
        kind: "contains",
        confidence: 0.74,
      });
    }

    for (const exported of file.exports.slice(0, 8)) {
      const symbolId = symbolNodeId(file.path, exported);
      addNode({ id: symbolId, label: exported, kind: "symbol", group: file.category, path: file.path });
      addEdge({
        id: `${fileId}->${symbolId}:exports`,
        source: fileId,
        target: symbolId,
        kind: "exports",
        confidence: 0.82,
      });
    }

    for (const imported of file.imports.slice(0, 24)) {
      const resolved = resolveImportPath(file.path, imported, filePaths);
      const targetId = resolved ? fileNodeId(resolved) : externalNodeId(imported);
      addNode(
        resolved
          ? {
              id: targetId,
              label: path.posix.basename(resolved),
              kind: "file",
              group: "local",
              path: resolved,
            }
          : {
              id: targetId,
              label: externalPackageName(imported),
              kind: "external",
              group: "external",
              detail: imported,
            },
      );
      addEdge({
        id: `${fileId}->${targetId}:imports:${imported}`,
        source: fileId,
        target: targetId,
        kind: "imports",
        label: imported,
        confidence: resolved ? 0.76 : 0.58,
      });
    }
  }

  const cappedNodes = [...nodes.values()].slice(0, 1_200);
  const retainedNodeIds = new Set(cappedNodes.map((node) => node.id));
  const survivingEdges = [...edges.values()].filter((edge) => retainedNodeIds.has(edge.source) && retainedNodeIds.has(edge.target));
  const cappedEdges = survivingEdges.slice(0, 2_400);

  return {
    graph: {
      nodes: cappedNodes,
      edges: cappedEdges,
    },
    nodesDropped: Math.max(0, nodes.size - cappedNodes.length),
    edgesDropped: Math.max(0, edges.size - cappedEdges.length),
  };
}

function buildAgentBrief(snapshot: KnowledgeSnapshot): string {
  const languages = snapshot.languages.slice(0, 5).map((item) => `${item.language} (${item.files})`).join(", ");
  const categories = snapshot.categories.slice(0, 6).map((item) => `${titleCase(item.category)} (${item.files})`).join(", ");
  const entryPoints = snapshot.files
    .filter((file) => /(^package\.json$|src\/main\/main\.|src\/renderer\/App\.|README\.md$|main\.|index\.)/.test(file.path))
    .slice(0, 8)
    .map((file) => file.path);
  const highSignal = entryPoints.length ? entryPoints.join(", ") : snapshot.files.slice(0, 6).map((file) => file.path).join(", ");

  return [
    `${snapshot.projectName} knowledgebase indexed ${snapshot.indexedFiles} files and ${snapshot.totalLines} lines.`,
    languages ? `Primary languages: ${languages}.` : "Primary languages: none detected.",
    categories ? `Architecture categories: ${categories}.` : "Architecture categories: none detected.",
    `Start source investigation from: ${highSignal || "no indexed entry points"}.`,
    "Use this codegraph before launching agents so planning, fixing, and review work targets the right files instead of scanning the whole repository again.",
  ].join("\n");
}

function inferPurpose(
  relativePath: string,
  content: string,
  category: string,
  language: string,
  symbols: string[],
): string {
  const packagePurpose = packageJsonPurpose(relativePath, content);
  if (packagePurpose) return packagePurpose;

  const heading = content.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  if (heading && relativePath.toLowerCase().endsWith(".md")) {
    return `Documentation for ${heading}.`;
  }

  const firstComment = content.match(/^\s*(?:\/\*\*?\s*|\*\s*|\/\/\s*|#\s*)([A-Z][^\n]{24,180})/m)?.[1]?.trim();
  if (firstComment) return firstComment.replace(/\*\/$/, "").trim();

  const name = titleCase(path.posix.basename(relativePath, path.extname(relativePath)).replace(/[._-]+/g, " "));
  if (category === "renderer-ui") return `Renderer UI surface for ${name}.`;
  if (category === "desktop-main") return `Electron main-process logic for ${name}.`;
  if (category === "ipc-boundary") return `IPC boundary and process bridge logic for ${name}.`;
  if (category === "persistence") return `Persistence and local data ownership logic for ${name}.`;
  if (category === "contracts") return `Shared type contract for ${name}.`;
  if (category === "tests") return `Verification coverage for ${name}.`;
  if (category === "docs") return `Project documentation for ${name}.`;
  if (symbols.length > 0) return `${language} source defining ${symbols.slice(0, 4).join(", ")}.`;
  return `${titleCase(category)} file for ${name}.`;
}

function packageJsonPurpose(relativePath: string, content: string): string | null {
  if (path.posix.basename(relativePath) !== "package.json") return null;
  try {
    const parsed = JSON.parse(content) as { name?: string; description?: string; scripts?: Record<string, string> };
    const description = parsed.description?.trim();
    const scripts = parsed.scripts ? Object.keys(parsed.scripts).slice(0, 6).join(", ") : "";
    return `Package manifest${parsed.name ? ` for ${parsed.name}` : ""}${description ? `: ${description}` : ""}${
      scripts ? ` Scripts: ${scripts}.` : "."
    }`;
  } catch {
    return "Package manifest with invalid or nonstandard JSON.";
  }
}

function categoryForPath(relativePath: string, extension: string): string {
  const normalized = relativePath.toLowerCase();
  const basename = path.posix.basename(normalized);
  if (/(^|\/)(test|tests|__tests__|spec|e2e)(\/|$)/.test(normalized) || /\.(test|spec)\.[jt]sx?$/.test(normalized)) {
    return "tests";
  }
  if (normalized.startsWith("docs/") || extension === ".md" || basename === "readme.md") return "docs";
  if (normalized.includes("/database/") || normalized.includes("/db/") || extension === ".sql") return "persistence";
  if (normalized.includes("/ipc/") || normalized.includes("/preload/")) return "ipc-boundary";
  if (normalized.includes("/main/") || normalized.endsWith("main.ts") || normalized.includes("/workers/")) return "desktop-main";
  if (normalized.includes("/renderer/") || normalized.includes("/components/") || normalized.endsWith(".tsx")) return "renderer-ui";
  if (normalized.includes("src/contracts/") || normalized.includes("/contracts/")) return "contracts";
  if (normalized.includes("/scripts/") || extension === ".sh") return "automation";
  if (["package.json", "tsconfig.json", "vite.config.ts", "forge.config.ts"].includes(basename) || basename.includes("config")) {
    return "config";
  }
  if (extension === ".css" || extension === ".scss") return "styles";
  if (sourceExtensions.has(extension)) return "source";
  return "assets";
}

function languageForFile(relativePath: string, extension: string): string {
  const basename = path.posix.basename(relativePath);
  const map: Record<string, string> = {
    ".c": "C",
    ".cc": "C++",
    ".cjs": "JavaScript",
    ".cpp": "C++",
    ".cs": "C#",
    ".css": "CSS",
    ".go": "Go",
    ".h": "C/C++ Header",
    ".hpp": "C++ Header",
    ".html": "HTML",
    ".java": "Java",
    ".js": "JavaScript",
    ".json": "JSON",
    ".jsx": "React JSX",
    ".kt": "Kotlin",
    ".md": "Markdown",
    ".mjs": "JavaScript",
    ".php": "PHP",
    ".py": "Python",
    ".rb": "Ruby",
    ".rs": "Rust",
    ".scss": "SCSS",
    ".sh": "Shell",
    ".sql": "SQL",
    ".swift": "Swift",
    ".toml": "TOML",
    ".ts": "TypeScript",
    ".tsx": "React TSX",
    ".txt": "Text",
    ".xml": "XML",
    ".yaml": "YAML",
    ".yml": "YAML",
  };
  if (basename === "Dockerfile") return "Dockerfile";
  return map[extension] ?? extension.replace(".", "").toUpperCase();
}

function extractImports(content: string): string[] {
  const imports: string[] = [];
  collectMatches(content, /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g, imports);
  collectMatches(content, /\brequire\(["']([^"']+)["']\)/g, imports);
  collectMatches(content, /\bimport\(["']([^"']+)["']\)/g, imports);
  collectMatches(content, /^\s*@import\s+["']([^"']+)["']/gm, imports);
  collectMatches(content, /^\s*from\s+([\w.]+)\s+import\s+/gm, imports);
  collectMatches(content, /^\s*import\s+([\w.]+)\s*$/gm, imports);
  return imports;
}

function extractExports(content: string): string[] {
  const exports: string[] = [];
  collectMatches(content, /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g, exports);
  collectMatches(content, /\bexport\s*\{([^}]+)\}/g, exports, (value) =>
    value
      .split(",")
      .map((entry) => entry.trim().split(/\s+as\s+/i)[0]?.trim())
      .filter(Boolean),
  );
  collectMatches(content, /\bmodule\.exports\.([A-Za-z_$][\w$]*)\s*=/g, exports);
  return exports;
}

function extractSymbols(content: string): string[] {
  const symbols: string[] = [];
  collectMatches(content, /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, symbols);
  collectMatches(content, /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:[:=<]|\()/g, symbols);
  collectMatches(content, /^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm, symbols);
  collectMatches(content, /^\s*class\s+([A-Za-z_][\w]*)\s*[:(]/gm, symbols);
  return symbols;
}

function collectMatches(
  content: string,
  pattern: RegExp,
  target: string[],
  transform?: (value: string) => Array<string | undefined>,
): void {
  for (const match of content.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (!value) continue;
    const values = transform ? transform(value) : [value];
    for (const item of values) {
      if (item) target.push(item);
    }
  }
}

function resolveImportPath(fromPath: string, imported: string, filePaths: Set<string>): string | null {
  if (!imported.startsWith(".")) return null;
  const directory = path.posix.dirname(fromPath);
  const base = path.posix.normalize(path.posix.join(directory, imported));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    `${base}.css`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
  return candidates.find((candidate) => filePaths.has(candidate)) ?? null;
}

function sampleContent(content: string): string {
  const lines = redactSecrets(content)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, 36);
  return lines.join("\n").slice(0, 2_400);
}

function redactSecrets(content: string): string {
  return content
    .replace(/([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*)["']?[^"'\n]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");
}

function serializeSnapshot(snapshot: KnowledgeSnapshot, format: KnowledgeExportFormat): string {
  if (format === "json") return `${JSON.stringify(snapshot, null, 2)}\n`;
  if (format === "xml") return serializeXml(snapshot);
  return serializeMarkdown(snapshot);
}

function shouldPersistTruncation(report: TruncationAccumulator): boolean {
  return report.hitFileLimit || report.skippedUnsupported > 0 || report.skippedTooLarge > 0 || report.skippedBinary > 0 || report.skippedUnreadable > 0 || report.graphNodesDropped > 0 || report.graphEdgesDropped > 0;
}

function finalizeTruncation(report: TruncationAccumulator): KnowledgeTruncationReport {
  return {
    hitFileLimit: report.hitFileLimit,
    filesSeen: report.filesSeen,
    filesIndexed: report.filesIndexed,
    skippedUnsupported: report.skippedUnsupported,
    skippedTooLarge: report.skippedTooLarge,
    skippedBinary: report.skippedBinary,
    skippedUnreadable: report.skippedUnreadable,
    graphNodesDropped: report.graphNodesDropped,
    graphEdgesDropped: report.graphEdgesDropped,
    largestSkipped: report.largestSkipped.length > 0 ? report.largestSkipped.slice(0, 8) : undefined,
  };
}

function trackLargestSkipped(target: Array<{ path: string; bytes: number }>, pathValue: string, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  target.push({ path: pathValue, bytes });
  target.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
  if (target.length > 8) target.length = 8;
}

function serializeMarkdown(snapshot: KnowledgeSnapshot): string {
  const lines = [
    `# ${snapshot.projectName} CodeGraph Knowledgebase`,
    "",
    `Generated: ${snapshot.generatedAt}`,
    `Project: \`${snapshot.projectPath}\``,
    `Indexed: ${snapshot.indexedFiles}/${snapshot.totalFiles} files, ${snapshot.totalLines} lines`,
    snapshot.truncation ? "" : "",
    snapshot.truncation ? "## Truncation Report" : "",
    snapshot.truncation
      ? `- Hit file limit: ${yesNo(snapshot.truncation.hitFileLimit)}`
      : "",
    snapshot.truncation ? `- Files seen: ${snapshot.truncation.filesSeen}` : "",
    snapshot.truncation ? `- Files indexed: ${snapshot.truncation.filesIndexed}` : "",
    snapshot.truncation ? `- Skipped unsupported: ${snapshot.truncation.skippedUnsupported}` : "",
    snapshot.truncation ? `- Skipped too large: ${snapshot.truncation.skippedTooLarge}` : "",
    snapshot.truncation ? `- Skipped binary: ${snapshot.truncation.skippedBinary}` : "",
    snapshot.truncation ? `- Skipped unreadable: ${snapshot.truncation.skippedUnreadable}` : "",
    snapshot.truncation ? `- Graph nodes dropped: ${snapshot.truncation.graphNodesDropped}` : "",
    snapshot.truncation ? `- Graph edges dropped: ${snapshot.truncation.graphEdgesDropped}` : "",
    snapshot.truncation?.largestSkipped?.length
      ? `- Largest skipped: ${snapshot.truncation.largestSkipped
          .map((item) => `${item.path} (${formatBytes(item.bytes)})`)
          .join(", ")}`
      : "",
    snapshot.truncation ? "" : "",
    "## Agent Brief",
    "",
    snapshot.agentBrief,
    "",
    "## Architecture Categories",
    "",
    ...snapshot.categories.map((item) => `- ${titleCase(item.category)}: ${item.files} files, ${item.lines} lines`),
    "",
    "## Languages",
    "",
    ...snapshot.languages.map((item) => `- ${item.language}: ${item.files} files, ${item.lines} lines, ${formatBytes(item.bytes)}`),
    "",
    "## CodeGraph",
    "",
    ...snapshot.graph.edges
      .filter((edge) => edge.kind === "imports")
      .slice(0, 220)
      .map((edge) => `- ${nodeLabel(snapshot.graph, edge.source)} imports ${nodeLabel(snapshot.graph, edge.target)}${edge.label ? ` (${edge.label})` : ""}`),
    "",
    "## File Insights",
    "",
  ];

  for (const file of snapshot.files) {
    lines.push(`### ${file.path}`);
    lines.push(`- Category: ${titleCase(file.category)}`);
    lines.push(`- Language: ${file.language}`);
    lines.push(`- Size: ${formatBytes(file.sizeBytes)}, ${file.lines} lines`);
    lines.push(`- Purpose: ${file.purpose}`);
    if (file.symbols.length) lines.push(`- Symbols: ${file.symbols.slice(0, 16).join(", ")}`);
    if (file.imports.length) lines.push(`- Imports: ${file.imports.slice(0, 16).join(", ")}`);
    if (file.exports.length) lines.push(`- Exports: ${file.exports.slice(0, 16).join(", ")}`);
    if (file.contentSample) {
      lines.push("");
      lines.push("```");
      lines.push(file.contentSample.slice(0, 900));
      lines.push("```");
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function serializeXml(snapshot: KnowledgeSnapshot): string {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<knowledgebase project="${xmlEscape(snapshot.projectName)}" generatedAt="${xmlEscape(snapshot.generatedAt)}">`,
    `  <summary indexedFiles="${snapshot.indexedFiles}" totalFiles="${snapshot.totalFiles}" skippedFiles="${snapshot.skippedFiles}" totalLines="${snapshot.totalLines}" totalBytes="${snapshot.totalBytes}" />`,
    ...(snapshot.truncation
      ? [
          `  <truncation hitFileLimit="${snapshot.truncation.hitFileLimit}" filesSeen="${snapshot.truncation.filesSeen}" filesIndexed="${snapshot.truncation.filesIndexed}" skippedUnsupported="${snapshot.truncation.skippedUnsupported}" skippedTooLarge="${snapshot.truncation.skippedTooLarge}" skippedBinary="${snapshot.truncation.skippedBinary}" skippedUnreadable="${snapshot.truncation.skippedUnreadable}" graphNodesDropped="${snapshot.truncation.graphNodesDropped}" graphEdgesDropped="${snapshot.truncation.graphEdgesDropped}" />`,
        ]
      : []),
    `  <agentBrief>${xmlEscape(snapshot.agentBrief)}</agentBrief>`,
    "  <categories>",
    ...snapshot.categories.map(
      (item) => `    <category name="${xmlEscape(item.category)}" files="${item.files}" lines="${item.lines}" />`,
    ),
    "  </categories>",
    "  <languages>",
    ...snapshot.languages.map(
      (item) => `    <language name="${xmlEscape(item.language)}" files="${item.files}" lines="${item.lines}" bytes="${item.bytes}" />`,
    ),
    "  </languages>",
    "  <codegraph>",
    ...snapshot.graph.edges
      .slice(0, 500)
      .map(
        (edge) =>
          `    <edge kind="${edge.kind}" source="${xmlEscape(nodeLabel(snapshot.graph, edge.source))}" target="${xmlEscape(
            nodeLabel(snapshot.graph, edge.target),
          )}" label="${xmlEscape(edge.label ?? "")}" confidence="${edge.confidence}" />`,
      ),
    "  </codegraph>",
    "  <files>",
  ];

  for (const file of snapshot.files) {
    lines.push(`    <file path="${xmlEscape(file.path)}" category="${xmlEscape(file.category)}" language="${xmlEscape(file.language)}" lines="${file.lines}" bytes="${file.sizeBytes}">`);
    lines.push(`      <purpose>${xmlEscape(file.purpose)}</purpose>`);
    lines.push(`      <symbols>${file.symbols.map((symbol) => `<symbol>${xmlEscape(symbol)}</symbol>`).join("")}</symbols>`);
    lines.push(`      <imports>${file.imports.map((entry) => `<import>${xmlEscape(entry)}</import>`).join("")}</imports>`);
    lines.push(`      <exports>${file.exports.map((entry) => `<export>${xmlEscape(entry)}</export>`).join("")}</exports>`);
    lines.push(`      <sample>${xmlEscape(file.contentSample.slice(0, 900))}</sample>`);
    lines.push("    </file>");
  }

  lines.push("  </files>");
  lines.push("</knowledgebase>");
  return `${lines.join("\n")}\n`;
}

function nodeLabel(graph: KnowledgeCodeGraph, nodeId: string): string {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  return node?.path ?? node?.label ?? nodeId;
}

function countLines(content: string): number {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

function looksBinary(content: string): boolean {
  return content.includes("\u0000");
}

function fileNodeId(relativePath: string): string {
  return `file:${relativePath}`;
}

function symbolNodeId(relativePath: string, symbol: string): string {
  return `symbol:${relativePath}:${symbol}`;
}

function externalNodeId(imported: string): string {
  return `external:${externalPackageName(imported)}`;
}

function externalPackageName(imported: string): string {
  if (imported.startsWith("@")) return imported.split("/").slice(0, 2).join("/");
  return imported.split("/")[0] ?? imported;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "knowledge";
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function xmlEscape(value: string): string {
  return stripInvalidXmlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stripInvalidXmlChars(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
