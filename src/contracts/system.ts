import type { AgentCliId } from "./agent";

export type DiagnosticStatus = "ok" | "warn" | "fail" | "unknown";

export interface DiagnosticAction {
  label: string;
  target: "settings" | "docs" | "install" | "project";
  value?: string;
}

/** One actionable health fact, independent of how the renderer displays it. */
export interface DiagnosticCheck {
  key: string;
  label: string;
  status: DiagnosticStatus;
  detail?: string;
  action?: DiagnosticAction;
}

export interface CliDiagnostic {
  id: AgentCliId | "git" | "docker";
  displayName: string;
  installed: boolean;
  command?: string;
  version?: string;
  detail: string;
  /** Installed is only tier one; later checks explain whether it is usable. */
  checks?: DiagnosticCheck[];
}

export interface SystemDiagnostics {
  platform: NodeJS.Platform;
  checkedAt: string;
  tools: CliDiagnostic[];
  /** Project, provider and database checks that are not owned by one CLI. */
  checks: DiagnosticCheck[];
}

