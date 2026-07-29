import { spawn } from "node:child_process";
import type { CliDiagnostic, SystemDiagnostics } from "@contracts";
import { listAgentCatalog } from "../agents/catalog";
import { pingAgentCli } from "../agents/probe";

export async function collectDiagnostics(): Promise<SystemDiagnostics> {
  const agentIds = listAgentCatalog()
    .map((entry) => entry.id)
    .filter((id) => id !== "custom" && id !== "shell");

  const agentTools = await Promise.all(
    agentIds.map(async (id): Promise<CliDiagnostic> => {
      const ping = await pingAgentCli(id);
      const descriptor = listAgentCatalog().find((entry) => entry.id === id);
      return {
        id,
        displayName: descriptor?.displayName ?? id,
        installed: ping.installed,
        command: ping.command,
        version: ping.version,
        detail: ping.detail,
      };
    }),
  );

  const git = await checkTool("git", "Git", ["--version"]);
  const docker = await checkTool("docker", "Docker", ["--version"]);

  return {
    platform: process.platform,
    checkedAt: new Date().toISOString(),
    tools: [...agentTools, git, docker],
  };
}

async function checkTool(id: "git" | "docker", displayName: string, args: string[]): Promise<CliDiagnostic> {
  const command = await resolveBinary(id);
  if (!command) {
    return {
      id,
      displayName,
      installed: false,
      detail: "Not found on PATH",
    };
  }

  const version = await readCommandOutput(command, args);
  return {
    id,
    displayName,
    installed: true,
    command,
    version: version || undefined,
    detail: version || "Installed",
  };
}

async function resolveBinary(command: string): Promise<string | null> {
  const lookup = process.platform === "win32" ? "where" : "which";

  return new Promise((resolve) => {
    const child = spawn(lookup, [command], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => {
      resolve(code === 0 ? output.split(/\r?\n/).find(Boolean) ?? command : null);
    });
  });
}

async function readCommandOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve(output.trim());
    }, 2_500);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve("");
    });
    child.on("exit", () => {
      clearTimeout(timeout);
      resolve(output.trim().split(/\r?\n/)[0] ?? "");
    });
  });
}
