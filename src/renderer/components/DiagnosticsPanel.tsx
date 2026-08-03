import { CheckCircle2, CircleAlert, TerminalSquare } from "lucide-react";
import type { SystemDiagnostics } from "@contracts";

export function DiagnosticsPanel({ diagnostics }: { diagnostics: SystemDiagnostics | null }) {
  return (
    <section className="analytics-card desktop-diagnostics">
      <header>
        <div>
          <h2>CLI Detection</h2>
          <p>Claude, Kiro, Codex, Git, Docker</p>
        </div>
        <TerminalSquare size={17} />
      </header>
      <div className="tool-grid">
        {(diagnostics?.tools ?? []).map((tool) => (
          <div className={`tool-pill ${tool.installed ? "installed" : "missing"}`} key={tool.id}>
            {tool.installed ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
            <span>
              <strong>{tool.displayName}</strong>
              <small>{tool.detail}</small>
            </span>
          </div>
        ))}
        {!diagnostics && <p className="empty-note">Scanning local PATH...</p>}
      </div>
    </section>
  );
}

