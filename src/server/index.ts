import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { ensureAgentPath } from "../main/agents/path-env";
import { DesktopDatabase } from "../main/database/desktop-database";
import { registerIpcHandlers } from "../main/ipc/register-ipc";
import { AgentProcessManager } from "../main/processes/agent-process-manager";
import { ProjectService } from "../main/projects/project-service";
import { ProviderSecretVault } from "../main/settings/provider-secret-vault";
import { SettingsService } from "../main/settings/settings-service";
import { KnowledgeService } from "../main/knowledge/knowledge-service";
import { GatewayChatService } from "../main/gateway/gateway-chat-service";
import { WorkflowService } from "../main/workflows/workflow-service";
import { TaskAutomationService } from "../main/tasks/task-automation-service";
import { WorkflowSchedulerService } from "../main/workflows/workflow-scheduler";
import { WebhookCoordinator } from "../main/workflows/webhook-coordinator";
import { GatewayUsageService } from "../main/gateway/gateway-usage-service";
import { SidecarManager, readSidecarConfig } from "../main/gateway/sidecar-manager";

import { ServerAuthManager } from "./auth";
import { ServerSecretStorage } from "./secret-storage-server";
import { ServerEventHub } from "./event-hub";
import { HttpServerRouter } from "./http-router";

// Resolve directories
const HOME = os.homedir();
const DEFAULT_DATA_DIR = path.join(HOME, ".agentic-workspace");
const dataDir = process.env.AGENTIC_DATA_DIR || DEFAULT_DATA_DIR;

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Global service containers
let database: DesktopDatabase | null = null;
let eventHub: ServerEventHub | null = null;
let router: HttpServerRouter | null = null;
let processManager: AgentProcessManager | null = null;
let taskAutomationService: TaskAutomationService | null = null;
let workflowSchedulerService: WorkflowSchedulerService | null = null;
let webhookCoordinator: WebhookCoordinator | null = null;
let sidecarManager: SidecarManager | null = null;
let gatewayChatService: GatewayChatService | null = null;

async function bootstrap() {
  console.log("Bootstrapping Agentic Workspace Web Server...");
  console.log(`Data directory: ${dataDir}`);

  // Repair PATH env
  ensureAgentPath();

  // 1. Open Database
  database = await DesktopDatabase.open(dataDir);
  const db = database;

  // 2. Auth & Encryption
  const authManager = new ServerAuthManager(dataDir);
  const secretStorage = new ServerSecretStorage(dataDir);
  const providerSecretVault = new ProviderSecretVault(dataDir, secretStorage);

  // 3. HTTP Server Setup
  const port = Number(process.env.AGENTIC_PORT || "5200");
  const host = "127.0.0.1"; // Loopback default

  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    // Health check
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: "0.1.0-web",
          nodeVersion: process.version,
          platform: process.platform,
        }),
      );
      return;
    }

    // API requests
    if (url.pathname.startsWith("/api/")) {
      void router?.handleRequest(req, res);
      return;
    }

    // Static assets serving (Vite build)
    const staticDir = process.env.AGENTIC_STATIC_DIR || path.join(__dirname, "../../.vite/web");
    let filePath = path.join(staticDir, url.pathname === "/" ? "index.html" : url.pathname);

    // Security guard: prevent path traversal
    const relative = path.relative(staticDir, filePath);
    const isSafe = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    if (!isSafe) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA Fallback to index.html
      filePath = path.join(staticDir, "index.html");
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const contentTypes: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
      };
      const contentType = contentTypes[ext] || "application/octet-stream";
      res.writeHead(200, { "content-type": contentType });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  // 4. Event Hub (WebSocket)
  eventHub = new ServerEventHub(server, authManager);
  const broadcaster = () => eventHub;

  // 5. Router Setup
  router = new HttpServerRouter(authManager);

  // 6. Services Setup (injecting eventHub as EventBroadcaster)
  const agentProcessManager = new AgentProcessManager(db, broadcaster, providerSecretVault);
  processManager = agentProcessManager;

  const projectService = new ProjectService(db);
  
  // Link opener returns URL back via verification outcome so client opens it
  const settingsService = new SettingsService(db, providerSecretVault, {
    openExternal: async (url) => {
      console.log(`[LinkOpener] External URL requested: ${url}`);
    },
  });

  const knowledgeService = new KnowledgeService(db, broadcaster);

  gatewayChatService = new GatewayChatService(settingsService, providerSecretVault, broadcaster);

  const workflowService = new WorkflowService(
    db,
    broadcaster,
    providerSecretVault,
  );

  taskAutomationService = new TaskAutomationService(
    db,
    agentProcessManager,
    broadcaster,
    (projectPath) => knowledgeService.get(projectPath),
    providerSecretVault,
  );

  workflowSchedulerService = new WorkflowSchedulerService(workflowService, broadcaster);

  webhookCoordinator = new WebhookCoordinator(
    db,
    providerSecretVault,
    workflowSchedulerService,
    broadcaster,
  );

  const gatewayUsageService = new GatewayUsageService(db, providerSecretVault);

  sidecarManager = new SidecarManager({
    readConfig: () => readSidecarConfig(db),
    onEvent: (message) => {
      eventHub?.send("workflow:event", {
        type: "workflow:log",
        workflowId: "",
        workflowRunId: "",
        message,
        timestamp: new Date().toISOString(),
      });
    },
  });

  // 7. Register API routes
  registerIpcHandlers(router, {
    agentProcessManager,
    database: db,
    knowledgeService,
    projectService,
    settingsService,
    gatewayUsageService,
    gatewayChatService,
    sidecarManager,
    taskAutomationService,
    webhookCoordinator,
    workflowSchedulerService,
    workflowService,
  });

  // 8. Start Services
  taskAutomationService.start();
  workflowSchedulerService.start({ onSync: () => webhookCoordinator?.sync() });
  void webhookCoordinator.sync();
  void sidecarManager.start();

  // 9. Listen
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`\n==================================================`);
    console.log(`Agentic Workspace Web Server running at: http://${host}:${actualPort}`);
    console.log(`WS Events endpoint: ws://${host}:${actualPort}/events`);
    console.log(`API base URL: http://${host}:${actualPort}/api`);
    console.log(`==================================================\n`);
  });

  // Handle server shutdown
  const shutdown = async () => {
    console.log("Shutting down web server...");
    server.close();
    await eventHub?.close();
    taskAutomationService?.stop();
    workflowSchedulerService?.stop();
    await webhookCoordinator?.stop();
    gatewayChatService?.stopAll();
    await sidecarManager?.stop();
    processManager?.stopAll();
    database?.close();
    console.log("Web server shutdown complete.");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

bootstrap().catch((err) => {
  console.error("Failed to bootstrap Web Server:", err);
  process.exit(1);
});
