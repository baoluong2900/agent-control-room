import { spawn } from "node:child_process";
import type { GitDiffSummary, GitFileChange, GitFileChangeKind } from "@contracts";

type GitResult = {
  ok: boolean;
  output: string;
};

export async function readGitDiff(cwd: string): Promise<GitDiffSummary> {
  const insideRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideRepo.ok || insideRepo.output.trim() !== "true") {
    return {
      cwd,
      branch: "—",
      status: "Not a git repository",
      diffStat: "No git data available",
      files: [],
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      isRepository: false,
    };
  }

  const [branch, porcelain, unstagedStat, stagedStat] = await Promise.all([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["status", "--porcelain"]),
    git(cwd, ["diff", "--stat"]),
    git(cwd, ["diff", "--cached", "--stat"]),
  ]);

  const files = parsePorcelain(porcelain.output);
  const stagedCount = files.filter((file) => file.staged).length;
  const untrackedCount = files.filter((file) => file.kind === "untracked").length;
  const unstagedCount = files.filter((file) => !file.staged && file.kind !== "untracked").length;

  return {
    cwd,
    branch: branch.output.trim() || "detached HEAD",
    status: porcelain.output.trim() || "Clean working tree",
    diffStat: buildDiffStat(unstagedStat.output, stagedStat.output),
    files,
    stagedCount,
    unstagedCount,
    untrackedCount,
    isRepository: true,
  };
}

function buildDiffStat(unstaged: string, staged: string): string {
  const sections: string[] = [];
  if (staged.trim()) sections.push(`Staged:\n${staged.trim()}`);
  if (unstaged.trim()) sections.push(`Unstaged:\n${unstaged.trim()}`);
  return sections.join("\n\n") || "No tracked file changes";
}

/**
 * Parses `git status --porcelain` v1 output. Each line is `XY<space>path`, where
 * X is the index state and Y the work-tree state. Renames arrive as `R  old -> new`.
 */
function parsePorcelain(output: string): GitFileChange[] {
  const changes: GitFileChange[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.length < 4) continue;
    const code = rawLine.slice(0, 2);
    const indexState = code[0];
    const treeState = code[1];
    const rest = rawLine.slice(3);
    const path = rest.includes(" -> ") ? rest.split(" -> ")[1].trim() : rest.trim();
    if (!path) continue;

    if (code === "??") {
      changes.push({ path: unquote(path), kind: "untracked", staged: false, code });
      continue;
    }

    if (indexState === "U" || treeState === "U" || code === "AA" || code === "DD") {
      changes.push({ path: unquote(path), kind: "conflicted", staged: false, code });
      continue;
    }

    // A file can be both staged and dirty; surface each side so counts stay honest.
    if (indexState !== " " && indexState !== "?") {
      changes.push({ path: unquote(path), kind: kindFromCode(indexState), staged: true, code });
    }
    if (treeState !== " " && treeState !== "?") {
      changes.push({ path: unquote(path), kind: kindFromCode(treeState), staged: false, code });
    }
  }

  return changes;
}

function kindFromCode(state: string): GitFileChangeKind {
  switch (state) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    default:
      return "modified";
  }
}

/** Git quotes paths containing special characters; strip the wrapping quotes. */
function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 5_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, output: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, output: code === 0 ? stdout : stderr || stdout });
    });
  });
}
