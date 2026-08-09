import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  GitBranchSummary,
  GitCommitSummary,
  GitDiffSummary,
  GitFileChange,
  GitFileChangeKind,
  GitFileDiff,
  GitOperationResult,
  GitStashDetail,
  GitStashEntry,
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

/**
 * Local branches, current one first.
 *
 * `for-each-ref` rather than `branch --list`: the latter formats for humans (a
 * `*` prefix, colour codes, an aligned column) and would have to be un-formatted
 * again, while for-each-ref emits exactly the fields asked for, separated by a
 * byte that cannot occur in a ref name.
 */
export async function readGitBranches(cwd: string): Promise<GitBranchSummary[]> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return [];

  const result = await git(cwd, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(contents:subject)",
    "refs/heads",
  ]);
  if (!result.ok || !result.output.trim()) return [];

  const branches = result.output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [name, head, upstream, ...subject] = line.split("\x1f");
      return {
        name: name.trim(),
        current: head.trim() === "*",
        upstream: upstream?.trim() || undefined,
        subject: subject.join("\x1f").trim() || undefined,
      };
    })
    .filter((branch) => branch.name);

  // Current branch first: it is the one the user reasons about, and sorting by
  // commit date alone can bury it under branches touched more recently.
  return [...branches.filter((branch) => branch.current), ...branches.filter((branch) => !branch.current)];
}

/**
 * Checks out an existing local branch, or creates one from HEAD.
 *
 * Refuses while the work tree is dirty. Git itself would carry the changes across
 * when they do not conflict and fail with a wall of text when they do; refusing
 * outright is the predictable behaviour, and the alternative silently spreads
 * half-finished work onto another branch.
 */
export async function checkoutGitBranch(cwd: string, name: string, create = false): Promise<GitOperationResult> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return operationResult(false, repository.output, cwd);

  const safeName = sanitizeBranchName(name);
  if (!safeName) return operationResult(false, "Invalid branch name", cwd);

  const existing = await readGitBranches(cwd);
  if (create && existing.some((branch) => branch.name === safeName)) {
    return operationResult(false, `Branch ${safeName} already exists`, cwd);
  }
  if (!create && !existing.some((branch) => branch.name === safeName)) {
    return operationResult(false, `Branch ${safeName} does not exist locally`, cwd);
  }
  if (existing.some((branch) => branch.current && branch.name === safeName)) {
    return operationResult(true, `Already on ${safeName}`, cwd);
  }

  const dirty = await hasUncommittedChanges(cwd);
  if (dirty) {
    return operationResult(
      false,
      "Uncommitted changes would be carried onto the other branch. Commit or stash them first.",
      cwd,
    );
  }

  const args = create ? ["switch", "--create", safeName] : ["switch", safeName];
  const result = await git(cwd, args);
  return operationResult(
    result.ok,
    result.ok ? (create ? `Created and switched to ${safeName}` : `Switched to ${safeName}`) : result.output || "Checkout failed",
    cwd,
  );
}

export async function readGitStashes(cwd: string): Promise<GitStashEntry[]> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return [];

  const result = await git(cwd, ["stash", "list", "--format=%gd%x1f%gs%x1f%ai"]);
  if (!result.ok || !result.output.trim()) return [];

  return result.output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const [ref, subject, date] = line.split("\x1f");
      // `%gs` reads `WIP on main: 1a2b3c subject` or `On main: message`; the
      // branch is worth its own field because it is how a user decides whether a
      // stash is even relevant to where they are now.
      const branchMatch = /^(?:WIP on|On) ([^:]+):/.exec(subject ?? "");
      return {
        ref: ref?.trim() || `stash@{${index}}`,
        index,
        message: (subject ?? "").trim(),
        branch: branchMatch?.[1]?.trim(),
        date: (date ?? "").trim(),
      };
    });
}

/** The patch a stash would restore, so the UI can show it before applying. */
export async function readGitStashDetail(cwd: string, ref: string): Promise<GitStashDetail> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return { ref, patch: "", files: [], error: repository.output };

  const resolved = await resolveStashRef(cwd, ref);
  if (!resolved) return { ref, patch: "", files: [], error: "Unknown stash entry" };

  const [patch, files] = await Promise.all([
    // Include untracked entries too: a stash created with `--include-untracked`
    // must preview every file it would restore, not only its tracked half.
    git(cwd, ["stash", "show", "--include-untracked", "--patch", resolved]),
    git(cwd, ["stash", "show", "--include-untracked", "--name-only", resolved]),
  ]);

  return {
    ref: resolved,
    patch: patch.ok ? patch.output : "",
    files: files.ok ? files.output.split(/\r?\n/).filter((line) => line.trim()) : [],
    error: patch.ok ? undefined : patch.output || "Unable to read stash",
  };
}

/** Stashes tracked changes, and untracked files when asked. */
export async function createGitStash(
  cwd: string,
  message?: string,
  includeUntracked = false,
): Promise<GitOperationResult> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return operationResult(false, repository.output, cwd);

  // `git stash push` on a clean tree is a no-op that still exits 0, which would
  // report success for a stash that does not exist.
  const summary = await readGitDiff(cwd);
  const stashable = includeUntracked
    ? summary.files.length
    : summary.files.filter((file) => file.kind !== "untracked").length;
  if (!stashable) {
    return operationResult(
      false,
      includeUntracked ? "Nothing to stash" : "Nothing to stash (untracked files need Include untracked)",
      cwd,
    );
  }

  const args = ["stash", "push"];
  if (includeUntracked) args.push("--include-untracked");
  const trimmed = message?.trim();
  if (trimmed) args.push("--message", trimmed);

  const result = await git(cwd, args);
  return operationResult(result.ok, result.ok ? result.output.trim() || "Changes stashed" : result.output || "Stash failed", cwd);
}

/**
 * Restores a stash. `keep` decides between `apply` (entry stays) and `pop`
 * (entry is consumed).
 *
 * Refuses on a dirty tree: restoring over local edits either conflicts, or
 * silently mixes two sets of changes into one indistinguishable diff.
 */
export async function applyGitStash(cwd: string, ref: string, keep = true): Promise<GitOperationResult> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return operationResult(false, repository.output, cwd);

  const resolved = await resolveStashRef(cwd, ref);
  if (!resolved) return operationResult(false, "Unknown stash entry", cwd);

  // A stash can contain untracked files too. Restoring it over an untracked file
  // with the same path either fails late or risks mixing two unrelated work sets,
  // so stash restore requires a *fully* clean tree, unlike branch switching where
  // Git safely carries untracked files across.
  const current = await readGitDiff(cwd);
  if (current.files.length > 0) {
    return operationResult(false, "Restore onto a clean tree: commit or stash the current changes first.", cwd);
  }

  const result = await git(cwd, ["stash", keep ? "apply" : "pop", resolved]);
  return operationResult(
    result.ok,
    result.ok
      ? `${keep ? "Applied" : "Popped"} ${resolved}`
      : result.output || `Unable to ${keep ? "apply" : "pop"} ${resolved}`,
    cwd,
  );
}

/**
 * Drops one stash entry. Irreversible in practice, so the caller must pass the
 * message it showed the user; a mismatch means the stack shifted underneath and
 * the drop is refused rather than deleting a different entry.
 */
export async function dropGitStash(cwd: string, ref: string, expectedMessage?: string): Promise<GitOperationResult> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return operationResult(false, repository.output, cwd);

  const entries = await readGitStashes(cwd);
  const entry = entries.find((candidate) => candidate.ref === ref);
  if (!entry) return operationResult(false, "Unknown stash entry", cwd);
  if (expectedMessage !== undefined && entry.message !== expectedMessage) {
    return operationResult(
      false,
      `${ref} now holds "${entry.message}". Refresh before dropping — the stash stack shifted.`,
      cwd,
    );
  }

  const result = await git(cwd, ["stash", "drop", ref]);
  return operationResult(result.ok, result.ok ? `Dropped ${ref}` : result.output || `Unable to drop ${ref}`, cwd);
}

/**
 * True when the work tree or index carries changes that a checkout or stash
 * restore could disturb. Untracked files are excluded: git carries them across a
 * branch switch untouched, so blocking on them would refuse safe operations.
 */
async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const summary = await readGitDiff(cwd);
  return summary.files.some((file) => file.kind !== "untracked");
}

/** Confirms a `stash@{n}` ref exists right now, rather than trusting the caller. */
async function resolveStashRef(cwd: string, ref: string): Promise<string | null> {
  const trimmed = ref.trim();
  if (!/^stash@\{\d+\}$/.test(trimmed)) return null;
  const entries = await readGitStashes(cwd);
  return entries.some((entry) => entry.ref === trimmed) ? trimmed : null;
}

/**
 * Rejects anything git would reject, plus leading dashes — a name like `-f`
 * would otherwise be read by git as a flag rather than a branch.
 */
function sanitizeBranchName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (trimmed.startsWith("-") || trimmed.startsWith("/") || trimmed.endsWith("/")) return null;
  if (trimmed.endsWith(".") || trimmed.endsWith(".lock")) return null;
  if (trimmed.includes("..") || trimmed.includes("@{")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
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

/**
 * Runs one git command and never rejects.
 *
 * Exported so other main-process services (the ref-change trigger runner) reuse
 * this exact invocation — same 5s timeout, same never-throw contract — rather than
 * growing a second, subtly different git helper.
 */
export function git(cwd: string, args: string[]): Promise<GitResult> {
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
