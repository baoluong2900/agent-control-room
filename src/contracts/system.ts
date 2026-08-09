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

/** Where the app's storage sits and how much of it terminal logs account for. */
export interface DatabaseStorageReport {
  path: string;
  schemaVersion: number;
  sizeBytes: number;
  terminalLogRows: number;
  /** Days after a run ends before cleanup is allowed to drop its logs. */
  retentionDays: number;
}

export interface DatabaseMaintenanceResult {
  ok: boolean;
  removedRows: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Bytes actually returned to the filesystem, which needs a vacuum to be > 0. */
  bytesReclaimed: number;
  message: string;
}

