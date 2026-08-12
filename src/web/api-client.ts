import type {
  AgenticDesktopApi,
  AgentCliId,
  AgentProfileInput,
  AgentRunInput,
  AppIdentityInput,
  GatewayChatRequest,
  GatewayUsageSettingsInput,
  ProviderConnectionAuthRequest,
  ProviderConnectionInput,
  KnowledgeExportFormat,
  KnowledgeScanInput,
  KnowledgeSearchInput,
  TaskPlanInput,
  TaskSaveInput,
  TaskStatus,
  WorkflowRunOptions,
  WorkflowSaveInput,
  WorkflowStatus,
  AgentEvent,
  WorkflowEvent,
  TaskEvent,
  KnowledgeScanProgress,
  GatewayChatEvent,
} from "@contracts";

class AgenticWebClient implements AgenticDesktopApi {
  private baseUrl: string;
  private token: string;
  private ws: WebSocket | null = null;
  private seq = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // Subscription lists
  private subsAgent = new Set<(event: AgentEvent) => void>();
  private subsWorkflow = new Set<(event: WorkflowEvent) => void>();
  private subsTask = new Set<(event: TaskEvent) => void>();
  private subsKnowledge = new Set<(event: KnowledgeScanProgress) => void>();
  private subsGatewayChat = new Set<(event: GatewayChatEvent) => void>();

  constructor() {
    // Resolve credentials from URL or LocalStorage
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get("token") || params.get("auth_token");
    
    this.token = tokenParam || localStorage.getItem("agentic_auth_token") || "";
    
    // Default base URL to current origin, fallback to local default
    let defaultBase = window.location.origin;
    if (defaultBase.startsWith("file://") || defaultBase.includes("localhost:5173") || defaultBase.includes("127.0.0.1:5173")) {
      defaultBase = "http://127.0.0.1:5200";
    }
    
    const apiParam = params.get("api_base");
    this.baseUrl = apiParam || localStorage.getItem("agentic_api_base") || defaultBase;

    // Persist if resolved from URL params
    if (tokenParam) localStorage.setItem("agentic_auth_token", tokenParam);
    if (apiParam) localStorage.setItem("agentic_api_base", apiParam);

    // Initialize events WebSocket connection
    this.connectWebSocket();
  }

  private connectWebSocket() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }

    const wsUrl = new URL(this.baseUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/events";
    wsUrl.searchParams.set("token", this.token);
    wsUrl.searchParams.set("lastSeq", String(this.seq));

    console.log(`Connecting event WebSocket to: ${wsUrl.toString()}`);

    const socket = new WebSocket(wsUrl.toString());
    this.ws = socket;

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "hello") {
          console.log(`WebSocket server hello, server currentSeq: ${msg.currentSeq}`);
          // If we had no sequence or connection was fresh, sync sequence
          if (this.seq === 0) {
            this.seq = msg.currentSeq;
          }
        } else if (msg.type === "resync") {
          console.log(`WebSocket resynced ${msg.events?.length} missed events.`);
          const events = msg.events || [];
          for (const ev of events) {
            this.dispatchMessage(ev);
          }
        } else if (msg.type === "event") {
          this.dispatchMessage(msg);
        }
      } catch (err) {
        console.error("Error parsing WebSocket message:", err);
      }
    };

    socket.onclose = () => {
      console.warn("WebSocket events connection closed. Reconnecting...");
      this.ws = null;
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connectWebSocket();
        }, 3000);
      }
    };

    socket.onerror = (err) => {
      console.error("WebSocket error:", err);
    };
  }

  private dispatchMessage(msg: { channel: string; seq: number; payload: any }) {
    this.seq = Math.max(this.seq, msg.seq);
    const { channel, payload } = msg;

    switch (channel) {
      case "agent:event":
        this.subsAgent.forEach((cb) => cb(payload));
        break;
      case "workflow:event":
        this.subsWorkflow.forEach((cb) => cb(payload));
        break;
      case "task:event":
        this.subsTask.forEach((cb) => cb(payload));
        break;
      case "knowledge:progress":
        this.subsKnowledge.forEach((cb) => cb(payload));
        break;
      case "gateway:chat-event":
        this.subsGatewayChat.forEach((cb) => cb(payload));
        break;
      default:
        console.warn(`Unhandled event channel: ${channel}`, payload);
    }
  }

  private async request(group: string, action: string, args: any[]): Promise<any> {
    const url = `${this.baseUrl}/api/${group}/${action}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });

    if (!res.ok) {
      let errText = res.statusText;
      try {
        const errJson = await res.json();
        if (errJson && errJson.error) {
          errText = errJson.error;
        }
      } catch {}
      throw new Error(`API Request failed (${res.status}): ${errText}`);
    }

    return res.json();
  }

  // --- API Implementation ---
  system = {
    diagnostics: (projectPath?: string | null) => this.request("system", "diagnostics", [projectPath]),
    storage: () => this.request("system", "storage", []),
    cleanupStorage: () => this.request("system", "cleanup-storage", []),
  };

  projects = {
    selectFolder: async () => {
      // In web browser, showOpenDialog does not exist.
      // We prompt the user to input the directory path directly.
      const projectPath = window.prompt("Enter absolute path to your local project folder (e.g. /Users/username/projects/my-app):");
      if (!projectPath?.trim()) return null;
      return this.request("project", "select-folder", [projectPath.trim()]);
    },
    listRecent: () => this.request("project", "list-recent", []),
    remove: (projectPath: string) => this.request("project", "remove", [projectPath]),
  };

  settings = {
    getIdentity: () => this.request("settings", "get-identity", []),
    saveIdentity: (input: AppIdentityInput) => this.request("settings", "save-identity", [input]),
    listProviderConnections: () => this.request("settings", "list-provider-connections", []),
    saveProviderConnection: (input: ProviderConnectionInput) => this.request("settings", "save-provider-connection", [input]),
    deleteProviderConnection: (id: string) => this.request("settings", "delete-provider-connection", [id]),
    verifyProviderConnection: (id: string) => this.request("settings", "verify-provider-connection", [id]),
    openProviderSite: async (input: ProviderConnectionAuthRequest) => {
      const res = await this.request("settings", "open-provider-site", [input]);
      if (res.opened && res.url) {
        window.open(res.url, "_blank");
      }
      return res;
    },
  };

  agents = {
    catalog: () => this.request("agents", "catalog", []),
    ping: (cliId: AgentCliId, commandOverride?: string) => this.request("agents", "ping", [cliId, commandOverride]),
    pingAll: () => this.request("agents", "ping-all", []),
    models: (cliId: AgentCliId) => this.request("agents", "models", [cliId]),
    start: (input: AgentRunInput) => this.request("agents", "start", [input]),
    restart: (runId: string) => this.request("agents", "restart", [runId]),
    stop: (runId: string) => this.request("agents", "stop", [runId]),
    send: (runId: string, data: string) => this.request("agents", "send", [runId, data]),
    sessions: () => this.request("agents", "sessions", []),
    history: () => this.request("agents", "history", []),
    listProfiles: () => this.request("agents", "listProfiles", []),
    saveProfile: (input: AgentProfileInput) => this.request("agents", "saveProfile", [input]),
    deleteProfile: (id: string) => this.request("agents", "deleteProfile", [id]),
    logs: (runId: string) => this.request("agents", "logs", [runId]),
  };

  tasks = {
    list: (projectPath?: string | null) => this.request("tasks", "list", [projectPath]),
    save: (input: TaskSaveInput) => this.request("tasks", "save", [input]),
    plan: (input: TaskPlanInput) => this.request("tasks", "plan", [input]),
    runDue: () => this.request("tasks", "runDue", []),
    setStatus: (id: string, status: TaskStatus) => this.request("tasks", "setStatus", [id, status]),
    retryNow: (id: string) => this.request("tasks", "retryNow", [id]),
    remove: (id: string) => this.request("tasks", "remove", [id]),
  };

  workflows = {
    list: () => this.request("workflows", "list", []),
    get: (workflowId: string) => this.request("workflows", "get", [workflowId]),
    save: (input: WorkflowSaveInput) => this.request("workflows", "save", [input]),
    remove: (workflowId: string) => this.request("workflows", "remove", [workflowId]),
    duplicate: (workflowId: string) => this.request("workflows", "duplicate", [workflowId]),
    setStatus: (workflowId: string, status: WorkflowStatus) => this.request("workflows", "setStatus", [workflowId, status]),
    toggleFavorite: (workflowId: string) => this.request("workflows", "toggleFavorite", [workflowId]),
    metrics: () => this.request("workflows", "metrics", []),
    activity: (limit?: number) => this.request("workflows", "activity", [limit]),
    runs: (workflowId: string, limit?: number) => this.request("workflows", "runs", [workflowId, limit]),
    run: (options: WorkflowRunOptions) => this.request("workflows", "run", [options]),
    runDueSchedules: () => this.request("workflows", "runDueSchedules", []),
    webhookStatus: () => this.request("workflows", "webhookStatus", []),
    rotateWebhookToken: () => this.request("workflows", "rotateWebhookToken", []),
    cancel: (workflowRunId: string) => this.request("workflows", "cancel", [workflowRunId]),
    approve: (workflowRunId: string) => this.request("workflows", "approve", [workflowRunId]),
    reject: (workflowRunId: string, reason?: string) => this.request("workflows", "reject", [workflowRunId, reason]),
    exportDefinition: (workflowId: string) => this.request("workflows", "exportDefinition", [workflowId]),
    importDefinition: () => this.request("workflows", "importDefinition", []),
  };

  gateway = {
    getUsageSettings: () => this.request("gateway", "getUsageSettings", []),
    saveUsageSettings: (input: GatewayUsageSettingsInput) => this.request("gateway", "saveUsageSettings", [input]),
    getUsageSnapshot: (days?: number) => this.request("gateway", "getUsageSnapshot", [days]),
    listChatTargets: () => this.request("gateway", "listChatTargets", []),
    sendChat: (request: GatewayChatRequest) => this.request("gateway", "sendChat", [request]),
    cancelChat: (requestId: string) => this.request("gateway", "cancelChat", [requestId]),
  };

  git = {
    diff: (cwd: string) => this.request("git", "diff", [cwd]),
    fileDiff: (cwd: string, path: string, staged?: boolean) => this.request("git", "fileDiff", [cwd, path, staged]),
    log: (cwd: string, limit?: number) => this.request("git", "log", [cwd, limit]),
    stage: (cwd: string, path: string) => this.request("git", "stage", [cwd, path]),
    unstage: (cwd: string, path: string) => this.request("git", "unstage", [cwd, path]),
    commit: (cwd: string, message: string) => this.request("git", "commit", [cwd, message]),
    branches: (cwd: string) => this.request("git", "branches", [cwd]),
    checkout: (cwd: string, name: string, create?: boolean) => this.request("git", "checkout", [cwd, name, create]),
    stashes: (cwd: string) => this.request("git", "stashes", [cwd]),
    stashDetail: (cwd: string, ref: string) => this.request("git", "stashDetail", [cwd, ref]),
    stashPush: (cwd: string, message?: string, includeUntracked?: boolean) =>
      this.request("git", "stashPush", [cwd, message, includeUntracked]),
    stashApply: (cwd: string, ref: string, expectedOid: string, keep?: boolean) =>
      this.request("git", "stashApply", [cwd, ref, expectedOid, keep]),
    stashDrop: (cwd: string, ref: string, expectedOid: string) =>
      this.request("git", "stashDrop", [cwd, ref, expectedOid]),
    tracking: (cwd: string) => this.request("git", "tracking", [cwd]),
    fetch: (cwd: string, remote?: string) => this.request("git", "fetch", [cwd, remote]),
    pull: (cwd: string, remote?: string) =>
      this.request("git", "pull", [cwd, remote]),
    pushPlan: (cwd: string, remote?: string) => this.request("git", "pushPlan", [cwd, remote]),
    push: (cwd: string, options?: { remote?: string; allowProtected?: boolean; expectedBranch?: string }) =>
      this.request("git", "push", [cwd, options]),
    blame: (cwd: string, path: string) => this.request("git", "blame", [cwd, path]),
  };

  knowledge = {
    get: (projectPath: string) => this.request("knowledge", "get", [projectPath]),
    scan: (input: KnowledgeScanInput) => this.request("knowledge", "scan", [input]),
    cancelScan: (scanId: string) => this.request("knowledge", "cancelScan", [scanId]),
    search: (input: KnowledgeSearchInput) => this.request("knowledge", "search", [input]),
    export: (projectPath: string, format: KnowledgeExportFormat) =>
      this.request("knowledge", "export", [projectPath, format]),
  };

  events = {
    subscribe: (callback: (event: AgentEvent) => void) => {
      this.subsAgent.add(callback);
      return () => {
        this.subsAgent.delete(callback);
      };
    },
    subscribeWorkflow: (callback: (event: WorkflowEvent) => void) => {
      this.subsWorkflow.add(callback);
      return () => {
        this.subsWorkflow.delete(callback);
      };
    },
    subscribeTask: (callback: (event: TaskEvent) => void) => {
      this.subsTask.add(callback);
      return () => {
        this.subsTask.delete(callback);
      };
    },
    subscribeKnowledge: (callback: (event: KnowledgeScanProgress) => void) => {
      this.subsKnowledge.add(callback);
      return () => {
        this.subsKnowledge.delete(callback);
      };
    },
    subscribeGatewayChat: (callback: (event: GatewayChatEvent) => void) => {
      this.subsGatewayChat.add(callback);
      return () => {
        this.subsGatewayChat.delete(callback);
      };
    },
  };
}

// Bind to window if in browser environment
if (typeof window !== "undefined" && !(window as any).agentic) {
  (window as any).agentic = new AgenticWebClient();
}
