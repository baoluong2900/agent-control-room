import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { TerminalLine } from "../stores/workspace-store";

export function TerminalPanel({
  activeRunId,
  lines,
  onClear,
}: {
  activeRunId: string | null;
  lines: TerminalLine[];
  onClear: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const writtenCountRef = useRef(0);

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
      fontSize: 12,
      lineHeight: 1.35,
      theme: {
        background: "#070815",
        black: "#11162b",
        blue: "#60a5fa",
        cyan: "#67e8f9",
        cursor: "#c4b5fd",
        foreground: "#f7f3ff",
        green: "#86efac",
        red: "#fb7185",
        selectionBackground: "#322b5f",
        white: "#f7f3ff",
        yellow: "#fbbf24",
      },
    });

    terminal.open(hostRef.current);
    terminal.writeln("Agentic Workspace terminal ready.");
    terminal.writeln("Select a project, choose a CLI, then start an agent.");
    terminalRef.current = terminal;

    return () => {
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    for (const line of lines.slice(writtenCountRef.current)) {
      const prefix = line.stream === "stderr" ? "\x1b[31mstderr\x1b[0m" : line.stream === "event" ? "\x1b[36mevent\x1b[0m" : "\x1b[32mstdout\x1b[0m";
      terminal.write(`\r\n[${prefix}] ${line.message.replace(/\n$/, "")}`);
    }
    writtenCountRef.current = lines.length;
  }, [lines]);

  const clear = () => {
    terminalRef.current?.clear();
    terminalRef.current?.writeln("Terminal cleared.");
    writtenCountRef.current = 0;
    onClear();
  };

  return (
    <section className="bottom-card terminal-card">
      <header>
        <div>
          <h2>Realtime Terminal</h2>
          <p>{activeRunId ? `Run ${activeRunId.slice(0, 8)}` : "No active run"}</p>
        </div>
        <button className="ghost-button" onClick={clear}>
          Clear
        </button>
      </header>
      <div className="terminal-host" ref={hostRef} />
    </section>
  );
}
