/**
 * Reads the assistant's answer out of a chat CLI's structured stdout.
 *
 * Every CLI names the field differently and there are two envelope shapes in play,
 * so this lives outside the component and is asserted directly against real
 * captured output rather than through a rendered panel:
 *
 *  - one JSON object for the whole run — claude (`result`), agy (`response`),
 *    grok (`text`)
 *  - JSONL, one event object per line — opencode, where the answer is the `text`
 *    event's `part.text` and the interesting line is buried among step_start /
 *    step_finish bookkeeping
 */

/** Keys that carry the answer, in priority order. */
const ANSWER_KEYS = ["response", "result", "text", "message", "content", "summary"] as const;

/**
 * Pulls the answer text out of one parsed JSON value.
 *
 * The `response`/`result` keys are tried before `message`/`content` so a wrapper
 * envelope's own metadata cannot shadow the real answer.
 */
export function firstStructuredText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => firstStructuredText(entry))
      .filter(Boolean)
      .join("\n\n");
    return joined.trim() || null;
  }
  if (typeof value !== "object") return null;

  const record = value as Record<string, unknown>;

  // opencode: {"type":"text","part":{"type":"text","text":"…"}}. Checked before
  // the generic keys because the envelope also has a `type` of its own, and the
  // nested `part` is the only place the answer lives.
  if (record.type === "text" && record.part && typeof record.part === "object") {
    const part = record.part as Record<string, unknown>;
    if (typeof part.text === "string" && part.text.trim()) return part.text.trim();
  }

  // codex: {"type":"item.completed","item":{"type":"agent_message","text":"…"}}.
  // Only `agent_message` is the reply. The same envelope also carries
  // `command_execution` items — whose `aggregated_output` holds raw shell output —
  // and `error` items whose `message` would otherwise be read as the answer by
  // the generic key scan below. So the item type is matched explicitly and every
  // other item resolves to null, which shows the raw stream instead of lying.
  if (typeof record.type === "string" && record.type.startsWith("item.")) {
    const item = record.item;
    if (item && typeof item === "object") {
      const itemRecord = item as Record<string, unknown>;
      if (itemRecord.type === "agent_message" && typeof itemRecord.text === "string") {
        return itemRecord.text.trim() || null;
      }
    }
    return null;
  }

  // Events that are pure bookkeeping carry no answer; returning null lets the
  // caller keep scanning instead of yielding a step id as if it were text.
  if (typeof record.type === "string" && /^step[_-]/.test(record.type)) return null;

  for (const key of ANSWER_KEYS) {
    const found = firstStructuredText(record[key]);
    if (found) return found;
  }

  if (record.type === "text" && typeof record.text === "string") {
    return record.text.trim() || null;
  }
  if (record.role === "assistant" && typeof record.content === "string") {
    return record.content.trim() || null;
  }

  return null;
}

/**
 * Extracts the answer from a CLI's raw stdout, whether it is one JSON object or
 * JSONL.
 *
 * For JSONL every parseable line is scanned and the answers are joined in
 * arrival order: a CLI that streams its reply across several `text` events would
 * otherwise show only its first fragment. A trailing partial line is normal while
 * output is still streaming and is skipped rather than treated as an error.
 *
 * Returns null when nothing parses, which is the signal to show the raw text —
 * plain-text CLIs and error dumps must not render as an empty message.
 */
export function extractStructuredAssistantText(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;

  try {
    const whole = firstStructuredText(JSON.parse(trimmed));
    if (whole) return whole;
  } catch {
    // Not a single object; fall through to the line-by-line pass.
  }

  const parts: string[] = [];
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (!candidate) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const text = firstStructuredText(parsed);
    if (!text) continue;
    const previous = parts.at(-1);
    // JSONL CLIs may emit deltas ("Hel", "lo") or accumulated snapshots
    // ("Hel", "Hello"). Replace a growing prefix snapshot, ignore a shorter
    // replay, and append only a genuinely new block.
    if (previous && text.startsWith(previous)) {
      parts[parts.length - 1] = text;
    } else if (!previous || !previous.startsWith(text)) {
      parts.push(text);
    }
  }

  return parts.length ? parts.join("\n\n") : null;
}
