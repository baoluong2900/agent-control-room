import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  GitCommitSummary,
  GitDiffSummary,
  GitFileChange,
  GitFileChangeKind,
  GitFileDiff,
  GitOperationResult,
} from "@contracts";

type GitResult = {
  ok: boolean;
  output: string;
};

export async function readGitDiff(cwd: string): Promise<GitDiffSummary> {
  const insideRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideRepo.ok || insideRepo.output.trim() !== "true") {
    return emptySummary(cwd, "Not a git repository", false);
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

export async function readGitFileDiff(cwd: string, filePath: string, staged = false): Promise<GitFileDiff> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) {
    return { cwd, path: filePath, staged, patch: "", isRepository: false, error: repository.output };
  }

  const safePath = sanitizeRepoPath(filePath);
  if (!safePath) {
    return { cwd, path: filePath, staged, patch: "", isRepository: true, error: "Invalid repository path" };
  }

  const args = staged ? ["diff", "--cached", "--", safePath] : ["diff", "--", safePath];
  const diff = await git(cwd, args);
  if (diff.output.trim()) {
    return { cwd, path: safePath, staged, patch: diff.output, isRepository: true };
  }

  if (!staged && (await isUntracked(cwd, safePath))) {
    return { cwd, path: safePath, staged, patch: await buildUntrackedPatch(cwd, safePath), isRepository: true };
  }

  return {
    cwd,
    path: safePath,
    staged,
    patch: diff.ok ? "No patch for this file." : diff.output || "Unable to read file diff.",
    isRepository: true,
    error: diff.ok ? undefined : diff.output,
  };
}

export async function readGitLog(cwd: string, limit = 20): Promise<GitCommitSummary[]> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return [];

  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const result = await git(cwd, ["log", `-${safeLimit}`, "--pretty=format:%H%x1f%h%x1f%an%x1f%ai%x1f%s"]);
  if (!result.ok || !result.output.trim()) return [];

  return result.output
    .split(/\r?\n/)
    .map((line) => line.split("\x1f"))
    .filter((parts) => parts.length >= 5)
    .map(([hash, shortHash, author, date, ...subject]) => ({
      hash,
      shortHash,
      author,
      date,
      subject: subject.join("\x1f"),
    }));
}

export async function stageGitFile(cwd: string, filePath: string): Promise<GitOperationResult> {
  const safePath = sanitizeRepoPath(filePath);
  if (!safePath) return operationResult(false, "Invalid repository path", cwd);

  const result = await git(cwd, ["add", "--", safePath]);
  return operationResult(result.ok, result.ok ? `Staged ${safePath}` : result.output || `Failed to stage ${safePath}`, cwd);
}

export async function unstageGitFile(cwd: string, filePath: string): Promise<GitOperationResult> {
  const safePath = sanitizeRepoPath(filePath);
  if (!safePath) return operationResult(false, "Invalid repository path", cwd);

  const result = await git(cwd, ["restore", "--staged", "--", safePath]);
  if (result.ok) return operationResult(true, `Unstaged ${safePath}`, cwd);

  const fallback = await git(cwd, ["reset", "HEAD", "--", safePath]);
  return operationResult(fallback.ok, fallback.ok ? `Unstaged ${safePath}` : fallback.output || result.output, cwd);
}

export async function commitGitChanges(cwd: string, message: string): Promise<GitOperationResult> {
  const normalizedMessage = message.trim();
  if (!normalizedMessage) return operationResult(false, "Commit message is required", cwd);

  const result = await git(cwd, ["commit", "-m", normalizedMessage]);
  if (!result.ok) return operationResult(false, result.output || "Commit failed", cwd);

  const [commit] = await readGitLog(cwd, 1);
  return operationResult(true, result.output.trim() || `Committed ${commit?.shortHash ?? "changes"}`, cwd, commit);
}

function emptySummary(cwd: string, status: string, isRepository: boolean): GitDiffSummary {
  return {
    cwd,
    branch: "—",
    status,
    diffStat: isRepository ? "No tracked file changes" : "No git data available",
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    isRepository,
  };
}

async function operationResult(
  ok: boolean,
  message: string,
  cwd: string,
  commit?: GitCommitSummary,
): Promise<GitOperationResult> {
  return {
    ok,
    message,
    summary: await readGitDiff(cwd),
    commit,
  };
}

async function ensureRepository(cwd: string): Promise<GitResult> {
  const insideRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideRepo.ok || insideRepo.output.trim() !== "true") {
    return { ok: false, output: "Not a git repository" };
  }
  return { ok: true, output: "" };
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
    const pathValue = rest.includes(" -> ") ? rest.split(" -> ")[1].trim() : rest.trim();
    if (!pathValue) continue;

    if (code === "??") {
      changes.push({ path: unquote(pathValue), kind: "untracked", staged: false, code });
      continue;
    }

    if (indexState === "U" || treeState === "U" || code === "AA" || code === "DD") {
      changes.push({ path: unquote(pathValue), kind: "conflicted", staged: false, code });
      continue;
    }

    // A file can be both staged and dirty; surface each side so counts stay honest.
    if (indexState !== " " && indexState !== "?") {
      changes.push({ path: unquote(pathValue), kind: kindFromCode(indexState), staged: true, code });
    }
    if (treeState !== " " && treeState !== "?") {
      changes.push({ path: unquote(pathValue), kind: kindFromCode(treeState), staged: false, code });
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

function sanitizeRepoPath(filePath: string): string | null {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.isAbsolute(normalized)) return null;
  return normalized;
}

async function isUntracked(cwd: string, filePath: string): Promise<boolean> {
  const result = await git(cwd, ["status", "--porcelain", "--", filePath]);
  return result.output
    .split(/\r?\n/)
    .some((line) => line.startsWith("?? ") && line.slice(3).trim() === filePath);
}

async function buildUntrackedPatch(cwd: string, filePath: string): Promise<string> {
  const absolutePath = path.join(cwd, filePath);
  const content = await fs.readFile(absolutePath, "utf8").catch(() => "");
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();

  const additions = lines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    additions,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Git quotes paths containing special characters; strip the wrapping quotes. */
function unquote(pathValue: string): string {
  return pathValue.startsWith('"') && pathValue.endsWith('"') ? pathValue.slice(1, -1) : pathValue;
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
