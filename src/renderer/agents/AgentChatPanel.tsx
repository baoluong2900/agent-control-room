import { Bot, CornerDownLeft, Loader2, Radio, Square, Terminal, X } from "lucide-react";
import type { AgentProfile, AgentStatus } from "@contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveModuleSeed } from "./agent-modules";
import { statusLabel, type TerminalChunk, useAgentsStore } from "../stores/agents-store";

type ChatMessage = {
  id: string;
  label: string;
  stream: TerminalChunk["stream"];
  text: string;
  time: string;
};

const streamLabels: Record<TerminalChunk["stream"], string> = {
  event: "system",
  stderr: "agent error",
  stdin: "you",
  stdout: "agent",
};

export function AgentChatPanel({
  cwd,
  profile,
  supportsStructuredChat,
  onClose,
  onOpenTerminal,
}: {
  cwd: string;
  profile: AgentProfile;
  /**
   * Whether this profile's CLI declares a `structuredChat` capability. Chat is
   * still allowed without one — the panel just runs one-shot prompts — but the
   * user is told so rather than left wondering why the agent forgot the thread.
   */
  supportsStructuredChat: boolean;
  onClose: () => void;
  onOpenTerminal: () => void;
}) {
  const { chatConversationIds, chatThreads, runtimes, sessions, terminals, clearTerminal, runProfile, sendInput, stopRun } = useAgentsStore();
  const runtime = runtimes[profile.id];
  const runId = runtime?.runId ?? null;
  const chunks = runId ? terminals[runId] ?? [] : [];
  const module = resolveModuleSeed({ moduleId: profile.module, tags: profile.tags, cliId: profile.cliId });
  const session = useMemo(() => sessions.find((entry) => entry.runId === runId), [runId, sessions]);
  const live = Boolean(session) || runStatusIsLive(runtimes[profile.id]?.status);
  const messages = useMemo(() => {
    const source = profile.cliId === "shell" ? chunks : chatThreads[profile.id] ?? chunks;
    return buildChatMessages(source).slice(-80);
  }, [chatThreads, chunks, profile.cliId, profile.id]);
  const status = runtime?.status ?? session?.status ?? "idle";
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [profile.id]);

  useEffect(() => {
    const node = messagesRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, runId]);

  const start = async () => {
    if (!cwd) return;
    setBusy(true);
    try {
      const prompt = draft.trim() || fallbackPrompt(profile, module.defaultPrompt);
      const launched = await runProfile(profile, {
        cwd,
        // Structured chat is a one-shot print-mode invocation per turn: the
        // prompt goes in argv and the process exits when the answer is done.
        // Only CLIs without that capability keep an interactive stdin session.
        interactive: supportsStructuredChat ? false : true,
        uiMode: "chat",
        resumeConversationId: chatConversationIds[profile.id],
        prompt,
      });
      if (launched) setDraft("");
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const text = draft.trim();

    // A structured-chat turn is always a fresh run resumed by conversation id —
    // the previous process has already exited, so there is no stdin to write to.
    if (supportsStructuredChat) {
      if (!text) return;
      await start();
      return;
    }

    if (live && !text) return;

    if (!live || !runId) {
      await start();
      return;
    }

    const delivered = await sendInput(runId, `${text}\n`);
    if (delivered) setDraft("");
  };

  return (
    <section className="agent-chat-panel" ref={sectionRef}>
      <header className="agent-chat-head">
        <div className="agent-chat-title">
          <span className="agent-chat-avatar" style={{ ["--cli-accent" as string]: profile.accent }}>
            <Bot size={17} />
          </span>
          <div>
            <strong>{profile.name}</strong>
            <small>
              {module.mode} · {profile.cliId} · {statusLabel[status]}
            </small>
          </div>
        </div>
        <div className="agent-chat-controls">
          <span className={`live-pill ${live ? "on" : ""}`}>
            <Radio size={12} />
            {live ? "live" : "idle"}
          </span>
          <button className="ghost-button" onClick={onOpenTerminal}>
            <Terminal size={13} />
            Terminal
          </button>
          <button className="ghost-button" onClick={() => runId && clearTerminal(runId)} disabled={!runId}>
            Clear
          </button>
          <button className="ghost-button" onClick={() => runId && stopRun(runId)} disabled={!live}>
            <Square size={13} />
            Stop
          </button>
          <button className="icon-button" onClick={onClose} aria-label="Close chat">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="agent-chat-context">
        <span>{profile.role}</span>
        <span>{profile.model}</span>
        <span>{cwd || "no folder selected"}</span>
      </div>
      {!cwd && <p className="terminal-warning">Select a project folder first so this agent has a working directory.</p>}
      {!supportsStructuredChat && (
        <p className="terminal-warning">
          {profile.cliId} has no structured chat mode, so each message runs as a fresh one-shot prompt and earlier turns
          are not carried over.
        </p>
      )}

      <div className="agent-chat-messages" ref={messagesRef}>
        {messages.length === 0 ? (
          <div className="agent-chat-empty">
            <Bot size={22} />
            <strong>{module.summary}</strong>
            <small>Send a task to start this configured agent.</small>
          </div>
        ) : (
          messages.map((message) => (
            <article className={`agent-chat-bubble stream-${message.stream}`} key={message.id}>
              <small>
                {message.label}
                <time>{message.time}</time>
              </small>
              <p>{message.text}</p>
            </article>
          ))
        )}
      </div>

      <footer className="agent-chat-input">
        <textarea
          className="agent-chat-textarea"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={
            supportsStructuredChat
              ? live
                ? "Agent is answering — your next message starts the following turn…"
                : "Send a task to this agent…"
              : live
                ? "Message the running agent…"
                : "Start a chat task for this agent…"
          }
          rows={2}
          value={draft}
        />
        <button
          className="primary-action agent-chat-send"
          disabled={busy || !cwd || (supportsStructuredChat ? live || !draft.trim() : live && !draft.trim())}
          onClick={send}
        >
          {busy ? <Loader2 className="spin" size={14} /> : <CornerDownLeft size={14} />}
          {supportsStructuredChat ? (live ? "Working…" : "Send") : live ? "Send" : "Start"}
        </button>
      </footer>
    </section>
  );
}

function buildChatMessages(chunks: TerminalChunk[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let stdoutBuffer = "";
  let stdoutTimestamp = "";
  let stdoutIndex = 0;

  const flushStdout = () => {
    const clean = stripAnsi(stdoutBuffer).trim();
    if (!clean) {
      stdoutBuffer = "";
      return;
    }

    const structured = extractStructuredAssistantText(clean);
    const text = structured || clean;
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
    messages.push({
      id: chunk.id || `${chunk.timestamp}-${index}`,
      label: streamLabels[chunk.stream],
      stream: chunk.stream,
      text: clean,
      time: shortTime(chunk.timestamp),
    });
  }

  flushStdout();
  return messages;
}

function fallbackPrompt(profile: AgentProfile, defaultPrompt: string): string {
  if (profile.cliId === "shell") {
    return `echo "${profile.name} chat session ready"`;
  }
  return profile.systemPrompt || defaultPrompt || "Start a concise interactive agent session.";
}

function shortTime(timestamp: string): string {
  const time = new Date(timestamp);
  if (!Number.isFinite(time.getTime())) return "";
  return time.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function extractStructuredAssistantText(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return firstStructuredText(parsed);
  } catch {
    return null;
  }
}

function firstStructuredText(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const joined = value.map((entry) => firstStructuredText(entry)).filter(Boolean).join("\n\n");
    return joined.trim() || null;
  }
  if (typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  // `response` is agy's field; `result` is claude's. Both come first so a
  // wrapper envelope's own `message`/`content` never shadows the real answer.
  const direct = [record.response, record.result, record.message, record.content, record.text, record.summary]
    .map((entry) => firstStructuredText(entry))
    .find((entry): entry is string => Boolean(entry));
  if (direct) return direct;

  // Agy format: { "type": "text", "text": "..." }
  if (record.type === "text" && typeof record.text === "string") {
    return record.text.trim() || null;
  }

  // Agy/OpenAI format: { "role": "assistant", "content": "..." }
  if (record.role === "assistant" && typeof record.content === "string") {
    return record.content.trim() || null;
  }

  return null;
}

function splitParagraphs(value: string): string[] {
  return value
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function runStatusIsLive(status?: AgentStatus): boolean {
  return status !== "completed" && status !== "failed" && status !== "stopped";
}
