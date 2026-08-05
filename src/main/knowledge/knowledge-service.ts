import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
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
  KnowledgeScanProgress,
  KnowledgeSnapshot,
  KnowledgeTruncationReport,
} from "@contracts";
import type { DesktopDatabase, KnowledgeFileRecord } from "../database/desktop-database";
import { parseModule } from "./ast-parser";
import { type AliasResolver, loadAliasResolver } from "./tsconfig-aliases";

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

/**
 * Files read concurrently. Bounded deliberately: unbounded `Promise.all` over a
 * whole repo exhausts the file-descriptor limit, and the win over sequential
 * reads is already most of the way there by 8 on an SSD.
 */
const READ_CONCURRENCY = 8;

/** Files analyzed between progress emissions. */
const PROGRESS_INTERVAL = 16;

/** Raised to unwind a cancelled scan; never escapes `scan()`. */
class ScanCancelledError extends Error {
  constructor() {
    super("Knowledge scan cancelled");
    this.name = "ScanCancelledError";
  }
}

export class KnowledgeService {
  /** Scan ids the renderer has asked to stop, consumed by the scan loop. */
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly database: DesktopDatabase,
    /**
     * Optional so tests and harnesses can construct the service without an
     * Electron window; progress is simply not published when absent.
     */
    private readonly webContentsProvider?: () => WebContents | null,
  ) {}

  get(projectPath: string): KnowledgeSnapshot | null {
    return this.database.getKnowledgeSnapshot(path.resolve(projectPath));
  }

  /**
   * Marks a scan for cancellation. Returns true when the id was live, so the
   * caller can tell a real cancel from a stale click on a finished scan.
   */
  cancelScan(scanId: string): boolean {
    if (!scanId) return false;
    this.cancelled.add(scanId);
    return true;
  }

  async scan(input: KnowledgeScanInput): Promise<KnowledgeSnapshot> {
    const projectPath = path.resolve(input.projectPath);
    const stat = await fs.stat(projectPath).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`Project folder does not exist: ${projectPath}`);
    }

    const scanId = input.scanId;
    try {
      return await this.runScan(projectPath, input, scanId);
    } catch (error) {
      if (error instanceof ScanCancelledError) {
        this.webContentsProvider?.()?.send("knowledge:progress", {
          scanId: scanId ?? "",
          projectPath,
          phase: "cancelled",
          processed: 0,
          total: 0,
        } satisfies KnowledgeScanProgress);
        // A cancelled scan wrote nothing, so the previous snapshot is still the
        // truth. Returning it keeps the renderer's contract (`scan` resolves to a
        // snapshot) without inventing an empty one that would blank the UI.
        const existing = this.get(projectPath);
        if (existing) return existing;
      }
      throw error;
    } finally {
      // Whether it finished, threw, or was cancelled, the id is spent. Leaving it
      // in the set would cancel the *next* scan that reused it.
      if (scanId) this.cancelled.delete(scanId);
    }
  }

  private async runScan(
    projectPath: string,
    input: KnowledgeScanInput,
    scanId: string | undefined,
  ): Promise<KnowledgeSnapshot> {
    const maxFiles = clampInt(input.maxFiles ?? defaultMaxFiles, 20, 5_000);
    const maxFileBytes = clampInt(input.maxFileBytes ?? defaultMaxFileBytes, 20_000, 1_000_000);

    const emit = (progress: Omit<KnowledgeScanProgress, "scanId" | "projectPath">): void => {
      if (!scanId) return;
      this.webContentsProvider?.()?.send("knowledge:progress", {
        scanId,
        projectPath,
        ...progress,
      } satisfies KnowledgeScanProgress);
    };

    const throwIfCancelled = (): void => {
      if (scanId && this.cancelled.has(scanId)) throw new ScanCancelledError();
    };

    emit({ phase: "collecting", processed: 0, total: 0 });
    const collected = await collectFiles(projectPath, maxFiles, maxFileBytes);
    throwIfCancelled();

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

    const total = collected.files.length;
    let processed = 0;
    let reused = 0;

    // The per-file index from the last scan. Empty on a first scan, and empty when
    // the caller forces a full rescan.
    const cached = input.force ? new Map<string, KnowledgeFileRecord>() : this.database.listKnowledgeFiles(projectPath);
    const records: KnowledgeFileRecord[] = [];

    // Batched rather than sequential: the old loop awaited one readFile at a time,
    // so scan cost was a straight line in file count. Cancellation is checked per
    // batch, which is a fine granularity — no need to abort mid-read.
    for (let offset = 0; offset < collected.files.length; offset += READ_CONCURRENCY) {
      throwIfCancelled();
      const batch = collected.files.slice(offset, offset + READ_CONCURRENCY);
      const contents = await Promise.all(
        batch.map(async (candidate) => {
          const previous = cached.get(candidate.relativePath);
          // Cheap rejection first: identical size and mtime means the bytes are
          // almost certainly identical, so skip the read entirely. This is the
          // whole point of the phase — a rescan should not re-read the tree.
          if (previous && previous.bytes === candidate.sizeBytes && previous.mtime === candidate.updatedAt) {
            return { candidate, content: null, cachedRecord: previous };
          }
          const content = await fs.readFile(candidate.absolutePath, "utf8").catch(() => null);
          return { candidate, content, cachedRecord: undefined };
        }),
      );

      for (const { candidate, content, cachedRecord } of contents) {
        processed += 1;

        if (cachedRecord) {
          reused += 1;
          files.push(cachedRecord.insight);
          records.push(cachedRecord);
          continue;
        }

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

        const hash = hashContent(content);
        const previous = cached.get(candidate.relativePath);
        // mtime moved but the bytes did not (a touch, a checkout that rewrote the
        // file identically, a formatter that changed nothing). Reuse the analysis
        // and just refresh the stat fields.
        if (previous?.hash === hash) {
          reused += 1;
          files.push(previous.insight);
          records.push({ ...previous, mtime: candidate.updatedAt, bytes: candidate.sizeBytes });
          continue;
        }

        const insight = analyzeFile(candidate, content);
        files.push(insight);
        records.push({
          path: candidate.relativePath,
          hash,
          mtime: candidate.updatedAt,
          bytes: candidate.sizeBytes,
          insight,
        });
      }

      if (processed % PROGRESS_INTERVAL < READ_CONCURRENCY || processed === total) {
        emit({ phase: "analyzing", processed, total, currentPath: batch.at(-1)?.relativePath });
      }
    }

    throwIfCancelled();
    truncation.filesIndexed = files.length;
    emit({ phase: "graphing", processed, total });
    // Read once per scan, not per import: the tsconfig chain is filesystem work
    // and every file in the project resolves against the same alias table.
    const aliases = await loadAliasResolver(projectPath);
    // The graph is always rebuilt in full, even when one file changed: edges are
    // relationships between files, so a single new import can add or remove edges
    // anywhere. Rebuilding from cached insights is still far cheaper than
    // re-reading and re-parsing the tree.
    const graph = buildCodeGraph(files, aliases);
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
    // Written after the snapshot: if this throws, the snapshot the user sees is
    // still correct and the next scan simply re-reads more than it needed to.
    // The reverse order could serve cached insights for a snapshot that was never
    // stored.
    this.database.replaceKnowledgeFiles(projectPath, records);
    emit({ phase: "done", processed, total, reused });
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

  // TypeScript/JavaScript go through the real parser, so a commented-out import or
  // a specifier inside a string literal no longer becomes a graph edge. Everything
  // else keeps the regex extractors: the TS compiler cannot parse Python or Go, and
  // a wrong parser is worse than a crude one.
  const parsed = parseModule(candidate.relativePath, content);
  const symbols = unique(parsed ? parsed.symbols : extractSymbols(content)).slice(0, 40);
  const exports = unique(parsed ? parsed.exports : extractExports(content)).slice(0, 40);
  const imports = unique(parsed ? parsed.imports : extractImports(content)).slice(0, 60);

  return {
    path: candidate.relativePath,
    extension,
    language,
    category,
    purpose: inferPurpose(candidate.relativePath, content, category, language, symbols),
    sizeBytes: candidate.sizeBytes,
    lines: countLines(content),
    symbols,
    imports,
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

function buildCodeGraph(
  files: KnowledgeFileInsight[],
  aliases?: AliasResolver,
): { graph: KnowledgeCodeGraph; nodesDropped: number; edgesDropped: number } {
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
      const resolved = resolveImportPath(file.path, imported, filePaths, aliases);
      // Three outcomes, not two. An unresolved *local* import means the graph is
      // incomplete (usually the maxFiles cap dropped the target); an unresolved
      // bare specifier is a real dependency. Collapsing them made the app's own
      // aliased layers look like npm packages.
      const unindexedLocal = !resolved && isUnindexedLocalImport(imported, aliases);
      const targetId = resolved
        ? fileNodeId(resolved)
        : unindexedLocal
          ? unindexedNodeId(imported)
          : externalNodeId(imported);
      addNode(
        resolved
          ? {
              id: targetId,
              label: path.posix.basename(resolved),
              kind: "file",
              group: "local",
              path: resolved,
            }
          : unindexedLocal
            ? {
                id: targetId,
                label: path.posix.basename(imported),
                kind: "unindexed",
                group: "local",
                detail: `${imported} — local file outside the index`,
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
        confidence: resolved ? 0.76 : unindexedLocal ? 0.62 : 0.58,
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

function resolveImportPath(
  fromPath: string,
  imported: string,
  filePaths: Set<string>,
  aliases?: AliasResolver,
): string | null {
  if (imported.startsWith(".")) {
    const directory = path.posix.dirname(fromPath);
    return probeCandidates(path.posix.normalize(path.posix.join(directory, imported)), filePaths);
  }

  // Not relative, but not necessarily a package: a tsconfig `paths` alias points
  // back into the project. Without this the app's own `@contracts` layer was
  // rendered as a third-party npm node.
  if (!aliases?.hasAliases) return null;
  for (const candidate of aliases.candidates(imported)) {
    const resolved = probeCandidates(candidate, filePaths);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * True when a specifier maps to a project path that simply is not in the index.
 *
 * Distinct from "external package" on purpose: a local file dropped by the
 * `maxFiles` cap is a gap in the graph, not a dependency, and the truncation
 * report should be able to say which.
 */
function isUnindexedLocalImport(imported: string, aliases?: AliasResolver): boolean {
  if (imported.startsWith(".")) return true;
  return Boolean(aliases?.hasAliases) && (aliases?.candidates(imported).length ?? 0) > 0;
}

/** First existing file for a project-relative base path, trying the usual extensions. */
function probeCandidates(base: string, filePaths: Set<string>): string | null {
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

/**
 * Content hash for the incremental index.
 *
 * sha1 rather than sha256: this is change detection against a local file the
 * scanner just read, not a security boundary, and it is the cheaper of the two
 * over a whole tree.
 */
function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function externalNodeId(imported: string): string {
  return `external:${externalPackageName(imported)}`;
}

/**
 * Node id for a local import whose target is not in the index.
 *
 * Keyed by the specifier rather than a package name: two different unresolved
 * local paths are two different gaps, whereas `lodash/get` and `lodash/set` are
 * one dependency.
 */
function unindexedNodeId(imported: string): string {
  return `unindexed:${imported}`;
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
