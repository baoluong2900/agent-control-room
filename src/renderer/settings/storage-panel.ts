import type { DatabaseMaintenanceResult, DatabaseStorageReport } from "@contracts";

/**
 * Presentation logic for the storage panel, kept out of the component so it can be
 * asserted directly. Everything here is a pure function of the report the main
 * process returned.
 */

/** Above this the panel suggests a cleanup rather than just reporting the size. */
export const STORAGE_SUGGEST_CLEANUP_BYTES = 64 * 1024 * 1024;

/** Log-row count that makes terminal history the likely cause of the size. */
export const STORAGE_SUGGEST_CLEANUP_ROWS = 200_000;

export type StorageTone = "ok" | "warn";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  // Clamp the index so a nonsense input cannot index past the unit list and
  // render "undefined".
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

/**
 * Whether the store is large enough to be worth acting on.
 *
 * Either signal alone is enough: a big file with few rows is not terminal logs
 * (cleanup will not help much, but the user should still see the size), while
 * millions of rows in a small file means cleanup has plenty to remove.
 */
export function storageTone(report: DatabaseStorageReport | null): StorageTone {
  if (!report) return "ok";
  if (report.sizeBytes >= STORAGE_SUGGEST_CLEANUP_BYTES) return "warn";
  if (report.terminalLogRows >= STORAGE_SUGGEST_CLEANUP_ROWS) return "warn";
  return "ok";
}

/** One line naming what cleanup would remove, so the button is never a mystery. */
export function describeCleanupScope(report: DatabaseStorageReport | null): string {
  if (!report) return "Reading local storage…";
  return `Removes terminal logs from runs that finished more than ${report.retentionDays} days ago, then reclaims the freed space. Active runs are never touched.`;
}

/**
 * Turns a maintenance result into the sentence shown after the run.
 *
 * The distinction that matters: rows were removed but the file did not shrink.
 * That happens when sqlite could not vacuum, and reporting "freed 0 B" alone
 * would read as a no-op when data really was deleted.
 */
export function describeMaintenance(result: DatabaseMaintenanceResult): string {
  if (!result.ok) return `Cleanup failed: ${result.message}`;

  const removed = result.removedRows
    ? `${result.removedRows.toLocaleString()} log rows removed`
    : "No expired log rows";
  if (result.bytesReclaimed > 0) {
    return `${removed}; ${formatBytes(result.bytesReclaimed)} reclaimed (now ${formatBytes(result.bytesAfter)}).`;
  }
  if (result.removedRows > 0) {
    return `${removed}, but the file did not shrink — the space stays reserved for future writes.`;
  }
  return `${removed} to remove; the store is already compact at ${formatBytes(result.bytesAfter)}.`;
}
