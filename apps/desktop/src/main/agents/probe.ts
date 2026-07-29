import { spawn } from "node:child_process";
import process from "node:process";
import type { AgentCliId, AgentModelOption, AgentModelProbe, AgentPingResult } from "@contracts";
import { getAgentDescriptor, listAgentCatalog } from "./catalog";
import { parseArgs, resolveExecutable } from "./commands";

const PING_TIMEOUT_MS = 6_000;

/** Runs `<cli> --version` and reports install state plus latency. */
export async function pingAgentCli(cliId: AgentCliId, commandOverride?: string): Promise<AgentPingResult> {
  const descriptor = getAgentDescriptor(cliId);
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  if (cliId === "shell") {
    const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "sh");
    return {
      cliId,
      ok: true,
      installed: true,
      command: shell,
      version: shell,
      latencyMs: Date.now() - startedAt,
      checkedAt,
      detail: `Local shell ready (${shell})`,
    };
  }

  const resolved = await resolveExecutable(cliId, commandOverride);
  if (!resolved) {
    return {
      cliId,
      ok: false,
      installed: false,
      latencyMs: Date.now() - startedAt,
      checkedAt,
      detail: commandOverride?.trim()
        ? `Command "${commandOverride.trim()}" not found`
        : `Not found on PATH (tried ${descriptor.commandCandidates.join(", ") || "no candidates"})`,
    };
  }

  const parts = parseArgs(resolved);
  const executable = parts[0] ?? resolved;
  const result = await runCapture(executable, [...parts.slice(1), ...descriptor.versionArgs]);
  const latencyMs = Date.now() - startedAt;
  const version = firstLine(result.output);

  return {
    cliId,
    ok: result.code === 0 || Boolean(version),
    installed: true,
    command: executable,
    version: version || undefined,
    latencyMs,
    checkedAt,
    detail: version || (result.code === 0 ? "Installed" : `Exited with code ${result.code ?? "unknown"}`),
  };
}

export async function pingAllAgentClis(): Promise<AgentPingResult[]> {
  const ids = listAgentCatalog()
    .map((entry) => entry.id)
    .filter((id) => id !== "custom");

  return Promise.all(ids.map((id) => pingAgentCli(id)));
}

/**
 * Returns selectable models for a CLI. Uses the CLI's own listing command when
 * the catalog defines one, otherwise falls back to the static catalog.
 */
export async function probeAgentModels(cliId: AgentCliId): Promise<AgentModelProbe> {
  const descriptor = getAgentDescriptor(cliId);
  const checkedAt = new Date().toISOString();
  const fallback: AgentModelProbe = {
    cliId,
    models: descriptor.models,
    source: "catalog",
    detail: `${descriptor.models.length} models from catalog`,
    checkedAt,
  };

  if (!descriptor.modelListArgs) return fallback;

  const resolved = await resolveExecutable(cliId);
  if (!resolved) return { ...fallback, detail: `${descriptor.displayName} not installed, showing catalog models` };

  const parts = parseArgs(resolved);
  const result = await runCapture(parts[0] ?? resolved, [...parts.slice(1), ...descriptor.modelListArgs]);
  const detected = parseModelList(cliId, result.output);

  if (detected.length === 0) {
    return { ...fallback, detail: "CLI returned no model list, showing catalog models" };
  }

  const merged = dedupeModels([...detected, ...descriptor.models]);
  return {
    cliId,
    models: merged,
    source: "cli",
    detail: `${detected.length} models detected from ${descriptor.displayName}`,
    checkedAt,
  };
}

function parseModelList(cliId: AgentCliId, output: string): AgentModelOption[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (cliId === "ollama") {
    return lines
      .filter((line) => !/^name\s+id\s+size/i.test(line))
      .map((line) => line.split(/\s+/)[0])
      .filter((name) => Boolean(name) && name !== "NAME")
      .map((name) => ({ id: name, label: name, note: "Detected locally" }));
  }

  return lines
    .filter((line) => /^[-*\s]*[\w./:-]+$/.test(line))
    .map((line) => line.replace(/^[-*\s]+/, ""))
    .filter((line) => line.length > 1 && line.length < 80)
    .slice(0, 60)
    .map((name) => ({ id: name, label: name, note: "Detected from CLI" }));
}

function dedupeModels(models: AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>();
  const output: AgentModelOption[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    output.push(model);
  }
  return output;
}

function firstLine(output: string): string {
  return output.trim().split(/\r?\n/).find(Boolean)?.trim() ?? "";
}

function runCapture(command: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, PING_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", () => finish(null));
    child.on("exit", (code) => finish(code));
  });
}
