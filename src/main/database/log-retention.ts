/**
 * Retention policy for `terminal_logs`.
 *
 * Every stdout/stderr chunk from every agent run is persisted so a terminal can be
 * reopened later. Nothing bounded that, so one noisy long-running agent — a CLI
 * that dumps a minified bundle, or a watch loop that reprints a progress bar
 * thousands of times — could grow the SQLite file without limit.
 *
 * Two independent caps, because they fail in different ways:
 *  - a single enormous chunk (one row, megabytes wide)
 *  - a huge number of ordinary chunks (millions of rows, each small)
 *
 * Plus an age sweep, so logs for runs nobody will reopen do not accumulate forever.
 */

export const logRetention = {
  /**
   * Per-message ceiling. 16 KiB is far more than a terminal line and still holds a
   * full stack trace, so anything above it is a dump rather than something a human
   * reads in the log pane.
   */
  maxMessageBytes: 16 * 1024,
  /**
   * Per-run row ceiling. The terminal only ever renders the last few hundred rows
   * (`listTerminalLogs` defaults to 400), so 5000 keeps generous scrollback while
   * bounding the table.
   */
  maxRowsPerRun: 5000,
  /**
   * Rows appended between prune sweeps. Pruning on every append would run a count
   * plus a delete for every line of output; amortising it keeps the hot path to a
   * single insert while never letting a run exceed the cap by more than this.
   */
  pruneIntervalRows: 250,
  /** Logs for runs that ended longer ago than this are dropped on app start. */
  maxRunAgeDays: 30,
} as const;

export type TruncatedMessage = {
  message: string;
  /** Bytes dropped from the middle; 0 when the message fit. */
  droppedBytes: number;
};

const decoder = new TextDecoder("utf-8");

/**
 * Decodes a byte slice that may end mid-codepoint. A non-fatal TextDecoder emits
 * U+FFFD for the incomplete tail, so drop a single trailing one rather than
 * showing the user a stray replacement character we introduced ourselves.
 */
function decodeSlice(bytes: Uint8Array): string {
  const text = decoder.decode(bytes);
  return text.endsWith("�") ? text.slice(0, -1) : text;
}

/**
 * Clamps one log message to `maxBytes`, keeping the head *and* the tail and
 * dropping the middle.
 *
 * Keeping only the head would lose a command's result; keeping only the tail
 * (which is what workflow step output does) would lose what the dump was of. For a
 * single oversized chunk both ends carry signal, so the middle is what goes, with
 * an inline marker naming the cost. The marker is part of the stored message on
 * purpose: it reaches the terminal pane with no contract or UI change, so a
 * truncation is never silent.
 */
export function truncateLogMessage(message: string, maxBytes = logRetention.maxMessageBytes): TruncatedMessage {
  const bytes = Buffer.byteLength(message, "utf8");
  if (bytes <= maxBytes) return { message, droppedBytes: 0 };

  const buffer = Buffer.from(message, "utf8");
  // Split the budget between the two ends, leaving room for the marker itself.
  const marker = (dropped: number) => `\n… ${formatBytes(dropped)} trimmed by the log retention policy …\n`;
  const reserve = Buffer.byteLength(marker(bytes), "utf8");
  const keep = Math.max(0, maxBytes - reserve);
  const headBytes = Math.ceil(keep * 0.6);
  const tailBytes = keep - headBytes;

  const head = decodeSlice(buffer.subarray(0, headBytes));
  const tail = tailBytes > 0 ? decodeSlice(buffer.subarray(buffer.length - tailBytes)) : "";
  const droppedBytes = bytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");

  return { message: `${head}${marker(droppedBytes)}${tail}`, droppedBytes };
}

/** Clamps an accumulating buffer to its last `maxBytes`, keeping the tail. */
export function clampTail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buffer = Buffer.from(text, "utf8");
  return decodeSlice(buffer.subarray(buffer.length - maxBytes));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
