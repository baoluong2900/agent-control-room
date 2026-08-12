import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";

test("Web Server Smoke Test", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-web-test-"));
  
  // Clean up temp directory after test
  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // Spawn the server using our TS loader
  const serverProcess = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-sqlite",
      "--import",
      "./tests/support/register.mjs",
      "./src/server/index.ts",
    ],
    {
      env: {
        ...process.env,
        AGENTIC_PORT: "0", // Let OS choose an ephemeral port
        AGENTIC_DATA_DIR: tmpDir,
      },
    }
  );

  // Terminate server process on test exit
  t.after(() => {
    serverProcess.kill("SIGTERM");
  });

  // Wait for server to boot and report its port
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`Server failed to boot within timeout. Output so far: ${output}`));
    }, 15000);

    serverProcess.stdout.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      output += text;
      const match = /Web Server running at: http:\/\/127.0.0.1:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(parseInt(match[1], 10));
      }
    });

    serverProcess.stderr.on("data", (data: Buffer) => {
      console.error(`[Server Stderr] ${data.toString("utf8")}`);
    });

    serverProcess.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited prematurely with code ${code}. Output: ${output}`));
    });
  });

  console.log(`Test server is running on port: ${port}`);

  // Retrieve the generated auth token
  const tokenPath = path.join(tmpDir, "auth.token");
  // Wait a brief moment for the token file to be written to disk
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(fs.existsSync(tokenPath), "Auth token file was created");
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  assert.ok(token.length > 0, "Auth token is not empty");

  // Test 1: GET /healthz
  const healthRes = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.status, "ok");
  assert.equal(healthData.version, "0.1.0-web");

  // Test 2: Unauthenticated POST /api/agents/catalog should return 401
  const unauthRes = await fetch(`http://127.0.0.1:${port}/api/agents/catalog`, {
    method: "POST",
    body: JSON.stringify([]),
  });
  assert.equal(unauthRes.status, 401, "Should be unauthorized without token");

  // Test 3: Authenticated POST /api/agents/catalog should return catalog array
  const authRes = await fetch(`http://127.0.0.1:${port}/api/agents/catalog`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([]),
  });
  assert.equal(authRes.status, 200, "Should succeed with token");
  const catalog = await authRes.json();
  assert.ok(Array.isArray(catalog), "Catalog is an array");
  
  // Test 4: WebSocket Events Connection
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events?token=${token}`);
  
  const wsHello = await new Promise<any>((resolve, reject) => {
    const wsTimer = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket hello event timed out"));
    }, 5000);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "hello") {
          clearTimeout(wsTimer);
          resolve(msg);
        }
      } catch (err) {
        clearTimeout(wsTimer);
        reject(err);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(wsTimer);
      reject(err);
    });
  });

  assert.equal(wsHello.type, "hello");
  assert.ok("currentSeq" in wsHello);
  ws.close();
});
