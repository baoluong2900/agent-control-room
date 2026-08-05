import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { terminateProcessTree } from "../processes/process-tree";

/**
 * Lifecycle owner for an external AI-gateway sidecar (9Router / CLIProxyAPI).
 *
 * Phase 1 of `docs/feature/ai-gateway-sidecar.md`: spawn/stop, health, port
 * selection and conflict handling, log capture. Deliberately *no* model routing and
 * no `/v1` proxying — those are phases 3+, and building them on an unproven
 * lifecycle is how you get orphaned processes holding a port.
 *
 * The app does not bundle or download a binary. That is the product decision this
 * plan defers, so the command is configuration: nothing is spawned until someone
 * supplies one. An unconfigured sidecar is a no-op, not an error.
 *
 * Security posture follows the plan's mandatory list and the pattern the webhook
 * listener established: loopback only, a local key required on every call, and the
 * key never written to logs.
 */

/** Sidecar output kept in memory for Diagnostics. Older lines are dropped. */
const MAX_LOG_LINES = 500;

/** How long a stop waits for the tree to die before reporting what it did. */
const STOP_GRACE_MS = 3_000;

/** A crash within this window of starting counts as "failed to start", not "died". */
const STARTUP_WINDOW_MS = 2_000;

export type SidecarConfig = {
  /** Executable to run. Empty/absent means the feature is simply not configured. */
  command?: string;
  args?: string[];
  /** Fixed port, or 0/absent to let the OS pick a free one. */
  port?: number;
  cwd?: string;
  /**
   * Extra environment for the child. The local key is injected separately so it
   * cannot be shadowed by a stale value here.
   */
  env?: Record<string, string>;
};

/**
 * No `starting`: `start()` resolves once the child has spawned or failed, so a caller
 * never observes an in-between state. Phase 3 can add one if a readiness handshake
 * makes the distinction real.
 */
export type SidecarState = "stopped" | "running" | "failed";

export type SidecarStatus = {
  state: SidecarState;
  pid: number | null;
  port: number | null;
  /** Base URL callers would use. Null unless running. */
  baseUrl: string | null;
  /** Why it is not running, when that is not simply "nobody configured it". */
  error: string | null;
  configured: boolean;
  /** Wall-clock start, so Diagnostics can show uptime. */
  startedAt: string | null;
  restarts: number;
};

export type SidecarLogLine = {
  stream: "stdout" | "stderr";
  message: string;
  timestamp: string;
};

export type SidecarManagerOptions = {
  /** Reads current config; re-read on every start so edits do not need a restart. */
  readConfig: () => SidecarConfig;
  /** Surfaces lifecycle transitions to the UI log. */
  onEvent?: (message: string) => void;
  /** Injection seam for tests. */
  spawnProcess?: typeof spawn;
  /** Injection seam for tests: reports whether a TCP port is free. */
  probePort?: (port: number) => Promise<boolean>;
};

/** Settings keys holding the sidecar configuration. */
export const SIDECAR_SETTING_KEYS = {
  command: "gateway.sidecar.command",
  args: "gateway.sidecar.args",
  port: "gateway.sidecar.port",
  cwd: "gateway.sidecar.cwd",
} as const;

/**
 * Reads sidecar config from the settings table.
 *
 * Config-driven rather than bundled: whether to ship a router binary is the product
 * decision this plan defers, so until it is made the app can still manage a binary
 * the user points it at. Absent command means the feature is off.
 */
export function readSidecarConfig(store: { getSetting(key: string): string | undefined }): SidecarConfig {
  const rawPort = Number(store.getSetting(SIDECAR_SETTING_KEYS.port) ?? "");
  const rawArgs = store.getSetting(SIDECAR_SETTING_KEYS.args)?.trim();

  return {
    command: store.getSetting(SIDECAR_SETTING_KEYS.command)?.trim() || undefined,
    // Whitespace-split rather than shell-parsed: this is spawned without a shell,
    // so pretending to support quoting would be a lie about how it is executed.
    args: rawArgs ? rawArgs.split(/\s+/) : [],
    port: Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65_536 ? rawPort : undefined,
    cwd: store.getSetting(SIDECAR_SETTING_KEYS.cwd)?.trim() || undefined,
  };
}

/** Generates the local API key. Same entropy budget as the webhook token. */
export function generateLocalKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * True when nothing is listening on `port` at loopback.
 *
 * Binding-then-closing is the only reliable check: asking the OS for a free port
 * and then handing it to a child is inherently racy, but detecting an *occupied*
 * configured port lets the manager report a real conflict instead of spawning a
 * child that dies immediately with an opaque error.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** Asks the OS for a currently-free loopback port. */
function reserveEphemeralPort(): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => resolve(port));
    });
    server.listen(0, "127.0.0.1");
  });
}

export class SidecarManager {
  private child: ChildProcess | null = null;
  private state: SidecarState = "stopped";
  private port: number | null = null;
  private lastError: string | null = null;
  private startedAt: Date | null = null;
  /** Spawn time of the current child, kept separate: `stop()` clears `startedAt`. */
  private spawnedAtMs = 0;
  private restarts = 0;
  private localKey: string | null = null;
  private readonly logs: SidecarLogLine[] = [];
  /** Set while `stop()` runs so an exit handler does not report a crash. */
  private stopping = false;

  constructor(private readonly options: SidecarManagerOptions) {}

  status(): SidecarStatus {
    const config = this.options.readConfig();
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      port: this.port,
      baseUrl: this.state === "running" && this.port ? `http://127.0.0.1:${this.port}` : null,
      error: this.lastError,
      configured: Boolean(config.command?.trim()),
      startedAt: this.startedAt?.toISOString() ?? null,
      restarts: this.restarts,
    };
  }

  /** Recent sidecar output, newest last. Never contains the local key. */
  recentLogs(limit = 100): SidecarLogLine[] {
    return this.logs.slice(-limit);
  }

  /**
   * The key the sidecar and this app share.
   *
   * Minted lazily and kept in memory only: unlike the webhook token there is no
   * external sender to configure, so persisting it would widen the exposure for no
   * benefit — a restarted sidecar gets a fresh key.
   */
  ensureLocalKey(): string {
    if (!this.localKey) this.localKey = generateLocalKey();
    return this.localKey;
  }

  /** Starts the sidecar, or reports why it could not. Idempotent while running. */
  async start(): Promise<SidecarStatus> {
    if (this.child) return this.status();

    const config = this.options.readConfig();
    const command = config.command?.trim();
    if (!command) {
      // Not an error: the app ships without a bundled router by design.
      this.state = "stopped";
      this.lastError = null;
      return this.status();
    }

    const port = await this.choosePort(config);
    if (port === null) return this.status();

    const spawnProcess = this.options.spawnProcess ?? spawn;
    let child: ChildProcess;
    try {
      child = spawnProcess(command, config.args ?? [], {
        cwd: config.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...config.env,
          // Injected last so a stale value in `config.env` cannot shadow it.
          AGENTIC_GATEWAY_PORT: String(port),
          AGENTIC_GATEWAY_HOST: "127.0.0.1",
          AGENTIC_GATEWAY_KEY: this.ensureLocalKey(),
        },
      });
    } catch (error) {
      // Some spawn failures are synchronous (bad cwd, EACCES on the path).
      return this.fail(`could not start ${command}: ${describe(error)}`);
    }

    // Attached before anything can await: `spawn` does not throw for a missing
    // binary, it emits 'error' on a later tick. Without a listener already in place
    // that becomes an uncaughtException and takes the whole app down — a typo in the
    // sidecar command must not be fatal.
    const launch = new Promise<Error | null>((resolve) => {
      const onError = (error: Error) => {
        child.removeListener("spawn", onSpawn);
        resolve(error);
      };
      const onSpawn = () => {
        child.removeListener("error", onError);
        resolve(null);
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });

    const launchError = await launch;
    if (launchError) {
      return this.fail(`could not start ${command}: ${describe(launchError)}`);
    }

    if (!child.pid) {
      return this.fail(`could not start ${command}: no pid was assigned`);
    }

    this.child = child;
    this.port = port;
    this.lastError = null;
    this.startedAt = new Date();
    this.spawnedAtMs = Date.now();
    this.stopping = false;

    this.captureOutput(child);

    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.state = "failed";
      this.lastError = describe(error);
      this.log("stderr", `sidecar error: ${this.lastError}`);
      this.options.onEvent?.(`⚠ Gateway sidecar error: ${this.lastError}`);
    });

    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.port = null;

      if (this.stopping) {
        this.state = "stopped";
        return;
      }

      // A crash inside the startup window is a configuration problem (bad binary,
      // bad flags), which is worth distinguishing from a long-running process that
      // later died.
      const early = Date.now() - this.spawnedAtMs < STARTUP_WINDOW_MS;
      this.state = "failed";
      this.lastError = early
        ? `exited immediately (${describeExit(code, signal)}) — check the command and arguments`
        : `exited unexpectedly (${describeExit(code, signal)})`;
      this.options.onEvent?.(`⚠ Gateway sidecar ${this.lastError}`);
    });

    // `starting` becomes `running` once the process has survived the window. There
    // is no readiness handshake in phase 1 because there is no protocol yet; phase 2
    // promotes this to a real `/health` check.
    this.state = "running";
    this.restarts += 1;
    this.options.onEvent?.(`🚀 Gateway sidecar started on 127.0.0.1:${port} (pid ${child.pid})`);
    return this.status();
  }

  /**
   * Stops the sidecar and everything it spawned.
   *
   * Reuses `terminateProcessTree` rather than `child.kill()`: a router that forks
   * workers would otherwise leave them holding the port, which is exactly the
   * "no orphaned process" acceptance item.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      return;
    }

    this.stopping = true;
    const outcome = await terminateProcessTree(child, {
      graceMs: STOP_GRACE_MS,
      onEscalate: ({ pid, descendants }) =>
        this.options.onEvent?.(
          `⚠ Gateway sidecar ${pid} ignored SIGTERM; escalating to SIGKILL (${descendants.length} descendant(s))`,
        ),
    });

    this.child = null;
    this.port = null;
    this.state = "stopped";
    this.startedAt = null;
    this.stopping = false;
    if (outcome !== "already-exited") this.options.onEvent?.(`🛑 Gateway sidecar stopped (${outcome})`);
  }

  /** Stops then starts, so a config change takes effect. */
  async restart(): Promise<SidecarStatus> {
    await this.stop();
    return this.start();
  }

  /** Resolves the port to use, or null after recording a conflict. */
  private async choosePort(config: SidecarConfig): Promise<number | null> {
    const probe = this.options.probePort ?? isPortFree;

    if (config.port && config.port > 0) {
      if (await probe(config.port)) return config.port;
      // Deliberately not silently falling back to a random port: the user picked
      // this one, presumably because something else points at it.
      this.fail(`port ${config.port} is already in use. Free it or choose another port.`);
      return null;
    }

    const ephemeral = await reserveEphemeralPort();
    if (ephemeral === null) {
      this.fail("could not reserve a free loopback port");
      return null;
    }
    return ephemeral;
  }

  private fail(message: string): SidecarStatus {
    this.state = "failed";
    this.lastError = message;
    this.port = null;
    this.options.onEvent?.(`⚠ Gateway sidecar: ${message}`);
    return this.status();
  }

  private captureOutput(child: ChildProcess): void {
    child.stdout?.on("data", (chunk: Buffer) => this.log("stdout", chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => this.log("stderr", chunk.toString()));
  }

  private log(stream: "stdout" | "stderr", raw: string): void {
    for (const line of raw.split(/\r?\n/)) {
      const message = line.trim();
      if (!message) continue;
      this.logs.push({ stream, message: this.redact(message), timestamp: new Date().toISOString() });
    }
    // Bounded rather than persisted: a chatty router should not grow memory without
    // limit, and `terminal_logs` retention already exists for run output.
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
  }

  /**
   * Removes the local key from a log line.
   *
   * The plan requires that logs never contain the key, and a sidecar echoing its own
   * configuration on startup is the most likely way it would leak.
   */
  private redact(message: string): string {
    if (!this.localKey) return message;
    return message.split(this.localKey).join("***");
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How long `/health` gets to answer before it counts as unhealthy. */
const HEALTH_TIMEOUT_MS = 2_000;

export type SidecarHealth = {
  reachable: boolean;
  statusCode?: number;
  detail?: string;
};

/**
 * Asks the sidecar's `/health` whether it is serving.
 *
 * Phase 1 promotes a spawned process to `running` as soon as it survives startup,
 * which proves the lifecycle but not that anything is listening. This is the phase-2
 * readiness signal, kept separate and injectable so Diagnostics can report
 * "process up but not answering" — the state that actually needs a different fix
 * from "process not running".
 */
export async function probeSidecarHealth(baseUrl: string, localKey: string): Promise<SidecarHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
      method: "GET",
      signal: controller.signal,
      // Sent even to /health: the plan allows exempting it, but a router that
      // accepts an unauthenticated probe is one config slip from accepting more.
      headers: { authorization: `Bearer ${localKey}` },
    });
    return { reachable: true, statusCode: response.status };
  } catch (error) {
    return { reachable: false, detail: describe(error) };
  } finally {
    clearTimeout(timer);
  }
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal ${signal}`;
  return `exit code ${code ?? "unknown"}`;
}
