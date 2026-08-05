import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

/**
 * Kill escalation for spawned agent/step processes.
 *
 * `child.kill("SIGTERM")` is a request, not a guarantee. A CLI that installs its
 * own SIGTERM handler (or is wedged waiting on a socket) keeps running, and the
 * caller that deleted its bookkeeping has no handle left to try again with — the
 * app leaves an orphan and the user has no way to see or stop it.
 *
 * Two things are therefore needed and neither is optional:
 *
 * 1. **Escalation.** After a grace period, SIGKILL. It cannot be trapped.
 * 2. **The tree, not the process.** Shell steps run as `sh -lc "<command>"`, so
 *    the pid we hold is the shell's. Killing only the shell orphans whatever it
 *    spawned, which is usually the process actually doing the work.
 */

export interface ProcessTreeEntry {
  pid: number;
  ppid: number;
}

export type TerminateOutcome =
  /** No live pid to signal: the process had already exited. */
  | "already-exited"
  /** SIGTERM was honoured within the grace period. */
  | "exited-on-term"
  /** SIGTERM was ignored; SIGKILL was needed. */
  | "escalated"
  /** Still alive after SIGKILL — only reachable for unkillable/zombie states. */
  | "unkillable";

export interface TerminateOptions {
  /** How long SIGTERM gets before SIGKILL. */
  graceMs?: number;
  /** Injection seam for tests: the machine's pid/ppid table. */
  listProcesses?: () => Promise<ProcessTreeEntry[]>;
  /** Injection seam for tests: a single kill syscall. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Called when SIGTERM was not enough, before SIGKILL goes out. */
  onEscalate?: (info: { pid: number; descendants: number[]; graceMs: number }) => void;
}

const DEFAULT_GRACE_MS = 5_000;
/** Time allowed for the OS to reap the process group after SIGKILL. */
const REAP_WINDOW_MS = 250;

/**
 * Reads the machine's pid/ppid table. `ps` is used rather than `pgrep` because
 * one call returns the whole table, so descendants at any depth can be resolved
 * without a walk that re-spawns a probe per level.
 */
export async function listProcessTable(): Promise<ProcessTreeEntry[]> {
  if (process.platform === "win32") return [];

  const output = await runCapture("ps", ["-A", "-o", "pid=,ppid="]);
  if (!output) return [];

  const entries: ProcessTreeEntry[] = [];
  for (const line of output.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidText ?? "", 10);
    const ppid = Number.parseInt(ppidText ?? "", 10);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) entries.push({ pid, ppid });
  }
  return entries;
}

/**
 * Every pid below `rootPid`, deepest included, excluding the root itself.
 *
 * The table is a snapshot, so this must be called *before* signalling: once the
 * root dies its children are re-parented to pid 1 and the relationship that
 * identifies them as ours is gone.
 */
export function collectDescendants(rootPid: number, table: ProcessTreeEntry[]): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const { pid, ppid } of table) {
    const siblings = childrenByParent.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenByParent.set(ppid, [pid]);
  }

  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of childrenByParent.get(current) ?? []) {
      // Guards against a cycle in a malformed table rather than a real one:
      // a genuine process tree cannot loop, but a torn `ps` snapshot can.
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

/**
 * Stops `child` and everything it spawned, escalating SIGTERM to SIGKILL when
 * the grace period expires. Resolves once the child has exited or SIGKILL has
 * been delivered; never rejects, because every caller is on a cleanup path where
 * throwing would strand the run in a worse state than a failed kill.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  options: TerminateOptions = {},
): Promise<TerminateOutcome> {
  const { pid } = child;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const kill = options.kill ?? defaultKill;
  const listProcesses = options.listProcesses ?? listProcessTable;

  // `exitCode`/`signalCode` are both null only while the process is live.
  if (!pid || child.exitCode !== null || child.signalCode !== null) return "already-exited";

  // Snapshot the tree while the parent link still exists (see collectDescendants).
  const descendants = await safeDescendants(pid, listProcesses);

  const exited = waitForExit(child);
  kill(pid, "SIGTERM");

  if (await raceExit(exited, graceMs)) {
    // The shell exited, but a grandchild it spawned can outlive it. Sweeping the
    // snapshot is what makes "stopped" mean no leftover work is still running.
    reapDescendants(descendants, kill);
    return "exited-on-term";
  }

  options.onEscalate?.({ pid, descendants, graceMs });

  if (process.platform === "win32") {
    // Windows has no SIGKILL; taskkill /T is the only way to take the tree.
    await runCapture("taskkill", ["/F", "/T", "/PID", String(pid)]);
  } else {
    kill(pid, "SIGKILL");
    reapDescendants(descendants, kill);
  }

  return (await raceExit(exited, REAP_WINDOW_MS)) ? "escalated" : "unkillable";
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH simply means it exited between the snapshot and the signal, and
    // EPERM means it is not ours to kill. Neither is actionable here.
  }
}

function reapDescendants(pids: number[], kill: (pid: number, signal: NodeJS.Signals) => void): void {
  // Deepest first: killing a parent before its children is what creates the
  // orphans this function exists to prevent.
  for (const pid of [...pids].reverse()) kill(pid, "SIGKILL");
}

async function safeDescendants(
  pid: number,
  listProcesses: () => Promise<ProcessTreeEntry[]>,
): Promise<number[]> {
  try {
    return collectDescendants(pid, await listProcesses());
  } catch {
    // No process table (unusual platform, sandbox, missing `ps`) still leaves
    // direct escalation working, which is the more important half.
    return [];
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}

/** True when the process exited within `ms`. */
async function raceExit(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    // A pending kill timer must never be the reason the app cannot quit.
    timer.unref?.();
  });
  try {
    return await Promise.race([exited.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs a probe command and returns stdout, or null when it cannot be run. */
function runCapture(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }

    let stdout = "";
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => settle(null));
    child.on("close", () => settle(stdout));

    // A hung probe must not hold up the kill path it is meant to inform.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(null);
    }, 2_000);
    timer.unref?.();
    child.on("close", () => clearTimeout(timer));
  });
}
