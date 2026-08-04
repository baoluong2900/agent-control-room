import { create } from "zustand";
import type {
  AgentCliDescriptor,
  AgentCliId,
  AgentEvent,
  AgentModelProbe,
  AgentPingResult,
  AgentProfile,
  AgentProfileInput,
  AgentRunRecord,
  AgentSessionSummary,
  AgentStatus,
} from "@contracts";

export type TerminalChunk = {
  id: string;
  stream: "stdout" | "stderr" | "event" | "stdin";
  message: string;
  timestamp: string;
};

export type ActivityEntry = {
  id: string;
  runId: string;
  profileId?: string;
  title: string;
  detail: string;
  status: AgentStatus;
  at: string;
};

/** Live runtime state of one saved agent profile. */
export type AgentRuntime = {
  runId: string;
  status: AgentStatus;
  startedAt: string;
};

type AgentsState = {
  catalog: AgentCliDescriptor[];
  pings: Record<string, AgentPingResult>;
  models: Record<string, AgentModelProbe>;
  profiles: AgentProfile[];
  sessions: AgentSessionSummary[];
  history: AgentRunRecord[];
  activity: ActivityEntry[];
  runtimes: Record<string, AgentRuntime>;
  terminals: Record<string, TerminalChunk[]>;
  chatThreads: Record<string, TerminalChunk[]>;
  chatConversationIds: Record<string, string>;
  activeRunId: string | null;
  loading: boolean;
  pingingAll: boolean;
  error: string | null;

  loadAll: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  pingAll: () => Promise<void>;
  pingOne: (cliId: AgentCliId, commandOverride?: string) => Promise<AgentPingResult>;
  loadModels: (cliId: AgentCliId) => Promise<AgentModelProbe>;
  saveProfile: (input: AgentProfileInput) => Promise<AgentProfile>;
  deleteProfile: (id: string) => Promise<void>;
  runProfile: (profile: AgentProfile, options: { prompt: string; cwd: string; interactive?: boolean; uiMode?: "terminal" | "chat"; resumeConversationId?: string }) => Promise<string | null>;
  stopRun: (runId: string) => Promise<void>;
  sendInput: (runId: string, data: string) => Promise<boolean>;
  setActiveRunId: (runId: string | null) => void;
  hydrateTerminal: (runId: string) => Promise<void>;
  clearTerminal: (runId: string) => void;
  ingest: (event: AgentEvent) => void;
  setError: (error: string | null) => void;
};

const MAX_CHUNKS = 1200;
const MAX_ACTIVITY = 40;

export const useAgentsStore = create<AgentsState>((set, get) => ({
  catalog: [],
  pings: {},
  models: {},
  profiles: [],
  sessions: [],
  history: [],
  activity: [],
  runtimes: {},
  terminals: {},
  chatThreads: {},
  chatConversationIds: {},
  activeRunId: null,
  loading: false,
  pingingAll: false,
  error: null,

  async loadAll() {
    set({ loading: true });
    try {
      const [catalog, profiles, sessions, history] = await Promise.all([
        window.agentic.agents.catalog(),
        window.agentic.agents.listProfiles(),
        window.agentic.agents.sessions(),
        window.agentic.agents.history(),
      ]);
      set({ catalog, profiles, sessions, history, loading: false });
      void get().pingAll();
    } catch (error) {
      set({ loading: false, error: toMessage(error) });
    }
  },

  // The refreshers are fired with `void` from ingest() and from other actions, so
  // an uncaught reject here would surface as nothing but a console warning.
  async refreshProfiles() {
    try {
      const profiles = await window.agentic.agents.listProfiles();
      set({ profiles });
    } catch (error) {
      set({ error: toMessage(error) });
    }
  },

  async refreshSessions() {
    try {
      const sessions = await window.agentic.agents.sessions();
      set({ sessions });
    } catch (error) {
      set({ error: toMessage(error) });
    }
  },

  async refreshHistory() {
    try {
      const history = await window.agentic.agents.history();
      set({ history });
    } catch (error) {
      set({ error: toMessage(error) });
    }
  },

  async pingAll() {
    set({ pingingAll: true });
    try {
      const results = await window.agentic.agents.pingAll();
      set((state) => ({
        pingingAll: false,
        pings: { ...state.pings, ...Object.fromEntries(results.map((result) => [result.cliId, result])) },
      }));
    } catch (error) {
      set({ pingingAll: false, error: toMessage(error) });
    }
  },

  // These three resolve to a value the caller needs, so they record the message
  // for the shared error banner and still rethrow instead of inventing a result.
  async pingOne(cliId, commandOverride) {
    try {
      const result = await window.agentic.agents.ping(cliId, commandOverride);
      set((state) => ({ pings: { ...state.pings, [cliId]: result } }));
      return result;
    } catch (error) {
      set({ error: toMessage(error) });
      throw error;
    }
  },

  async loadModels(cliId) {
    try {
      const probe = await window.agentic.agents.models(cliId);
      set((state) => ({ models: { ...state.models, [cliId]: probe } }));
      return probe;
    } catch (error) {
      set({ error: toMessage(error) });
      throw error;
    }
  },

  async saveProfile(input) {
    let profile: AgentProfile;
    try {
      profile = await window.agentic.agents.saveProfile(input);
    } catch (error) {
      set({ error: toMessage(error) });
      throw error;
    }
    await get().refreshProfiles();
    return profile;
  },

  async deleteProfile(id) {
    try {
      await window.agentic.agents.deleteProfile(id);
    } catch (error) {
      set({ error: toMessage(error) });
      return;
    }
    await get().refreshProfiles();
  },

  async runProfile(profile, options) {
    try {
      const resumeConversationId =
        options.resumeConversationId ??
        (options.uiMode === "chat" ? get().chatConversationIds[profile.id] ?? getLatestConversationId(get().history, profile.id) : undefined);
      const process = await window.agentic.agents.start({
        cliId: profile.cliId,
        cwd: options.cwd,
        prompt: options.prompt,
        model: profile.model,
        profileId: profile.id,
        providerConnectionId: profile.providerConnectionId,
        interactive: options.interactive ?? profile.interactive,
        uiMode: options.uiMode,
        resumeConversationId,
        extraArgs: profile.extraArgs,
        commandOverride: profile.commandOverride,
        promptMode: profile.promptMode,
        forceTty: profile.forceTty,
        autoApprove: profile.autoApprove,
        systemPrompt: profile.systemPrompt,
        options: profile.options,
        shellCommand: profile.cliId === "shell" ? options.prompt : undefined,
      });

      set((state) => ({
        activeRunId: process.runId,
        error: null,
        runtimes: {
          ...state.runtimes,
          [profile.id]: { runId: process.runId, status: process.status, startedAt: new Date().toISOString() },
        },
      }));

      await Promise.all([get().refreshSessions(), get().refreshHistory()]);
      return process.runId;
    } catch (error) {
      set({ error: toMessage(error) });
      return null;
    }
  },

  async stopRun(runId) {
    try {
      await window.agentic.agents.stop(runId);
    } catch (error) {
      set({ error: toMessage(error) });
    }
    // Still resync: the process may have died even though the stop call failed.
    await Promise.all([get().refreshSessions(), get().refreshHistory()]);
  },

  async sendInput(runId, data) {
    let delivered: boolean;
    try {
      delivered = await window.agentic.agents.send(runId, data);
    } catch (error) {
      set({ error: toMessage(error) });
      return false;
    }
    if (delivered) {
      set((state) => ({
        terminals: {
          ...state.terminals,
          [runId]: appendChunk(state.terminals[runId], {
            id: `${runId}-in-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            stream: "stdin",
            message: data,
            timestamp: new Date().toISOString(),
          }),
        },
      }));
    }
    return delivered;
  },

  setActiveRunId(runId) {
    set({ activeRunId: runId });
  },

  // Live chunks only exist for as long as the window has been open, so pull the
  // persisted log rows when a terminal is reopened on a run we never streamed.
  async hydrateTerminal(runId) {
    if (get().terminals[runId]?.length) return;
    try {
      const rows = await window.agentic.agents.logs(runId);
      if (rows.length === 0) return;
      set((state) => ({
        terminals: {
          ...state.terminals,
          [runId]: rows.map((row, index) => ({
            id: `${runId}-log-${index}`,
            stream: normalizeStream(row.stream),
            message: row.message,
            timestamp: row.createdAt,
          })),
        },
      }));
    } catch (error) {
      set({ error: toMessage(error) });
    }
  },

  clearTerminal(runId) {
    set((state) => ({ terminals: { ...state.terminals, [runId]: [] } }));
  },

  ingest(event) {
    const stream: TerminalChunk["stream"] =
      event.type === "run:stderr"
        ? "stderr"
        : event.type === "run:stdout"
          ? "stdout"
          : event.type === "run:stdin"
            ? "stdin"
            : "event";

    set((state) => {
      const terminals = event.message
        ? {
            ...state.terminals,
            [event.runId]: appendChunk(state.terminals[event.runId], {
              id: `${event.runId}-${event.timestamp}-${state.terminals[event.runId]?.length ?? 0}`,
              stream,
              message: event.message,
              timestamp: event.timestamp,
            }),
          }
        : state.terminals;

      const chatThreads =
        event.profileId && event.uiMode === "chat" && event.message
          ? {
              ...state.chatThreads,
              [event.profileId]: appendChunk(state.chatThreads[event.profileId], {
                id: `${event.profileId}-${event.timestamp}-${state.chatThreads[event.profileId]?.length ?? 0}`,
                stream,
                message: event.message,
                timestamp: event.timestamp,
              }),
            }
          : state.chatThreads;

      const chatConversationIds =
        event.profileId && event.conversationId
          ? { ...state.chatConversationIds, [event.profileId]: event.conversationId }
          : state.chatConversationIds;

      const runtimes = { ...state.runtimes };
      if (event.profileId && event.status) {
        const current = runtimes[event.profileId];
        runtimes[event.profileId] = {
          runId: event.runId,
          status: event.status,
          startedAt: current?.startedAt ?? event.timestamp,
        };
      }

      const activity =
        event.type === "run:stdout" || event.type === "run:stderr"
          ? state.activity
          : [
              {
                id: `${event.runId}-${event.type}-${event.timestamp}`,
                runId: event.runId,
                profileId: event.profileId,
                title: activityTitle(event),
                detail: event.message?.split("\n")[0]?.slice(0, 90) ?? event.type,
                status: event.status ?? "idle",
                at: event.timestamp,
              },
              ...state.activity,
            ].slice(0, MAX_ACTIVITY);

      return {
        terminals,
        chatThreads,
        chatConversationIds,
        runtimes,
        activity,
        activeRunId: state.activeRunId ?? event.runId,
      };
    });

    if (event.type === "run:exit" || event.type === "run:error") {
      void get().refreshSessions();
      void get().refreshHistory();
      void get().refreshProfiles();
    }
  },

  setError(error) {
    set({ error });
  },
}));

function appendChunk(existing: TerminalChunk[] | undefined, chunk: TerminalChunk): TerminalChunk[] {
  const next = [...(existing ?? []), chunk];
  return next.length > MAX_CHUNKS ? next.slice(next.length - MAX_CHUNKS) : next;
}

/** Persisted log rows store the stream as a plain string, so narrow it back. */
function normalizeStream(stream: string): TerminalChunk["stream"] {
  return stream === "stderr" || stream === "event" || stream === "stdin" ? stream : "stdout";
}

function activityTitle(event: AgentEvent): string {
  switch (event.type) {
    case "run:created":
      return "Queued";
    case "run:started":
      return "Started";
    case "run:exit":
      return event.status === "completed" ? "Completed" : "Exited";
    case "run:error":
      return "Failed";
    case "run:status":
      return `Status: ${event.status ?? "unknown"}`;
    default:
      return event.type;
  }
}

function getLatestConversationId(history: AgentRunRecord[], profileId: string): string | undefined {
  return history.find((run) => run.profileId === profileId && run.conversationId)?.conversationId;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const text = String(error);
  return text.replace(/^Error invoking remote method '[^']+':\s*/, "");
}

export const statusTone: Record<AgentStatus, "active" | "busy" | "idle" | "error" | "done"> = {
  idle: "idle",
  queued: "busy",
  planning: "busy",
  moving: "busy",
  reading: "busy",
  coding: "active",
  testing: "active",
  reviewing: "active",
  "waiting-approval": "busy",
  completed: "done",
  failed: "error",
  stopped: "idle",
};

export const statusLabel: Record<AgentStatus, string> = {
  idle: "Idle",
  queued: "Queued",
  planning: "Planning",
  moving: "Moving",
  reading: "Reading",
  coding: "In Progress",
  testing: "Testing",
  reviewing: "Reviewing",
  "waiting-approval": "Needs Approval",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};
