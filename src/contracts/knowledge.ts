export type KnowledgeExportFormat = "markdown" | "json" | "xml";

export type KnowledgeGraphNodeKind = "file" | "symbol" | "category" | "external";

export type KnowledgeGraphEdgeKind = "contains" | "imports" | "exports" | "belongs-to";

export interface KnowledgeScanInput {
  projectPath: string;
  maxFiles?: number;
  maxFileBytes?: number;
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
