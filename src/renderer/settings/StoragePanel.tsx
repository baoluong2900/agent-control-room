import { Database, RefreshCw, Trash2 } from "lucide-react";
import type { DatabaseStorageReport } from "@contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeCleanupScope, describeMaintenance, formatBytes, storageTone } from "./storage-panel";

/**
 * Local storage size, and the manual cleanup that Diagnostics previously reported
 * on without offering any way to act.
 *
 * Read once on mount and after each cleanup rather than polled: the file only
 * changes when agents write logs, and a size readout is not worth a timer.
 */
export function StoragePanel() {
  const [report, setReport] = useState<DatabaseStorageReport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A read resolving after unmount must not set state on a dead component.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await window.agentic.system.storage();
      if (mountedRef.current) {
        setReport(next);
        setError(null);
      }
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function cleanup() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.agentic.system.cleanupStorage();
      if (!mountedRef.current) return;
      setNotice(describeMaintenance(result));
      // Re-read rather than trusting the result's own numbers: the report is what
      // the panel displays, and it has to come from the same source every time.
      await load();
    } catch (cause) {
      if (mountedRef.current) setNotice(`Cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const tone = storageTone(report);

  return (
    <section className="integrations-panel">
      <header>
        <div>
          <h2>Local Storage</h2>
          <p>Workspace database and terminal history</p>
        </div>
        <button className="integrations-link" disabled={busy} onClick={() => void load()} type="button">
          <RefreshCw size={13} />
          Refresh
        </button>
      </header>

      {error ? (
        <p className="storage-error">Could not read storage: {error}</p>
      ) : (
        <>
          <div className="integrations-summary">
            <span>
              <strong className={`storage-size tone-${tone}`}>{report ? formatBytes(report.sizeBytes) : "—"}</strong>
              <small>Database</small>
            </span>
            <span>
              <strong>{report ? report.terminalLogRows.toLocaleString() : "—"}</strong>
              <small>Log rows</small>
            </span>
            <span>
              <strong>{report ? `v${report.schemaVersion}` : "—"}</strong>
              <small>Schema</small>
            </span>
          </div>

          {report?.path && (
            <p className="storage-path" title={report.path}>
              <Database size={12} />
              {report.path}
            </p>
          )}

          <p className="storage-scope">{describeCleanupScope(report)}</p>

          {notice && <p className="storage-notice">{notice}</p>}

          <button className="integrations-primary" disabled={busy || !report} onClick={() => void cleanup()} type="button">
            <Trash2 size={13} />
            {busy ? "Cleaning…" : "Clean up now"}
          </button>
        </>
      )}
    </section>
  );
}
