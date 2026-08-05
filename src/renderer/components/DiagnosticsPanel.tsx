import {
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  ExternalLink,
  Settings2,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import type { DiagnosticAction, DiagnosticCheck, SystemDiagnostics } from "@contracts";

export function DiagnosticsPanel({
  diagnostics,
  onAction,
}: {
  diagnostics: SystemDiagnostics | null;
  onAction?: (action: DiagnosticAction) => void;
}) {
  const checks = diagnostics?.checks ?? [];
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;

  return (
    <section className="analytics-card desktop-diagnostics">
      <header>
        <div>
          <h2>Workspace Health</h2>
          <p>
            {diagnostics
              ? `${failures} failures · ${warnings} warnings · ${diagnostics.tools.length} tools checked`
              : "Checking tools, auth, project and database…"}
          </p>
        </div>
        <TerminalSquare size={17} />
      </header>

      {checks.length > 0 && (
        <div className="diagnostic-check-list">
          {checks.map((check) => (
            <DiagnosticCheckRow check={check} key={check.key} onAction={onAction} />
          ))}
        </div>
      )}

      <div className="tool-grid">
        {(diagnostics?.tools ?? []).map((tool) => {
          const smoke = tool.checks?.find((check) => check.key.endsWith(":smoke"));
          return (
            <div className={`tool-pill ${tool.installed ? "installed" : "missing"}`} key={tool.id}>
              {tool.installed ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
              <span>
                <strong>{tool.displayName}</strong>
                <small>{tool.detail}</small>
                {smoke && <em className={`diagnostic-status ${smoke.status}`}>Smoke test: {smoke.status}</em>}
              </span>
            </div>
          );
        })}
        {!diagnostics && <p className="empty-note">Scanning local health…</p>}
      </div>
    </section>
  );
}

function DiagnosticCheckRow({
  check,
  onAction,
}: {
  check: DiagnosticCheck;
  onAction?: (action: DiagnosticAction) => void;
}) {
  const Icon =
    check.status === "ok"
      ? CheckCircle2
      : check.status === "fail"
        ? CircleAlert
        : check.status === "warn"
          ? TriangleAlert
          : CircleHelp;

  return (
    <article className={`diagnostic-check status-${check.status}`}>
      <Icon size={15} />
      <span>
        <strong>{check.label}</strong>
        {check.detail && <small>{check.detail}</small>}
      </span>
      {check.action && onAction && (
        <button type="button" onClick={() => onAction(check.action!)}>
          {check.action.target === "settings" ? <Settings2 size={12} /> : <ExternalLink size={12} />}
          {check.action.label}
        </button>
      )}
    </article>
  );
}
