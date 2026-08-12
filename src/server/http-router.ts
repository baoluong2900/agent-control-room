import type { IncomingMessage, ServerResponse } from "node:http";
import type { IpcRegistry } from "../main/ipc/register-ipc";
import type { ServerAuthManager } from "./auth";

export class HttpServerRouter implements IpcRegistry {
  private handlers = new Map<string, (event: any, ...args: any[]) => any>();

  constructor(private readonly authManager: ServerAuthManager) {}

  handle(channel: string, handler: (event: any, ...args: any[]) => any): void {
    this.handlers.set(channel, handler);
  }

  getHandler(channel: string) {
    return this.handlers.get(channel);
  }

  /**
   * Translates an HTTP request to an IPC handler call.
   * Format: POST /api/<group>/<action> maps to group:action
   * Request body must be a JSON array of arguments.
   */
  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      // 1. Auth check
      if (!this.authManager.verifyRequest(request)) {
        return this.respond(response, 401, { error: "Unauthorized: Missing or invalid token." });
      }

      // 2. Route matching
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = /^\/api\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/.exec(url.pathname);
      if (!match) {
        return this.respond(response, 404, { error: "Not Found" });
      }

      let group = match[1];
      const action = match[2];

      // Normalize group names to match IPC channels (which use singular)
      if (["projects", "agents", "tasks", "workflows"].includes(group)) {
        group = group.slice(0, -1);
      }

      const channel = `${group}:${action}`;
      const handler = this.handlers.get(channel);

      if (!handler) {
        return this.respond(response, 404, { error: `IPC Handler for channel '${channel}' not registered.` });
      }

      if (request.method !== "POST") {
        return this.respond(response, 405, { error: "Only POST requests are supported." });
      }

      // 3. Read body
      const bodyStr = await this.readBody(request);
      let args: any[] = [];
      if (bodyStr.trim()) {
        try {
          const parsed = JSON.parse(bodyStr);
          if (Array.isArray(parsed)) {
            args = parsed;
          } else {
            return this.respond(response, 400, { error: "Request body must be a JSON array of arguments." });
          }
        } catch {
          return this.respond(response, 400, { error: "Invalid JSON in request body." });
        }
      }

      // 4. Invoke handler
      // We pass a mock event object for the first argument (Electron's IpcMainInvokeEvent)
      const mockEvent = { sender: null };
      const result = await handler(mockEvent, ...args);
      return this.respond(response, 200, result);
    } catch (error: any) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      const cleanMessage = this.redactSecrets(originalMessage);
      console.error(`Error handling API request: ${cleanMessage}`);
      return this.respond(response, 500, { error: cleanMessage });
    }
  }

  private respond(response: ServerResponse, status: number, body: any): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "access-control-allow-origin": "*", // CORS handled here or strictly via loopback config
      "access-control-allow-headers": "Content-Type, Authorization",
      "access-control-allow-methods": "POST, OPTIONS",
    });
    response.end(payload);
  }

  handleOptions(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Content-Type, Authorization",
      "access-control-allow-methods": "POST, OPTIONS",
      "content-length": 0,
    });
    response.end();
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      request.on("error", reject);
    });
  }

  private redactSecrets(message: string): string {
    // Redact keys starting with sk- followed by 12+ alphanumeric characters
    let cleaned = message.replace(/sk-[a-zA-Z0-9]{12,}/g, "[REDACTED_API_KEY]");
    // Redact any hex token that looks like our auth token
    cleaned = cleaned.replace(/[a-fA-F0-9]{64}/g, "[REDACTED_TOKEN]");
    return cleaned;
  }
}
