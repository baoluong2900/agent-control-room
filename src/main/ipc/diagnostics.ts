import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentCliDescriptor,
  AgentCliId,
  CliDiagnostic,
  DiagnosticCheck,
  ProviderConnection,
  SystemDiagnostics,
} from "@contracts";
import { listAgentCatalog } from "../agents/catalog";
import { pingAgentCli } from "../agents/probe";
import type { DesktopDatabase } from "../database/desktop-database";
import { readGitDiff } from "../git/git-service";
import { defaultEndpointProbe, type EndpointProbe } from "../settings/provider-verification";
import type { SettingsService } from "../settings/settings-service";

const STALE_VERIFICATION_MS = 30 * 24 * 60 * 60_000;
const DATABASE_WARN_BYTES = 100 * 1024 * 1024;
const TERMINAL_LOG_WARN_ROWS = 50_000;

export type DiagnosticsDependencies = {
  listCatalog?: () => AgentCliDescriptor[];
  pingCli?: typeof pingAgentCli;
  checkExternalTool?: typeof checkTool;
  checkProject?: typeof collectProjectChecks;
  /** Injection seam: the live gateway probe, so tests never touch the network. */
  probeEndpoint?: EndpointProbe;
  now?: Date;
};

/**
 * Collects actionable, read-only health information. Provider rows are only
 * inspected: opening Diagnostics must never verify, rotate, or change status.
 */
export async function collectDiagnostics(
  database: DesktopDatabase,
  settingsService: SettingsService,
  projectPath?: string | null,
  dependencies: DiagnosticsDependencies = {},
): Promise<SystemDiagnostics> {
  // Clone the catalog once. The old implementation cloned it for the id list and
  // again for every CLI merely to recover displayName.
  const catalog = (dependencies.listCatalog ?? listAgentCatalog)();
  const descriptors = new Map(catalog.map((entry) => [entry.id, entry]));
  const agentIds = catalog.map((entry) => entry.id).filter((id) => id !== "custom" && id !== "shell");
  const pingCli = dependencies.pingCli ?? pingAgentCli;

  const agentTools = await Promise.all(
    agentIds.map(async (id): Promise<CliDiagnostic> => {
      const ping = await pingCli(id);
      const descriptor = descriptors.get(id);
      return {
        id,
        displayName: descriptor?.displayName ?? id,
        installed: ping.installed,
        command: ping.command,
        version: ping.version,
        detail: ping.detail,
        checks: [
          installedCheck(id, descriptor?.displayName ?? id, ping.installed, ping.detail),
          {
            key: `tool:${id}:smoke`,
            label: "Runnable smoke test",
            status: "unknown",
            detail: "This CLI does not declare a quota-safe smoke test, so Diagnostics did not spend provider quota.",
            action: descriptor?.docsUrl
              ? { label: "Open CLI docs", target: "docs", value: descriptor.docsUrl }
              : undefined,
          },
        ],
      };
    }),
  );

  const externalCheck = dependencies.checkExternalTool ?? checkTool;
  const [git, docker] = await Promise.all([
    externalCheck("git", "Git", ["--version"]),
    externalCheck("docker", "Docker", ["--version"]),
  ]);

  const now = dependencies.now ?? new Date();
  const connections = settingsService.listProviderConnections();
  const checks = [
    ...(await (dependencies.checkProject ?? collectProjectChecks)(projectPath, git.installed)),
    ...collectDatabaseChecks(database),
    ...collectProviderChecks(connections, now),
    // Live, unlike every other provider check: a gateway is a process the user
    // starts and stops outside this app, so stored status cannot answer "is it up".
    ...(await collectGatewayChecks(connections, dependencies.probeEndpoint)),
  ];

  return {
    platform: process.platform,
    checkedAt: now.toISOString(),
    tools: [...agentTools, git, docker],
    checks,
  };
}

function installedCheck(id: AgentCliId | "git" | "docker", displayName: string, installed: boolean, detail?: string): DiagnosticCheck {
  return {
    key: `tool:${id}:installed`,
    label: `${displayName} installed`,
    status: installed ? "ok" : "fail",
    detail: installed ? detail || "Binary found on PATH." : detail || "Binary was not found on PATH.",
    action: installed
      ? undefined
      : { label: `Install ${displayName}`, target: "install", value: id },
  };
}

export async function checkTool(
  id: "git" | "docker",
  displayName: string,
  args: string[],
): Promise<CliDiagnostic> {
  const command = await resolveBinary(id);
  if (!command) {
    const detail = `${displayName} was not found on PATH.`;
    return {
      id,
      displayName,
      installed: false,
      detail,
      checks: [installedCheck(id, displayName, false, detail)],
    };
  }

  const result = await readCommandOutput(command, args);
  const detail = result.ok
    ? result.output || `${displayName} answered successfully.`
    : result.timedOut
      ? `${displayName} was found at ${command}, but ${args.join(" ")} timed out.`
      : `${displayName} was found at ${command}, but its version command failed${
          result.output ? `: ${result.output}` : "."
        }`;

  return {
    id,
    displayName,
    // Presence is intentionally separate from usability: a broken binary is
    // still installed, but its check is warn instead of falsely green.
    installed: true,
    command,
    version: result.ok ? result.output || undefined : undefined,
    detail,
    checks: [
      {
        ...installedCheck(id, displayName, true, detail),
        status: result.ok ? "ok" : "warn",
      },
    ],
  };
}

export async function collectProjectChecks(projectPath?: string | null, gitInstalled = true): Promise<DiagnosticCheck[]> {
  if (!projectPath?.trim()) {
    return [
      {
        key: "project:selected",
        label: "Project folder",
        status: "warn",
        detail: "No project is selected, so folder permissions and Git health cannot be checked.",
        action: { label: "Pick project", target: "project" },
      },
    ];
  }

  const cwd = path.resolve(projectPath);
  let folderStatus: DiagnosticCheck;
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) throw new Error("The selected path is not a directory.");

    const probe = path.join(cwd, `.agentic-healthcheck-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(probe, "Agentic Workspace health check\n", { flag: "wx" });
    } finally {
      await fs.rm(probe, { force: true });
    }

    folderStatus = {
      key: "project:writable",
      label: "Project permissions",
      status: "ok",
      detail: `${cwd} exists and accepts a create/delete probe.`,
    };
  } catch (error) {
    folderStatus = {
      key: "project:writable",
      label: "Project permissions",
      status: "fail",
      detail: `${cwd} is not writable: ${error instanceof Error ? error.message : String(error)}`,
      action: { label: "Pick another folder", target: "project" },
    };
  }

  if (folderStatus.status === "fail") return [folderStatus];
  if (!gitInstalled) {
    return [
      folderStatus,
      {
        key: "project:git",
        label: "Git repository",
        status: "unknown",
        detail: "Git is not installed, so repository status could not be checked.",
        action: { label: "Install Git", target: "install", value: "git" },
      },
    ];
  }

  const git = await readGitDiff(cwd);
  return [
    folderStatus,
    {
      key: "project:git",
      label: "Git repository",
      status: git.isRepository ? "ok" : "warn",
      detail: git.isRepository ? `Repository ready on ${git.branch}.` : git.status,
    },
  ];
}

export function collectDatabaseChecks(database: DesktopDatabase): DiagnosticCheck[] {
  try {
    const health = database.databaseHealth();
    const sizeStatus = health.sizeBytes >= DATABASE_WARN_BYTES ? "warn" : "ok";
    const logStatus = health.terminalLogRows >= TERMINAL_LOG_WARN_ROWS ? "warn" : "ok";
    return [
      {
        key: "database:schema",
        label: "Database schema",
        status: health.schemaVersion > 0 ? "ok" : "warn",
        detail: `Schema version ${health.schemaVersion}.`,
      },
      {
        key: "database:size",
        label: "Database size",
        status: sizeStatus,
        detail: `${formatBytes(health.sizeBytes)} on disk.`,
      },
      {
        key: "database:terminal-logs",
        label: "Terminal log retention",
        status: logStatus,
        detail: `${health.terminalLogRows.toLocaleString()} retained log rows.`,
      },
    ];
  } catch (error) {
    return [
      {
        key: "database:health",
        label: "Database health",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

export function collectProviderChecks(connections: ProviderConnection[], now = new Date()): DiagnosticCheck[] {
  if (connections.length === 0) {
    return [
      {
        key: "provider:none",
        label: "Provider authentication",
        status: "warn",
        detail: "No provider connection is configured. Local shell tasks still work, but hosted agents may not.",
        action: { label: "Configure provider", target: "settings" },
      },
    ];
  }

  return connections.map((connection) => {
    const name = connection.accountLabel?.trim() || connection.provider;
    const verifiedAt = connection.lastVerifiedAt ? Date.parse(connection.lastVerifiedAt) : Number.NaN;
    const stale = Number.isFinite(verifiedAt) && now.getTime() - verifiedAt > STALE_VERIFICATION_MS;

    if (connection.status === "connected" && !stale) {
      return {
        key: `provider:${connection.id}`,
        label: name,
        status: "ok",
        detail: connection.verificationDetail || "Connection is verified.",
      } satisfies DiagnosticCheck;
    }

    const fail = connection.status === "disconnected" || connection.status === "expired";
    return {
      key: `provider:${connection.id}`,
      label: name,
      status: fail ? "fail" : "warn",
      detail: stale
        ? `Last verified ${formatAge(now.getTime() - verifiedAt)} ago. Verify it again in Settings.`
        : connection.verificationDetail ||
          (connection.status === "unverified"
            ? "This connection has not been verified yet."
            : `Connection is ${connection.status}.`),
      action: { label: "Open Settings", target: "settings" },
    } satisfies DiagnosticCheck;
  });
}

/**
 * Reports whether each configured gateway endpoint is answering right now.
 *
 * Separate from `collectProviderChecks`, which reads *stored* verification state:
 * a gateway is a local process the user starts and stops independently of this app,
 * so a row verified an hour ago tells you nothing about whether the proxy is up.
 * This is the one live probe in Diagnostics, and it stays read-only — it reports
 * reachability without touching the connection's stored status.
 */
export async function collectGatewayChecks(
  connections: ProviderConnection[],
  probeEndpoint: EndpointProbe = defaultEndpointProbe,
): Promise<DiagnosticCheck[]> {
  const gateways = connections.filter((connection) => connection.provider === "hermes-agent" && connection.baseUrl?.trim());
  if (gateways.length === 0) return [];

  return Promise.all(
    gateways.map(async (connection): Promise<DiagnosticCheck> => {
      const baseUrl = connection.baseUrl as string;
      const name = connection.accountLabel?.trim() || connection.provider;
      const probe = await probeEndpoint(baseUrl);

      if (!probe.reachable) {
        return {
          key: `gateway:${connection.id}`,
          label: `${name} endpoint`,
          status: "fail",
          detail: `${baseUrl} is not answering${probe.detail ? ` (${probe.detail})` : ""}. Start it with \`hermes proxy start\`.`,
          action: { label: "Open Settings", target: "settings" },
        };
      }

      // Answering but refusing the request means the process is up and its upstream
      // credential is the problem — a different fix from "start the proxy".
      if (probe.statusCode !== undefined && probe.statusCode >= 400) {
        return {
          key: `gateway:${connection.id}`,
          label: `${name} endpoint`,
          status: "warn",
          detail: `${baseUrl} is running but rejected the request (${probe.statusCode}). Log the upstream provider back in.`,
          action: { label: "Open Settings", target: "settings" },
        };
      }

      return {
        key: `gateway:${connection.id}`,
        label: `${name} endpoint`,
        status: "ok",
        detail: `${baseUrl} is answering.`,
      };
    }),
  );
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

type CommandOutput = { ok: boolean; output: string; timedOut: boolean };

async function readCommandOutput(command: string, args: string[]): Promise<CommandOutput> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (result: CommandOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ ok: false, output: firstLine(output), timedOut: true });
    }, 2_500);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => finish({ ok: false, output: error.message, timedOut: false }));
    child.on("exit", (code) => finish({ ok: code === 0, output: firstLine(output), timedOut: false }));
  });
}

function firstLine(output: string): string {
  return output.trim().split(/\r?\n/).find(Boolean) ?? "";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(value: number): string {
  const days = Math.max(1, Math.round(value / (24 * 60 * 60_000)));
  return `${days} day${days === 1 ? "" : "s"}`;
}
