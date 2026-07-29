import { create } from "zustand";
import type {
  AgentEvent,
  AgentRunRecord,
  AgentStatus,
  GitDiffSummary,
  ProjectSummary,
  SystemDiagnostics,
} from "@contracts";

export type TerminalLine = {
  id: string;
  runId: string;
  stream: "stdout" | "stderr" | "event";
  message: string;
  timestamp: string;
};

type WorkspaceState = {
  activeRunId: string | null;
  activeStatus: AgentStatus;
  diagnostics: SystemDiagnostics | null;
  gitDiff: GitDiffSummary | null;
  history: AgentRunRecord[];
  project: ProjectSummary | null;
  recentProjects: ProjectSummary[];
  selectedZone: string;
  terminalLines: TerminalLine[];
  setActiveRun: (runId: string | null, status?: AgentStatus) => void;
  setDiagnostics: (diagnostics: SystemDiagnostics) => void;
  setGitDiff: (diff: GitDiffSummary | null) => void;
  setHistory: (history: AgentRunRecord[]) => void;
  setProject: (project: ProjectSummary | null) => void;
  setRecentProjects: (projects: ProjectSummary[]) => void;
  setSelectedZone: (zone: string) => void;
  ingestEvent: (event: AgentEvent) => void;
  clearTerminal: () => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeRunId: null,
  activeStatus: "idle",
  diagnostics: null,
  gitDiff: null,
  history: [],
  project: null,
  recentProjects: [],
  selectedZone: "engine",
  terminalLines: [],
  setActiveRun: (runId, status = "queued") => set({ activeRunId: runId, activeStatus: status }),
  setDiagnostics: (diagnostics) => set({ diagnostics }),
  setGitDiff: (gitDiff) => set({ gitDiff }),
  setHistory: (history) => set({ history }),
  setProject: (project) => set({ project }),
  setRecentProjects: (recentProjects) => set({ recentProjects }),
  setSelectedZone: (selectedZone) => set({ selectedZone }),
  clearTerminal: () => set({ terminalLines: [] }),
  ingestEvent: (event) =>
    set((state) => {
      const stream: TerminalLine["stream"] =
        event.type === "run:stderr" ? "stderr" : event.type === "run:stdout" ? "stdout" : "event";
      const nextLines = event.message
        ? [
            ...state.terminalLines,
            {
              id: `${event.runId}-${event.timestamp}-${state.terminalLines.length}`,
              runId: event.runId,
              stream,
              message: event.message,
              timestamp: event.timestamp,
            },
          ]
        : state.terminalLines;

      return {
        activeRunId: event.runId,
        activeStatus: event.status ?? state.activeStatus,
        terminalLines: nextLines.slice(-600),
      };
    }),
}));
