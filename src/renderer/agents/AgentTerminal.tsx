import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { CornerDownLeft, Eraser, Play, Radio, Square, X } from "lucide-react";
import type { AgentProfile, AgentSessionSummary } from "@contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { statusLabel, useAgentsStore } from "../stores/agents-store";

const theme = {
  background: "#070815",
  foreground: "#f7f3ff",
  cursor: "#c4b5fd",
  black: "#11162b",
  blue: "#60a5fa",
  cyan: "#67e8f9",
  green: "#86efac",
  magenta: "#f472b6",
  red: "#fb7185",
  selectionBackground: "#322b5f",
  white: "#f7f3ff",
  yellow: "#fbbf24",
};

export function AgentTerminal({
  profile,
  cwd,
  onClose,
}: {
  profile: AgentProfile;
  cwd: string;
  onClose: () => void;
}) {
  const { runtimes, sessions, terminals, clearTerminal, hydrateTerminal, runProfile, sendInput, stopRun } =
    useAgentsStore();
  const runtime = runtimes[profile.id];
  const runId = runtime?.runId ?? null;
  const chunks = runId ? terminals[runId] ?? [] : [];

  const hostRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const writtenRef = useRef(0);
  const currentRunRef = useRef<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const session: AgentSessionSummary | undefined = useMemo(
    () => sessions.find((entry) => entry.runId === runId),
    [runId, sessions],
  );
  const live = Boolean(session);

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "SFMono-Regular, JetBrains Mono, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.4,
      scrollback: 4000,
      theme,
    });
    terminal.open(hostRef.current);
    terminal.writeln(`\x1b[38;5;141m${profile.name}\x1b[0m · ${profile.cliId} · ${profile.model}`);
    terminal.writeln(`\x1b[2mcwd ${cwd || "(no folder selected)"}\x1b[0m`);
    terminal.writeln("");
    terminalRef.current = terminal;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });

    return () => {
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [cwd, profile.cliId, profile.model, profile.name]);

  // Reopening the panel on an earlier run has no live chunks, so replay the
  // persisted log rows before the render effect below writes to xterm.
  useEffect(() => {
    if (runId) void hydrateTerminal(runId);
  }, [hydrateTerminal, runId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (currentRunRef.current !== runId) {
      currentRunRef.current = runId;
      writtenRef.current = 0;
      terminal.clear();
    }

    for (const chunk of chunks.slice(writtenRef.current)) {
      if (chunk.stream === "event") {
        terminal.write(`\r\n\x1b[38;5;80m▸ ${chunk.message.replace(/\n+$/, "")}\x1b[0m\r\n`);
      } else if (chunk.stream === "stderr") {
        terminal.write(`\x1b[38;5;203m${chunk.message}\x1b[0m`);
      } else if (chunk.stream === "stdin") {
        terminal.write(`\x1b[38;5;147m${chunk.message}\x1b[0m`);
      } else {
        terminal.write(chunk.message);
      }
    }
    writtenRef.current = chunks.length;
    terminal.scrollToBottom();
  }, [chunks, runId]);

  const start = async () => {
    if (!cwd) return;
    setBusy(true);
    try {
      await runProfile(profile, {
        prompt: draft.trim() || profile.systemPrompt || "",
        cwd,
        interactive: profile.interactive,
      });
      setDraft("");
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const text = draft;
    if (!text.trim()) return;

    if (!live || !runId) {
      await start();
      return;
    }

    const delivered = await sendInput(runId, `${text}\n`);
    if (delivered) setDraft("");
  };

  const interrupt = async () => {
    if (runId && live) await sendInput(runId, "\u0003");
  };

  return (
    <section className="agent-terminal" ref={sectionRef}>
      <header>
        <div className="terminal-title">
          <span className="terminal-avatar" style={{ ["--cli-accent" as string]: profile.accent }}>
            {profile.name.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <strong>{profile.name}</strong>
            <small>
              {profile.cliId} · {profile.model}
              {runtime ? ` · ${statusLabel[runtime.status]}` : ""}
            </small>
          </div>
        </div>
        <div className="terminal-controls">
          <span className={`live-pill ${live ? "on" : ""}`}>
            <Radio size={12} />
            {live ? "live" : "idle"}
          </span>
          {session?.pid && <span className="pid-pill">pid {session.pid}</span>}
          <button className="ghost-button" onClick={start} disabled={busy || !cwd}>
            <Play size={13} />
            Run
          </button>
          <button className="ghost-button" onClick={interrupt} disabled={!live}>
            Ctrl+C
          </button>
          <button className="ghost-button" onClick={() => runId && stopRun(runId)} disabled={!live}>
            <Square size={13} />
            Stop
          </button>
          <button className="ghost-button" onClick={() => runId && clearTerminal(runId)} disabled={!runId}>
            <Eraser size={13} />
            Clear
          </button>
          <button className="icon-button" onClick={onClose} aria-label="Close terminal">
            <X size={16} />
          </button>
        </div>
      </header>

      {session && <p className="terminal-command">$ {session.command}</p>}
      {!cwd && <p className="terminal-warning">Select a project folder first — the CLI needs a working directory.</p>}

      <div className="terminal-surface" ref={hostRef} />

      <footer className="terminal-input">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={live ? "Type to the running agent, Enter to send…" : "Describe the task, Enter to start the agent…"}
          rows={2}
        />
        <button className="primary-action" onClick={send} disabled={busy || !cwd}>
          <CornerDownLeft size={14} />
          {live ? "Send" : "Start"}
        </button>
      </footer>
    </section>
  );
}
