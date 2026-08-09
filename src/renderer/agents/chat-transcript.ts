/**
 * Turns a run's raw output chunks into chat bubbles.
 *
 * Lives outside the component so it can be asserted against real captured CLI
 * output instead of through a rendered panel — the same reason
 * `structured-chat-output.ts` is separate.
 */
import { extractStructuredAssistantText } from "./structured-chat-output";

export type ChatMessageStream = "stdout" | "stderr" | "stdin" | "event";

/**
 * The shape this module needs from the store's `TerminalChunk`, declared
 * structurally so the transcript logic — and its test — do not pull in the
 * zustand store just to read four fields.
 */
export interface TranscriptChunk {
  id?: string;
  stream: ChatMessageStream;
  message: string;
  timestamp: string;
}

export interface ChatMessage {
  id: string;
  label: string;
  stream: ChatMessageStream;
  text: string;
  time: string;
}

export const streamLabels: Record<ChatMessageStream, string> = {
  event: "system",
  stderr: "agent error",
  stdin: "you",
  stdout: "agent",
};

/**
 * @param structured whether this run is a structured chat, which changes what
 * happens to stderr. A chat CLI writes diagnostics there while still answering
 * perfectly well on stdout — codex prints `Reading additional input from
 * stdin...` plus one `ERROR codex_login::auth::manager` line per token refresh,
 * dozens per turn. Rendering those as messages buries the reply, so they are
 * held back and shown only when stdout produced no answer at all — the case
 * where the diagnostics *are* the useful output. A non-chat CLI keeps the
 * interleaved behaviour: there is no answer to protect.
 */
export function buildChatMessages(chunks: TranscriptChunk[], structured = false): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const heldStderr: ChatMessage[] = [];
  let stdoutBuffer = "";
  let stdoutTimestamp = "";
  let stdoutIndex = 0;
  let answered = false;

  const flushStdout = () => {
    const clean = stripAnsi(stdoutBuffer).trim();
    if (!clean) {
      stdoutBuffer = "";
      return;
    }

    const extracted = extractStructuredAssistantText(clean);
    const text = extracted || clean;
    answered = true;
    for (const part of splitParagraphs(text)) {
      messages.push({
        id: `stdout-${stdoutTimestamp}-${stdoutIndex}`,
        label: streamLabels.stdout,
        stream: "stdout",
        text: part,
        time: shortTime(stdoutTimestamp),
      });
      stdoutIndex += 1;
    }

    stdoutBuffer = "";
  };

  for (const [index, chunk] of chunks.entries()) {
    if (chunk.stream === "stdout") {
      if (!stdoutBuffer) stdoutTimestamp = chunk.timestamp;
      stdoutBuffer += chunk.message;
      continue;
    }

    flushStdout();
    const clean = stripAnsi(chunk.message).trim();
    if (!clean) continue;
    const message: ChatMessage = {
      id: chunk.id || `${chunk.timestamp}-${index}`,
      label: streamLabels[chunk.stream],
      stream: chunk.stream,
      text: clean,
      time: shortTime(chunk.timestamp),
    };
    if (structured && chunk.stream === "stderr") {
      heldStderr.push(message);
      continue;
    }
    messages.push(message);
  }

  flushStdout();
  // Only surface the diagnostics when there is no answer to show instead. A
  // silent failure with its reason suppressed would be worse than noise.
  if (!answered) messages.push(...heldStderr);
  return messages;
}

export function shortTime(timestamp: string): string {
  const time = new Date(timestamp);
  if (!Number.isFinite(time.getTime())) return "";
  return time.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function splitParagraphs(value: string): string[] {
  return value
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}
