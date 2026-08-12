import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";

export class ServerAuthManager {
  private token: string;

  constructor(dataDir: string) {
    const envToken = process.env.AGENTIC_AUTH_TOKEN;
    if (envToken) {
      this.token = envToken.trim();
      if (!this.token) {
        throw new Error("AGENTIC_AUTH_TOKEN env variable cannot be empty.");
      }
      return;
    }

    const tokenPath = process.env.AGENTIC_AUTH_TOKEN_FILE || path.join(dataDir, "auth.token");
    if (fs.existsSync(tokenPath)) {
      this.token = fs.readFileSync(tokenPath, "utf8").trim();
      if (!this.token) {
        throw new Error(`Auth token in ${tokenPath} cannot be empty.`);
      }
    } else {
      this.token = crypto.randomBytes(32).toString("hex");
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, this.token, { encoding: "utf8", mode: 0o600 });
      console.log(`\n==================================================`);
      console.log(`Generated fresh auth token: ${this.token}`);
      console.log(`Saved to: ${tokenPath}`);
      console.log(`==================================================\n`);
    }
  }

  getToken(): string {
    return this.token;
  }

  verifyRequest(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    let provided = "";
    if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
      provided = header.slice(7).trim();
    } else {
      // Allow passing via query parameter ?token=... for WebSockets connection if headers are hard to customize
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      provided = url.searchParams.get("token") || "";
    }

    if (!provided) return false;

    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(this.token, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}
