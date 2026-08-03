import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

/**
 * When macOS launches an .app from Finder or the Dock it does not run any shell
 * startup file, so the process inherits a minimal PATH (`/usr/bin:/bin:...`).
 * Every agent CLI installed under `~/.local/bin` or `/opt/homebrew/bin`
 * disappears, and `resolveExecutable()` reports the CLI as not installed even
 * though it runs fine from a terminal.
 *
 * Prepending the well-known install roots is deterministic and costs nothing,
 * unlike spawning a login shell to read its PATH.
 */
function candidateDirs(): string[] {
  const home = homedir();

  if (process.platform === "win32") {
    const dirs = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"),
      process.env.APPDATA && join(process.env.APPDATA, "npm"),
      join(home, ".cargo", "bin"),
      join(home, ".bun", "bin"),
      join(home, ".local", "bin"),
    ];
    return dirs.filter((dir): dir is string => Boolean(dir));
  }

  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    join(home, ".cargo", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, "go", "bin"),
    join(home, ".grok", "bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

/**
 * Returns the PATH the app should use when resolving and spawning agent CLIs:
 * existing entries first-wins, with the well-known install roots appended.
 */
export function buildAgentPath(currentPath = process.env.PATH ?? ""): string {
  const seen = new Set<string>();
  const entries: string[] = [];

  const push = (dir: string) => {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    entries.push(trimmed);
  };

  for (const dir of currentPath.split(delimiter)) push(dir);
  for (const dir of candidateDirs()) {
    if (existsSync(dir)) push(dir);
  }

  return entries.join(delimiter);
}

/**
 * Applies {@link buildAgentPath} to `process.env.PATH` once at startup so both
 * CLI probing and `spawn()` see the same resolved PATH.
 */
export function ensureAgentPath(): string {
  const resolved = buildAgentPath();
  process.env.PATH = resolved;
  return resolved;
}
