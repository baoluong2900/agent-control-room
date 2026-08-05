import { spawn } from "node:child_process";

/**
 * Issue polling via the user's own `gh` CLI.
 *
 * `issue-created` was the last gated trigger, and the reason it stayed gated was
 * stated as "needs a tracker integration". That framing assumed the app would have
 * to obtain and store a GitHub credential itself — an OAuth app, a PAT prompt, a
 * refresh story. It does not: `gh` is already installed and authenticated for most
 * people who would want this trigger, and shelling out to it reuses that auth
 * without the app ever seeing, storing, or refreshing a token.
 *
 * The trade-off is honest and worth stating: this only works when `gh` is present
 * and logged in, and only for GitHub. Jira and friends still need real integrations.
 * A trigger that works for the common case beats one that is permanently disabled.
 */

/** `gh` is a network call; a slow or hung invocation must not wedge the tick. */
const GH_TIMEOUT_MS = 10_000;

/** Upper bound per poll, so a repo with a burst of issues cannot flood the board. */
const MAX_ISSUES_PER_POLL = 20;

export type IssueSummary = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
};

export type GhResult = { ok: boolean; output: string };

/** Runs one `gh` command and never rejects, mirroring `git()` in git-service. */
export function gh(cwd: string, args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("gh", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      // `gh` not installed shows up here on some platforms rather than as an
      // 'error' event, and must be a quiet no-op rather than a crash.
      resolve({ ok: false, output: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), GH_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: code === 0 ? stdout : stderr || stdout });
    });
  });
}

/**
 * Open issues in the repo at `cwd`, newest first.
 *
 * Returns null — not an empty list — when `gh` is missing, unauthenticated, or the
 * folder is not a GitHub repo. The caller must not treat "cannot tell" as "there
 * are no issues", or a logged-out `gh` would silently look like a quiet repo.
 */
export async function listOpenIssues(
  cwd: string,
  runGh: (cwd: string, args: string[]) => Promise<GhResult> = gh,
): Promise<IssueSummary[] | null> {
  const result = await runGh(cwd, [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    String(MAX_ISSUES_PER_POLL),
    "--json",
    "number,title,url,createdAt",
  ]);
  if (!result.ok) return null;

  try {
    const parsed = JSON.parse(result.output.trim() || "[]");
    if (!Array.isArray(parsed)) return null;

    return parsed
      .filter(
        (entry): entry is IssueSummary =>
          entry &&
          typeof entry.number === "number" &&
          typeof entry.title === "string" &&
          typeof entry.url === "string" &&
          typeof entry.createdAt === "string",
      )
      .slice(0, MAX_ISSUES_PER_POLL);
  } catch {
    // `gh` printing something non-JSON (an auth prompt, an update notice) is a
    // "cannot tell", not "no issues".
    return null;
  }
}

/**
 * Reads an `issue-created` trigger's `detail` field.
 *
 * Free text for backward compatibility, so this accepts what people plausibly
 * typed. A label filter is the only supported narrowing, since it is the one that
 * maps cleanly onto what the poll can see.
 */
export function parseIssueTrigger(detail?: string | null): { label?: string } {
  const text = detail?.trim();
  if (!text) return {};

  if (text.includes("=")) {
    for (const part of text.split(/[,\n]/)) {
      const [rawKey, ...rest] = part.split("=");
      const key = rawKey?.trim().toLowerCase();
      const value = rest.join("=").trim();
      if ((key === "label" || key === "labels") && value) return { label: value };
    }
    return {};
  }

  return { label: text };
}
