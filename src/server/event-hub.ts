import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { EventBroadcaster } from "../contracts/ipc";
import type { ServerAuthManager } from "./auth";

interface BufferedEvent {
  channel: string;
  seq: number;
  payload: any;
  timestamp: string;
}

export class ServerEventHub implements EventBroadcaster {
  private wss: WebSocketServer | null = null;
  private seq = 0;
  private readonly eventBuffer: BufferedEvent[] = [];
  private readonly maxBufferSize = 200;

  constructor(
    private readonly httpServer: HttpServer,
    private readonly authManager: ServerAuthManager,
  ) {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle the HTTP upgrade manually so we can verify auth
    this.httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/events") {
        if (!this.authManager.verifyRequest(request)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        this.wss?.handleUpgrade(request, socket, head, (ws) => {
          this.wss?.emit("connection", ws, request);
        });
      }
    });

    this.wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const clientLastSeqStr = url.searchParams.get("lastSeq");
      
      // Send current sequence number immediately upon connection
      ws.send(JSON.stringify({ type: "hello", currentSeq: this.seq }));

      // Resync history if requested
      if (clientLastSeqStr !== null) {
        const clientLastSeq = parseInt(clientLastSeqStr, 10);
        if (!isNaN(clientLastSeq) && clientLastSeq < this.seq) {
          const missed = this.eventBuffer.filter((e) => e.seq > clientLastSeq);
          if (missed.length > 0) {
            ws.send(JSON.stringify({ type: "resync", events: missed }));
          }
        }
      }

      ws.on("error", (err) => {
        console.error("WebSocket client connection error:", err);
      });
    });
  }

  send(channel: string, payload: any): void {
    this.seq++;
    const event: BufferedEvent = {
      channel,
      seq: this.seq,
      payload,
      timestamp: new Date().toISOString(),
    };

    // Buffer the event for resync
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer.shift();
    }

    // Broadcast to all authenticated clients
    if (this.wss) {
      const message = JSON.stringify({ type: "event", ...event });
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
