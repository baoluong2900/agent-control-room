import type { AgentCliId } from "./agent";

export interface CliDiagnostic {
  id: AgentCliId | "git" | "docker";
  displayName: string;
  installed: boolean;
  command?: string;
  version?: string;
  detail: string;
}

export interface SystemDiagnostics {
  platform: NodeJS.Platform;
  checkedAt: string;
  tools: CliDiagnostic[];
}

