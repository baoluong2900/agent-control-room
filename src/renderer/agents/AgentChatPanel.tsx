import { Bot, CornerDownLeft, Loader2, Radio, Square, Terminal, X } from "lucide-react";
import type { AgentProfile, AgentStatus } from "@contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveModuleSeed } from "./agent-modules";
import { buildChatMessages } from "./chat-transcript";
import { statusLabel, type TerminalChunk, useAgentsStore } from "../stores/agents-store";

/**
 * Stable empty array for the "no chunks yet" case. Returning a fresh `[]` from a
 * zustand selector makes it a new reference on every store write, which defeats
 * the equality check and re-renders the panel for other agents' output.
 */
const EMPTY_CHUNKS: TerminalChunk[] = [];

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
  // Per-field selectors, not a whole-store destructure: the store is written on
  // every output chunk, and subscribing to all of it re-rendered this panel for
  // unrelated changes (catalog, history, pings, other agents' terminals).
  const runtime = useAgentsStore((state) => state.runtimes[profile.id]);
  const conversationId = useAgentsStore((state) => state.chatConversationIds[profile.id]);
  const sessions = useAgentsStore((state) => state.sessions);
  const clearTerminal = useAgentsStore((state) => state.clearTerminal);
  const runProfile = useAgentsStore((state) => state.runProfile);
  const sendInput = useAgentsStore((state) => state.sendInput);
  const stopRun = useAgentsStore((state) => state.stopRun);
  const runId = runtime?.runId ?? null;
  // Narrow to this run's / this profile's own chunks so another agent streaming
  // in a second panel cannot re-render this one.
  const chunks = useAgentsStore((state) => (runId ? state.terminals[runId] : undefined)) ?? EMPTY_CHUNKS;
  const thread = useAgentsStore((state) => state.chatThreads[profile.id]);
  const module = resolveModuleSeed({ moduleId: profile.module, tags: profile.tags, cliId: profile.cliId });
  const session = useMemo(() => sessions.find((entry) => entry.runId === runId), [runId, sessions]);
  const live = Boolean(session) || runStatusIsLive(runtime?.status);
  const messages = useMemo(() => {
    const source = profile.cliId === "shell" ? chunks : thread ?? chunks;
    return buildChatMessages(source, supportsStructuredChat).slice(-80);
  }, [chunks, profile.cliId, supportsStructuredChat, thread]);
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
        resumeConversationId: conversationId,
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

function fallbackPrompt(profile: AgentProfile, defaultPrompt: string): string {
  if (profile.cliId === "shell") {
    return `echo "${profile.name} chat session ready"`;
  }
  return profile.systemPrompt || defaultPrompt || "Start a concise interactive agent session.";
}

function runStatusIsLive(status?: AgentStatus): boolean {
  return status !== "completed" && status !== "failed" && status !== "stopped";
}
