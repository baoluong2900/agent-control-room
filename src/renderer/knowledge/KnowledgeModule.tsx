import {
  BookOpenText,
  Braces,
  Copy,
  DatabaseZap,
  FileCode2,
  FileJson,
  FileText,
  FolderOpen,
  GitBranch,
  Network,
  RefreshCw,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  KnowledgeExportFormat,
  KnowledgeFileInsight,
  KnowledgeGraphEdge,
  KnowledgeScanProgress,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
  ProjectSummary,
} from "@contracts";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./knowledge.css";

type KnowledgeModuleProps = {
  project: ProjectSummary | null;
  onPickFolder: () => Promise<string | null>;
};

type ViewMode = "files" | "graph" | "brief";

const exportOptions: Array<{ format: KnowledgeExportFormat; label: string; icon: LucideIcon }> = [
  { format: "markdown", label: "MD", icon: FileText },
  { format: "json", label: "JSON", icon: FileJson },
  { format: "xml", label: "XML", icon: Braces },
];

export function KnowledgeModule({ project, onPickFolder }: KnowledgeModuleProps) {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [viewMode, setViewMode] = useState<ViewMode>("files");
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanMaxFiles, setScanMaxFiles] = useState(1_200);
  const [scanMaxFileBytes, setScanMaxFileBytes] = useState(220_000);
  const [progress, setProgress] = useState<KnowledgeScanProgress | null>(null);
  const [searchHits, setSearchHits] = useState<KnowledgeSearchResult | null>(null);
  // Held in a ref, not state: the cancel button and the progress listener both
  // need the current id without re-rendering, and a scan started before a
  // re-render must still be cancellable.
  const activeScanId = useRef<string | null>(null);
  // `reused` only appears on the terminal `done` event, which arrives before the
  // scan invoke resolves, so it is stashed here for the completion notice.
  const lastReused = useRef(0);

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (!project) {
        setSnapshot(null);
        setSelectedPath(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next = await window.agentic.knowledge.get(project.path);
        if (!mounted) return;
        setSnapshot(next);
        setSelectedPath(next?.files[0]?.path ?? null);
      } catch (nextError) {
        if (mounted) setError(formatError(nextError));
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [project]);

  // Ranked search replaces the old client-side substring filter, which had no
  // ordering: a file merely mentioning the query in prose ranked identically to
  // one named after it. Scoring lives in the main process next to the data.
  useEffect(() => {
    const normalized = query.trim();
    if (!project || !normalized) {
      setSearchHits(null);
      return;
    }

    let live = true;
    const timer = setTimeout(() => {
      void window.agentic.knowledge
        .search({ projectPath: project.path, query: normalized, limit: 60 })
        .then((result) => {
          // Guard against an earlier query resolving after a later one.
          if (live) setSearchHits(result);
        })
        .catch(() => {
          if (live) setSearchHits(null);
        });
    }, 140);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [project, query, snapshot]);

  const filteredFiles = useMemo(() => {
    if (!snapshot) return [];
    const normalized = query.trim();

    // No query: plain category filter, original scan order.
    if (!normalized) {
      return category === "all" ? snapshot.files : snapshot.files.filter((file) => file.category === category);
    }

    // Until the ranked result arrives, keep showing something rather than
    // flickering to empty on every keystroke.
    if (!searchHits) {
      const lowered = normalized.toLowerCase();
      return snapshot.files.filter(
        (file) =>
          (category === "all" || file.category === category) &&
          (file.path.toLowerCase().includes(lowered) || file.purpose.toLowerCase().includes(lowered)),
      );
    }

    const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
    const ranked: KnowledgeFileInsight[] = [];
    for (const hit of searchHits.hits) {
      const file = byPath.get(hit.path);
      if (!file) continue;
      if (category !== "all" && file.category !== category) continue;
      ranked.push(file);
    }
    return ranked;
  }, [category, query, searchHits, snapshot]);

  const selectedFile = useMemo(() => {
    if (!snapshot) return null;
    return snapshot.files.find((file) => file.path === selectedPath) ?? filteredFiles[0] ?? snapshot.files[0] ?? null;
  }, [filteredFiles, selectedPath, snapshot]);

  useEffect(() => {
    // Progress arrives on a push channel rather than as the invoke's return value,
    // because the invoke does not resolve until the whole scan is done — which on a
    // large repo is exactly the window the user has no feedback for.
    return window.agentic.events.subscribeKnowledge((event) => {
      // Ignore progress from a scan this component did not start (a stale scan
      // whose id was already retired, or another window's).
      if (event.scanId !== activeScanId.current) return;
      if (event.phase === "done") lastReused.current = event.reused ?? 0;
      setProgress(event.phase === "done" || event.phase === "cancelled" ? null : event);
    });
  }, []);

  const cancelScan = useCallback(async () => {
    const scanId = activeScanId.current;
    if (!scanId) return;
    await window.agentic.knowledge.cancelScan(scanId);
    setNotice("Scan cancelled; the previous snapshot is unchanged.");
  }, []);

  async function scanProject(options?: { projectPath?: string; maxFiles?: number; maxFileBytes?: number }) {
    let projectPath = options?.projectPath ?? project?.path ?? null;
    if (!projectPath) {
      const pickedPath = await onPickFolder();
      if (!pickedPath) return;
      projectPath = pickedPath;
    }

    if (!projectPath) return;

    const scanId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeScanId.current = scanId;
    lastReused.current = 0;
    setScanning(true);
    setProgress(null);
    setError(null);
    setNotice(null);
    try {
      const next = await window.agentic.knowledge.scan({
        projectPath,
        maxFiles: options?.maxFiles ?? scanMaxFiles,
        maxFileBytes: options?.maxFileBytes ?? scanMaxFileBytes,
        scanId,
      });
      setSnapshot(next);
      setSelectedPath(next.files[0]?.path ?? null);
      // `reused` arrives on the final progress event, not in the snapshot, so read
      // it from there to tell the user how much of the rescan was actually skipped.
      const reused = lastReused.current;
      const reuseNote = reused > 0 ? ` Reused ${reused} unchanged files.` : "";
      setNotice(
        next.truncation
          ? `CodeGraph indexed ${next.indexedFiles} files; skipped ${next.skippedFiles}.${reuseNote}`
          : `CodeGraph indexed ${next.indexedFiles} files.${reuseNote}`,
      );
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      activeScanId.current = null;
      setProgress(null);
      setScanning(false);
    }
  }

  async function boostCapsAndRescan() {
    const nextMaxFiles = Math.min(5_000, Math.max(scanMaxFiles + 200, Math.ceil(scanMaxFiles * 1.5)));
    const nextMaxFileBytes = Math.min(1_000_000, Math.max(scanMaxFileBytes + 20_000, Math.ceil(scanMaxFileBytes * 1.25)));
    setScanMaxFiles(nextMaxFiles);
    setScanMaxFileBytes(nextMaxFileBytes);
    await scanProject({ maxFiles: nextMaxFiles, maxFileBytes: nextMaxFileBytes });
  }

  async function exportSnapshot(format: KnowledgeExportFormat, copyOnly = false) {
    if (!project) return;
    setError(null);
    try {
      const result = await window.agentic.knowledge.export(project.path, format);
      if (copyOnly) {
        await navigator.clipboard.writeText(result.content);
        setNotice(`${result.fileName} copied to clipboard.`);
        return;
      }
      downloadText(result.fileName, result.content, mimeForFormat(format));
      setNotice(`${result.fileName} exported.`);
    } catch (nextError) {
      setError(formatError(nextError));
    }
  }

  return (
    <div className="knowledge-page">
      <section className="knowledge-hero">
        <div className="knowledge-title">
          <span className="knowledge-icon">
            <DatabaseZap size={24} />
          </span>
          <div>
            <h1>CodeGraph Knowledge</h1>
            <p>{project ? project.path : "No project selected"}</p>
          </div>
        </div>
        <div className="knowledge-toolbar">
          <label className="knowledge-search">
            <Search size={15} />
            <input
              placeholder="Search source, symbols, imports..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button className="ghost-button" onClick={() => void onPickFolder()}>
            <FolderOpen size={15} />
            Project
          </button>
          <button className="primary-action" onClick={() => void scanProject()} disabled={scanning || loading}>
            <RefreshCw size={15} className={scanning ? "spin" : ""} />
            {scanning ? "Indexing" : "Scan"}
          </button>
          {scanning && (
            <button className="ghost-button" onClick={() => void cancelScan()}>
              <X size={15} />
              Cancel
            </button>
          )}
        </div>
      </section>

      {progress && <ScanProgressBar progress={progress} />}

      {error && <p className="knowledge-banner error">{error}</p>}
      {notice && <p className="knowledge-banner">{notice}</p>}

      <section className="knowledge-stats" aria-label="Knowledgebase summary">
        <KnowledgeStat icon={<BookOpenText size={17} />} label="Indexed Files" value={snapshot?.indexedFiles ?? 0} tone="blue" />
        <KnowledgeStat icon={<Network size={17} />} label="Graph Edges" value={snapshot?.graph.edges.length ?? 0} tone="cyan" />
        <KnowledgeStat icon={<GitBranch size={17} />} label="Categories" value={snapshot?.categories.length ?? 0} tone="green" />
        <KnowledgeStat icon={<FileCode2 size={17} />} label="Source Size" value={snapshot ? formatBytes(snapshot.totalBytes) : "0 B"} tone="amber" />
      </section>

      {snapshot?.truncation && <TruncationSummary snapshot={snapshot} onBoostCaps={() => void boostCapsAndRescan()} />}

      {!project ? (
        <section className="knowledge-empty">
          <FolderOpen size={28} />
          <h2>Select a project folder</h2>
          <button className="primary-action" onClick={() => void onPickFolder()}>
            <FolderOpen size={15} />
            Pick Folder
          </button>
        </section>
      ) : !snapshot && !loading ? (
        <section className="knowledge-empty">
          <DatabaseZap size={28} />
          <h2>No CodeGraph yet</h2>
          <button className="primary-action" onClick={() => void scanProject()}>
            <RefreshCw size={15} />
            Build CodeGraph
          </button>
        </section>
      ) : (
        <div className="knowledge-layout">
          <aside className="knowledge-left-panel">
            <header>
              <h2>Categories</h2>
              <small>{snapshot ? formatRelative(snapshot.generatedAt) : "Loading"}</small>
            </header>
            {snapshot?.truncation && (
              <p className="knowledge-truncation-note">
                {snapshot.truncation.hitFileLimit
                  ? `Indexed ${snapshot.indexedFiles} files and hit the file limit.`
                  : `Indexed ${snapshot.indexedFiles} files with truncation details available.`}
              </p>
            )}
            <div className="knowledge-category-list">
              <button className={category === "all" ? "selected" : ""} onClick={() => setCategory("all")}>
                <span>All Source</span>
                <em>{snapshot?.indexedFiles ?? 0}</em>
              </button>
              {snapshot?.categories.map((item) => (
                <button
                  key={item.category}
                  className={category === item.category ? "selected" : ""}
                  onClick={() => setCategory(item.category)}
                >
                  <span>{titleCase(item.category)}</span>
                  <em>{item.files}</em>
                </button>
              ))}
            </div>

            <section className="knowledge-language-cloud" aria-label="Languages">
              <h3>Languages</h3>
              <div>
                {snapshot?.languages.slice(0, 12).map((item) => (
                  <button key={item.language} onClick={() => setQuery(item.language)}>
                    {item.language}
                    <em>{item.files}</em>
                  </button>
                ))}
              </div>
            </section>

            <section className="knowledge-export-panel" aria-label="Knowledge exports">
              <h3>Agent Context</h3>
              <div className="knowledge-export-grid">
                {exportOptions.map(({ format, label, icon: Icon }) => (
                  <button key={format} onClick={() => void exportSnapshot(format)} disabled={!snapshot}>
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
              </div>
              <button className="knowledge-copy-button" onClick={() => void exportSnapshot("markdown", true)} disabled={!snapshot}>
                <Copy size={14} />
                Copy MD
              </button>
            </section>
          </aside>

          <main className="knowledge-main-panel">
            <div className="knowledge-tabs" role="tablist" aria-label="Knowledge views">
              <button className={viewMode === "files" ? "active" : ""} onClick={() => setViewMode("files")}>
                Files
              </button>
              <button className={viewMode === "graph" ? "active" : ""} onClick={() => setViewMode("graph")}>
                CodeGraph
              </button>
              <button className={viewMode === "brief" ? "active" : ""} onClick={() => setViewMode("brief")}>
                Agent Brief
              </button>
            </div>

            {viewMode === "files" ? (
              <FileTable files={filteredFiles} selectedPath={selectedFile?.path ?? null} onSelect={setSelectedPath} />
            ) : viewMode === "graph" && snapshot ? (
              <CodeGraphView snapshot={snapshot} selectedFile={selectedFile} />
            ) : (
              <AgentBrief snapshot={snapshot} />
            )}
          </main>

          <aside className="knowledge-detail-panel">
            {selectedFile ? (
              <FileDetail file={selectedFile} edges={snapshot?.graph.edges ?? []} />
            ) : (
              <div className="knowledge-detail-empty">No file selected.</div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/**
 * Live scan feedback. Deliberately shows the phase as well as the count: the
 * `collecting` walk reports no total yet, so a bare "0 / 0" would look stalled
 * on a big repo when it is in fact working.
 */
function ScanProgressBar({ progress }: { progress: KnowledgeScanProgress }) {
  const { phase, processed, total, currentPath } = progress;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const label =
    phase === "collecting"
      ? "Walking the project tree…"
      : phase === "graphing"
        ? "Building the code graph…"
        : `Analyzing ${processed} of ${total} files`;

  return (
    <section className="knowledge-progress" aria-label="Scan progress">
      <div className="knowledge-progress-head">
        <span>{label}</span>
        {total > 0 && phase === "analyzing" && <span className="knowledge-progress-percent">{percent}%</span>}
      </div>
      <div className="knowledge-progress-track">
        {/* Indeterminate until there is a real total to divide by. */}
        <div
          className={`knowledge-progress-fill${total > 0 && phase === "analyzing" ? "" : " indeterminate"}`}
          style={total > 0 && phase === "analyzing" ? { width: `${percent}%` } : undefined}
        />
      </div>
      {currentPath && <p className="knowledge-progress-path">{currentPath}</p>}
    </section>
  );
}

function KnowledgeStat({
  icon,
  label,
  tone,
  value,
}: {
  icon: ReactNode;
  label: string;
  tone: "blue" | "cyan" | "green" | "amber";
  value: number | string;
}) {
  return (
    <article className={`knowledge-stat tone-${tone}`}>
      <span>{icon}</span>
      <strong>{value}</strong>
      <small>{label}</small>
    </article>
  );
}

function TruncationSummary({
  snapshot,
  onBoostCaps,
}: {
  snapshot: KnowledgeSnapshot;
  onBoostCaps: () => void;
}) {
  if (!snapshot.truncation) return null;

  const report = snapshot.truncation;
  const largest = report.largestSkipped ?? [];

  return (
    <section className="knowledge-truncation-panel">
      <header>
        <DatabaseZap size={17} />
        <h2>Truncation Report</h2>
      </header>
      <dl className="knowledge-truncation-grid">
        <div>
          <dt>Hit file limit</dt>
          <dd>{report.hitFileLimit ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt>Files seen</dt>
          <dd>{report.filesSeen}</dd>
        </div>
        <div>
          <dt>Indexed</dt>
          <dd>{report.filesIndexed}</dd>
        </div>
        <div>
          <dt>Unsupported</dt>
          <dd>{report.skippedUnsupported}</dd>
        </div>
        <div>
          <dt>Too large</dt>
          <dd>{report.skippedTooLarge}</dd>
        </div>
        <div>
          <dt>Binary</dt>
          <dd>{report.skippedBinary}</dd>
        </div>
        <div>
          <dt>Unreadable</dt>
          <dd>{report.skippedUnreadable}</dd>
        </div>
        <div>
          <dt>Nodes dropped</dt>
          <dd>{report.graphNodesDropped}</dd>
        </div>
        <div>
          <dt>Edges dropped</dt>
          <dd>{report.graphEdgesDropped}</dd>
        </div>
      </dl>
      {largest.length > 0 && (
        <section className="knowledge-truncation-largest">
          <h3>Largest skipped</h3>
          <ul>
            {largest.map((item) => (
              <li key={item.path}>
                <span>{item.path}</span>
                <em>{formatBytes(item.bytes)}</em>
              </li>
            ))}
          </ul>
        </section>
      )}
      {report.hitFileLimit && (
        <button className="knowledge-copy-button" onClick={onBoostCaps}>
          <RefreshCw size={14} />
          Increase caps and rescan
        </button>
      )}
    </section>
  );
}

function FileTable({
  files,
  onSelect,
  selectedPath,
}: {
  files: KnowledgeFileInsight[];
  onSelect: (path: string) => void;
  selectedPath: string | null;
}) {
  return (
    <section className="knowledge-table">
      <div className="knowledge-table-head">
        <span>Name</span>
        <span>Category</span>
        <span>Symbols</span>
        <span>Size</span>
      </div>
      <div className="knowledge-file-list">
        {files.map((file) => (
          <button
            key={file.path}
            className={selectedPath === file.path ? "selected" : ""}
            onClick={() => onSelect(file.path)}
          >
            <span className="knowledge-file-name">
              <i className={`file-dot dot-${toneForCategory(file.category)}`} />
              <strong>{pathBaseName(file.path)}</strong>
              <small>{file.path}</small>
            </span>
            <em className={`knowledge-chip chip-${toneForCategory(file.category)}`}>{titleCase(file.category)}</em>
            <span>{file.symbols.slice(0, 3).join(", ") || "No symbols"}</span>
            <span>{formatBytes(file.sizeBytes)}</span>
          </button>
        ))}
        {files.length === 0 && <p>No files match this view.</p>}
      </div>
    </section>
  );
}

function CodeGraphView({ snapshot, selectedFile }: { snapshot: KnowledgeSnapshot; selectedFile: KnowledgeFileInsight | null }) {
  const graph = useMemo(() => visibleGraph(snapshot, selectedFile), [selectedFile, snapshot]);

  return (
    <section className="knowledge-graph-view">
      <svg viewBox="0 0 760 360" role="img" aria-label="Project codegraph">
        <defs>
          <linearGradient id="knowledgeEdge" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#67e8f9" stopOpacity=".72" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity=".72" />
          </linearGradient>
        </defs>
        {graph.edges.map((edge) => {
          const source = graph.positions.get(edge.source);
          const target = graph.positions.get(edge.target);
          if (!source || !target) return null;
          return (
            <line
              key={edge.id}
              x1={source.x}
              x2={target.x}
              y1={source.y}
              y2={target.y}
              className={`graph-edge edge-${edge.kind}`}
            />
          );
        })}
        {graph.nodes.map((node) => {
          const position = graph.positions.get(node.id);
          if (!position) return null;
          return (
            <g key={node.id} transform={`translate(${position.x} ${position.y})`}>
              <circle className={`graph-node node-${node.kind}`} r={node.kind === "category" ? 18 : node.kind === "file" ? 13 : 9} />
              <text y={node.kind === "category" ? 33 : 26}>{node.label}</text>
            </g>
          );
        })}
      </svg>
      <div className="knowledge-edge-list">
        {graph.edges.slice(0, 10).map((edge) => (
          <span key={edge.id}>
            {edge.kind}
            <em>{edge.label ?? "local relation"}</em>
          </span>
        ))}
      </div>
    </section>
  );
}

function AgentBrief({ snapshot }: { snapshot: KnowledgeSnapshot | null }) {
  return (
    <section className="knowledge-brief">
      <header>
        <DatabaseZap size={17} />
        <h2>Agent Brief</h2>
      </header>
      <pre>{snapshot?.agentBrief ?? "No knowledge snapshot loaded."}</pre>
      <div className="knowledge-brief-grid">
        {snapshot?.categories.slice(0, 8).map((item) => (
          <span key={item.category}>
            {titleCase(item.category)}
            <em>{item.files} files</em>
          </span>
        ))}
      </div>
    </section>
  );
}

function FileDetail({ edges, file }: { edges: KnowledgeGraphEdge[]; file: KnowledgeFileInsight }) {
  const relatedEdges = edges
    .filter((edge) => edge.source === `file:${file.path}` || edge.target === `file:${file.path}`)
    .slice(0, 12);

  return (
    <section className="knowledge-file-detail">
      <header>
        <span className={`detail-icon dot-${toneForCategory(file.category)}`}>
          <FileCode2 size={20} />
        </span>
        <div>
          <h2>{pathBaseName(file.path)}</h2>
          <p>{file.path}</p>
        </div>
      </header>
      <dl>
        <div>
          <dt>Category</dt>
          <dd>{titleCase(file.category)}</dd>
        </div>
        <div>
          <dt>Language</dt>
          <dd>{file.language}</dd>
        </div>
        <div>
          <dt>Lines</dt>
          <dd>{file.lines}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatRelative(file.updatedAt)}</dd>
        </div>
      </dl>
      <section>
        <h3>Meaning</h3>
        <p>{file.purpose}</p>
      </section>
      <TokenList title="Symbols" items={file.symbols} empty="No symbols detected." />
      <TokenList title="Imports" items={file.imports} empty="No imports detected." />
      <TokenList title="Exports" items={file.exports} empty="No exports detected." />
      <section className="knowledge-relations">
        <h3>Graph Relations</h3>
        {relatedEdges.map((edge) => (
          <span key={edge.id}>
            {edge.kind}
            <em>{edge.label ?? `${edge.source} -> ${edge.target}`}</em>
          </span>
        ))}
        {relatedEdges.length === 0 && <p>No relations detected.</p>}
      </section>
      <section className="knowledge-sample">
        <h3>Source Sample</h3>
        <pre>{file.contentSample || "No text sample available."}</pre>
      </section>
    </section>
  );
}

function TokenList({ empty, items, title }: { empty: string; items: string[]; title: string }) {
  return (
    <section className="knowledge-token-section">
      <h3>{title}</h3>
      <div>
        {items.slice(0, 18).map((item) => (
          <span key={item}>{item}</span>
        ))}
        {items.length === 0 && <p>{empty}</p>}
      </div>
    </section>
  );
}

function visibleGraph(snapshot: KnowledgeSnapshot, selectedFile: KnowledgeFileInsight | null) {
  const preferredFiles = new Set<string>();
  if (selectedFile) {
    preferredFiles.add(selectedFile.path);
    for (const imported of selectedFile.imports) {
      const importedName = imported.replace(/^\.\//, "");
      const found = snapshot.files.find((file) => file.path.endsWith(importedName) || file.path.includes(importedName));
      if (found) preferredFiles.add(found.path);
    }
  }
  snapshot.files.slice(0, 14).forEach((file) => preferredFiles.add(file.path));

  const selectedNodeIds = new Set<string>();
  snapshot.categories.slice(0, 6).forEach((item) => selectedNodeIds.add(`category:${slug(item.category)}`));
  [...preferredFiles].slice(0, 16).forEach((filePath) => selectedNodeIds.add(`file:${filePath}`));

  const edges = snapshot.graph.edges
    .filter((edge) => selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target))
    .slice(0, 40);
  edges.forEach((edge) => {
    selectedNodeIds.add(edge.source);
    selectedNodeIds.add(edge.target);
  });

  const nodes = snapshot.graph.nodes.filter((node) => selectedNodeIds.has(node.id)).slice(0, 34);
  const positions = new Map<string, { x: number; y: number }>();
  const categoryNodes = nodes.filter((node) => node.kind === "category");
  const fileNodes = nodes.filter((node) => node.kind === "file");
  const otherNodes = nodes.filter((node) => node.kind !== "category" && node.kind !== "file");

  categoryNodes.forEach((node, index) => {
    positions.set(node.id, { x: 110, y: 60 + index * 48 });
  });
  fileNodes.forEach((node, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    positions.set(node.id, { x: 310 + column * 145, y: 54 + row * 58 });
  });
  otherNodes.forEach((node, index) => {
    positions.set(node.id, { x: 660, y: 70 + index * 42 });
  });

  return { nodes, edges, positions };
}

function downloadText(fileName: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function mimeForFormat(format: KnowledgeExportFormat): string {
  if (format === "json") return "application/json";
  if (format === "xml") return "application/xml";
  return "text/markdown";
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pathBaseName(value: string): string {
  return value.split("/").at(-1) ?? value;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatRelative(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function toneForCategory(category: string): "blue" | "cyan" | "green" | "amber" | "purple" {
  if (category === "renderer-ui") return "cyan";
  if (category === "desktop-main" || category === "ipc-boundary") return "blue";
  if (category === "persistence" || category === "contracts") return "green";
  if (category === "tests" || category === "automation") return "amber";
  return "purple";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
