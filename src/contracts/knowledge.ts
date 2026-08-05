export type KnowledgeExportFormat = "markdown" | "json" | "xml";

export type KnowledgeGraphNodeKind = "file" | "symbol" | "category" | "external" | "unindexed";

export type KnowledgeGraphEdgeKind = "contains" | "imports" | "exports" | "belongs-to";

export interface KnowledgeScanInput {
  projectPath: string;
  maxFiles?: number;
  maxFileBytes?: number;
  /**
   * Correlates progress events and cancellation with this scan. Supplied by the
   * renderer so it can cancel a scan it started without waiting for the invoke to
   * resolve — which, for a large repo, is the whole point.
   */
  scanId?: string;
  /**
   * Ignores the cached per-file index and re-reads everything. For when the
   * analyzer itself changed, where cached insights are stale even though the files
   * are not.
   */
  force?: boolean;
}

/** Where a scan is in its walk, pushed to the renderer as it advances. */
export interface KnowledgeScanProgress {
  scanId: string;
  projectPath: string;
  phase: "collecting" | "analyzing" | "graphing" | "done" | "cancelled";
  processed: number;
  total: number;
  currentPath?: string;
  /**
   * Files served from the cached per-file index rather than re-read and re-parsed.
   * Reported on the `done` event so the UI can say how much of the rescan was
   * actually skipped.
   */
  reused?: number;
}

export interface KnowledgeLanguageStat {
  language: string;
  files: number;
  lines: number;
  bytes: number;
}

export interface KnowledgeCategoryStat {
  category: string;
  files: number;
  lines: number;
}

export interface KnowledgeFileInsight {
  path: string;
  extension: string;
  language: string;
  category: string;
  purpose: string;
  sizeBytes: number;
  lines: number;
  symbols: string[];
  imports: string[];
  exports: string[];
  contentSample: string;
  updatedAt: string;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  kind: KnowledgeGraphNodeKind;
  group?: string;
  path?: string;
  detail?: string;
}

export interface KnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: KnowledgeGraphEdgeKind;
  label?: string;
  confidence: number;
}

export interface KnowledgeCodeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export interface KnowledgeTruncationReport {
  hitFileLimit: boolean;
  filesSeen: number;
  filesIndexed: number;
  skippedUnsupported: number;
  skippedTooLarge: number;
  skippedBinary: number;
  skippedUnreadable: number;
  graphNodesDropped: number;
  graphEdgesDropped: number;
  largestSkipped?: Array<{ path: string; bytes: number }>;
}

export interface KnowledgeSnapshot {
  projectPath: string;
  projectName: string;
  generatedAt: string;
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  totalBytes: number;
  totalLines: number;
  languages: KnowledgeLanguageStat[];
  categories: KnowledgeCategoryStat[];
  files: KnowledgeFileInsight[];
  graph: KnowledgeCodeGraph;
  agentBrief: string;
  truncation?: KnowledgeTruncationReport;
}

export interface KnowledgeExportResult {
  format: KnowledgeExportFormat;
  fileName: string;
  content: string;
  generatedAt: string;
}

export interface KnowledgeSearchInput {
  projectPath: string;
  query: string;
  limit?: number;
}

/** Why a result matched, so the UI can show the reason rather than just a path. */
export type KnowledgeSearchMatchKind = "path" | "symbol" | "export" | "import" | "purpose" | "language" | "category";

export interface KnowledgeSearchHit {
  path: string;
  language: string;
  category: string;
  purpose: string;
  score: number;
  /** Match reasons, strongest first. */
  matches: KnowledgeSearchMatchKind[];
  /** The specific symbol/export/import that matched, when one did. */
  matchedTerm?: string;
}

export interface KnowledgeSearchResult {
  query: string;
  hits: KnowledgeSearchHit[];
  /** Total files considered, so the UI can say "12 of 800". */
  scanned: number;
}
