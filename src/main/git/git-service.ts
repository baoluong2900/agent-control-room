import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type {
  GitBlameLine,
  GitBlameResult,
  GitBranchSummary,
  GitCommitSummary,
  GitDiffSummary,
  GitFileChange,
  GitFileChangeKind,
  GitFileDiff,
  GitOperationResult,
  GitPushPlan,
  GitRemoteSummary,
  GitStashDetail,
  GitStashEntry,
  GitTrackingStatus,
} from "@contracts";

/**
 * Budget for operations that talk to a remote.
 *
 * The local-plumbing default (5s) is wrong for these: a cold TLS handshake plus a
 * large pack legitimately exceeds it, and killing a `push` mid-transfer leaves the
 * user unable to tell whether the objects landed. 60s is long enough for real work
 * and short enough that a wedged connection still ends in a reported failure
 * rather than a spinner with no end.
 */
const NETWORK_TIMEOUT_MS = 60_000;

/**
 * Branches a push refuses to touch unless the caller opts in explicitly.
 *
 * Not a security control — it is a typo guard. Publishing to a shared trunk from a
 * side panel is the one push people regret, so it takes a deliberate second action.
 */
const PROTECTED_BRANCHES = new Set(["main", "master"]);

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

  const result = await git(cwd, ["stash", "list", "--format=%gd%x1f%H%x1f%gs%x1f%ai"]);
  if (!result.ok || !result.output.trim()) return [];

  return result.output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const [ref, oid, subject, date] = line.split("\x1f");
      // `%gs` reads `WIP on main: 1a2b3c subject` or `On main: message`; the
      // branch is worth its own field because it is how a user decides whether a
      // stash is even relevant to where they are now.
      const branchMatch = /^(?:WIP on|On) ([^:]+):/.exec(subject ?? "");
      return {
        ref: ref?.trim() || `stash@{${index}}`,
        oid: oid?.trim() ?? "",
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
  if (!repository.ok) return { ref, oid: "", patch: "", files: [], error: repository.output };

  const resolved = await resolveStashEntry(cwd, ref);
  if (!resolved) return { ref, oid: "", patch: "", files: [], error: "Unknown stash entry" };

  const [patch, files] = await Promise.all([
    // Include untracked entries too: a stash created with `--include-untracked`
    // must preview every file it would restore, not only its tracked half.
    git(cwd, ["stash", "show", "--include-untracked", "--patch", resolved.oid]),
    git(cwd, ["stash", "show", "--include-untracked", "--name-only", resolved.oid]),
  ]);

  return {
    ref: resolved.ref,
    oid: resolved.oid,
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
export async function applyGitStash(
  cwd: string,
  ref: string,
  expectedOid: string,
  keep = true,
): Promise<GitOperationResult> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return operationResult(false, repository.output, cwd);

  const resolved = await resolveExpectedStash(cwd, ref, expectedOid);
  if (!resolved) return operationResult(false, "Stash entry changed. Refresh before restoring it.", cwd);

  // A stash can contain untracked files too. Restoring it over an untracked file
  // with the same path either fails late or risks mixing two unrelated work sets,
  // so stash restore requires a *fully* clean tree, unlike branch switching where
  // Git safely carries untracked files across.
  const current = await readGitDiff(cwd);
  if (current.files.length > 0) {
    return operationResult(false, "Restore onto a clean tree: commit or stash the current changes first.", cwd);
  }

  // Always apply by immutable object id. `git stash pop stash@{n}` can consume a
  // different entry if the stack shifts between render and click. For pop, drop
  // only after the apply succeeds, and re-find that same OID at its current ref.
  const result = await git(cwd, ["stash", "apply", resolved.oid]);
  if (!result.ok) return operationResult(false, result.output || `Unable to apply ${resolved.ref}`, cwd);

  if (!keep) {
    const current = (await readGitStashes(cwd)).find((entry) => entry.oid === resolved.oid);
    if (!current) {
      return operationResult(true, `Applied ${resolved.ref}; its stack entry was already removed.`, cwd);
    }
    const dropped = await git(cwd, ["stash", "drop", current.ref]);
    if (!dropped.ok) {
      return operationResult(true, `Applied ${resolved.ref}, but could not remove its stash entry: ${dropped.output}`, cwd);
    }
  }
  return operationResult(
    true,
    `${keep ? "Applied" : "Popped"} ${resolved.ref}`,
    cwd,
  );
}

/**
 * Drops one stash entry. Irreversible in practice, so the caller must pass its
 * immutable commit OID; a ref/OID mismatch means the stack shifted and is refused.
 */
export async function dropGitStash(cwd: string, ref: string, expectedOid: string): Promise<GitOperationResult> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return operationResult(false, repository.output, cwd);

  const entry = await resolveExpectedStash(cwd, ref, expectedOid);
  if (!entry) return operationResult(false, "Stash entry changed. Refresh before dropping it.", cwd);

  const result = await git(cwd, ["stash", "drop", ref]);
  return operationResult(result.ok, result.ok ? `Dropped ${ref}` : result.output || `Unable to drop ${ref}`, cwd);
}

/**
 * Configured remotes with their fetch URLs.
 *
 * `remote -v` rather than `remote`: the URL is what tells a user *where* an
 * outbound action would send their code, and "origin" alone does not.
 */
export async function readGitRemotes(cwd: string): Promise<GitRemoteSummary[]> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return [];

  const result = await git(cwd, ["remote", "-v"]);
  if (!result.ok || !result.output.trim()) return [];

  const remotes = new Map<string, GitRemoteSummary>();
  for (const line of result.output.split(/\r?\n/)) {
    // `name<TAB>url (fetch|push)` — keep the fetch URL; a triangular workflow can
    // set a different push URL, and showing that as "the remote" would mislead.
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url, kind] = match;
    if (!remotes.has(name)) remotes.set(name, { name });
    if (kind === "fetch") remotes.get(name)!.fetchUrl = url;
  }
  return [...remotes.values()];
}

/**
 * How far the checked-out branch has diverged from its upstream.
 *
 * `rev-list --left-right --count` in one call rather than two counting calls: it
 * cannot report an ahead/behind pair drawn from two different moments.
 *
 * Reads the *local* view only — `behind` stays at 0 until a fetch updates the
 * remote-tracking ref, which is exactly why the UI offers fetch first instead of
 * claiming a branch is up to date.
 */
export async function readGitTracking(cwd: string): Promise<GitTrackingStatus | null> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return null;

  const branch = (await git(cwd, ["branch", "--show-current"])).output.trim();
  if (!branch) return null;

  const upstreamResult = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  // `rev-parse` echoes its argument back for a ref it cannot resolve, so a
  // successful exit is not enough — an output still containing `@{upstream}`
  // means there is no upstream, not that the upstream is literally named that.
  const upstream = upstreamResult.ok ? upstreamResult.output.trim() : "";
  if (!upstream || upstream.includes("@{upstream}")) {
    return { branch, ahead: 0, behind: 0 };
  }

  const counts = await git(cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
  if (!counts.ok) return { branch, upstream, ahead: 0, behind: 0 };

  // Left side is upstream (behind), right side is HEAD (ahead).
  const [behind, ahead] = counts.output.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
  return {
    branch,
    upstream,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

/**
 * `git fetch --prune` — the one outbound operation that cannot lose local work.
 *
 * It updates remote-tracking refs only: no worktree change, no local branch moved.
 * That makes it the safe precondition for everything else here, since ahead/behind
 * is meaningless until the remote-tracking refs are current.
 */
export async function fetchGitRemote(cwd: string, remote?: string): Promise<GitOperationResult> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return operationResult(false, repository.output, cwd);

  const target = resolveRemote(await readGitRemotes(cwd), remote);
  if ("reason" in target) return operationResult(false, target.reason, cwd);

  const result = await git(cwd, ["fetch", "--prune", target.name], NETWORK_TIMEOUT_MS);
  if (!result.ok) return operationResult(false, result.output || `Unable to fetch ${target.name}`, cwd);

  const tracking = await readGitTracking(cwd);
  // `fetch` is quiet on success, so echoing its output would report an empty
  // message for the common case. State the resulting divergence instead — that is
  // the answer the user fetched for.
  return operationResult(true, `Fetched ${target.name}. ${describeTracking(tracking)}`, cwd);
}

/**
 * `git pull --ff-only`.
 *
 * Fast-forward only, deliberately. A merge or rebase pull can stop halfway with
 * conflict markers in the tree, and this app has no conflict-resolution UI to
 * finish the job — leaving a user mid-conflict is worse than refusing to pull.
 * Refuses on a dirty tree for the same reason `checkoutGitBranch` does.
 */
export async function pullGitRemote(cwd: string, remote?: string): Promise<GitOperationResult> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return operationResult(false, repository.output, cwd);

  const tracking = await readGitTracking(cwd);
  if (!tracking) return operationResult(false, "No branch is checked out", cwd);
  if (!tracking.upstream) {
    return operationResult(false, `${tracking.branch} has no upstream to pull from`, cwd);
  }

  if (await hasUncommittedChanges(cwd)) {
    return operationResult(
      false,
      "Uncommitted changes would be overwritten by a pull. Commit or stash them first.",
      cwd,
    );
  }

  const target = resolveRemote(await readGitRemotes(cwd), remote);
  if ("reason" in target) return operationResult(false, target.reason, cwd);

  const result = await git(cwd, ["pull", "--ff-only", target.name], NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    // The overwhelmingly common failure is divergence, and git's own wording for
    // it ("Not possible to fast-forward") does not say what to do about it.
    const diverged = /not possible to fast-forward|diverged/i.test(result.output);
    return operationResult(
      false,
      diverged
        ? `${tracking.branch} and ${tracking.upstream} have diverged. Rebase or merge manually — this app only fast-forwards.`
        : result.output || "Pull failed",
      cwd,
    );
  }

  const after = await readGitTracking(cwd);
  return operationResult(true, `Pulled ${target.name}. ${describeTracking(after)}`, cwd);
}

/**
 * Resolves exactly what a push would do, without doing it.
 *
 * Split from `pushGitBranch` on purpose: the confirmation dialog and the push
 * itself must agree about the remote, the branch, the commit count and whether an
 * upstream would be created. Computing that twice, in two layers, is how a dialog
 * ends up describing a different push from the one that runs.
 */
export async function readGitPushPlan(cwd: string, remote?: string): Promise<GitPushPlan> {
  const remotes = await readGitRemotes(cwd);
  // No remote name: every path that reaches here has either no usable remote or no
  // branch to push, so naming one would imply a target the plan does not have.
  const empty = (reason: string, branch = ""): GitPushPlan => ({
    pushable: false,
    branch,
    remote: "",
    remotes,
    createsUpstream: false,
    protectedBranch: PROTECTED_BRANCHES.has(branch),
    reason,
  });

  const repository = await ensureRepository(cwd);
  if (!repository.ok) return empty(repository.output);

  const tracking = await readGitTracking(cwd);
  if (!tracking) return empty("No branch is checked out (detached HEAD cannot be pushed by name)");

  const target = resolveRemote(remotes, remote);
  if ("reason" in target) return empty(target.reason, tracking.branch);
  const remoteName = target.name;

  // An upstream on a *different* remote tells us nothing about how far ahead we
  // are of the remote being pushed to, so count against that remote's own ref.
  const upstreamOnTarget = tracking.upstream?.startsWith(`${remoteName}/`) ? tracking.upstream : undefined;
  const remoteRef = `refs/remotes/${remoteName}/${tracking.branch}`;
  const remoteRefExists = (await git(cwd, ["rev-parse", "--verify", "--quiet", remoteRef])).ok;

  let ahead: number | undefined;
  let behind: number | undefined;
  if (remoteRefExists) {
    const counts = await git(cwd, ["rev-list", "--left-right", "--count", `${remoteRef}...HEAD`]);
    if (counts.ok) {
      const [b, a] = counts.output.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
      ahead = Number.isFinite(a) ? a : undefined;
      behind = Number.isFinite(b) ? b : undefined;
    }
  } else {
    // Nothing on the remote yet: every commit on this branch would be published.
    const total = await git(cwd, ["rev-list", "--count", "HEAD"]);
    const parsed = Number.parseInt(total.output.trim(), 10);
    ahead = total.ok && Number.isFinite(parsed) ? parsed : undefined;
    behind = 0;
  }

  return {
    pushable: true,
    branch: tracking.branch,
    remote: remoteName,
    remotes,
    upstream: upstreamOnTarget ?? tracking.upstream,
    createsUpstream: !upstreamOnTarget,
    ahead,
    behind,
    protectedBranch: PROTECTED_BRANCHES.has(tracking.branch),
  };
}

/**
 * Pushes the current branch. The only operation here that sends data off the machine.
 *
 * Re-resolves the plan rather than trusting arguments from the renderer: the branch
 * can have changed between rendering the confirmation and clicking it, and pushing
 * a branch the user did not read about in the dialog is exactly the mistake the
 * dialog exists to prevent.
 *
 * Never `--force`. A force push can destroy commits on the remote that no local
 * clone has, which is not an operation to expose behind a side-panel button.
 */
export async function pushGitBranch(
  cwd: string,
  options: { remote?: string; allowProtected?: boolean; expectedBranch?: string } = {},
): Promise<GitOperationResult> {
  const plan = await readGitPushPlan(cwd, options.remote);
  if (!plan.pushable) return operationResult(false, plan.reason ?? "Nothing to push", cwd);

  const expected = options.expectedBranch?.trim();
  if (expected && expected !== plan.branch) {
    return operationResult(
      false,
      `The checked-out branch is now ${plan.branch}, not ${expected}. Refresh before pushing.`,
      cwd,
    );
  }

  if (plan.protectedBranch && !options.allowProtected) {
    return operationResult(
      false,
      `${plan.branch} is a protected branch. Confirm the protected-branch toggle to push it.`,
      cwd,
    );
  }

  if (plan.ahead === 0 && !plan.createsUpstream) {
    return operationResult(true, `${plan.remote}/${plan.branch} is already up to date.`, cwd);
  }

  const args = ["push"];
  if (plan.createsUpstream) args.push("--set-upstream");
  // Name the local branch and the remote branch explicitly. A bare `git push`
  // obeys `push.default`, which under `matching` pushes *other* branches too.
  args.push(plan.remote, `${plan.branch}:${plan.branch}`);

  const result = await git(cwd, args, NETWORK_TIMEOUT_MS);
  if (!result.ok) {
    const rejected = /\[rejected\]|non-fast-forward|fetch first/i.test(result.output);
    return operationResult(
      false,
      rejected
        ? `${plan.remote} rejected the push: it has commits ${plan.branch} does not. Fetch and pull first.`
        : result.output || "Push failed",
      cwd,
    );
  }

  const published = plan.ahead ?? 0;
  const noun = published === 1 ? "commit" : "commits";
  return operationResult(
    true,
    `Pushed ${published} ${noun} to ${plan.remote}/${plan.branch}${plan.createsUpstream ? " and set it as upstream" : ""}.`,
    cwd,
  );
}

/**
 * Line-level authorship for one file.
 *
 * `--line-porcelain` repeats every header per line, which is verbose on the wire
 * but means each line can be parsed without carrying state across commit blocks —
 * the abbreviated form omits repeated headers and needs that state.
 */
export async function readGitBlame(cwd: string, filePath: string): Promise<GitBlameResult> {
  const repository = await ensureRepository(cwd);
  if (!repository.ok) return { cwd, path: filePath, lines: [], error: repository.output };

  const safePath = sanitizeRepoPath(filePath);
  if (!safePath) return { cwd, path: filePath, lines: [], error: "Invalid repository path" };

  const result = await git(cwd, ["blame", "--line-porcelain", "HEAD", "--", safePath]);
  if (!result.ok) {
    return { cwd, path: safePath, lines: [], error: result.output || "Unable to blame this file" };
  }

  return { cwd, path: safePath, lines: parseBlamePorcelain(result.output) };
}

/**
 * Picks the remote to act on, or explains why none can be.
 *
 * Takes the already-read remote list rather than reading it again: `readGitRemotes`
 * costs a `git remote -v` plus a repository check, and `readGitPushPlan` needs the
 * full list anyway to render a chooser. Returning the name or the reason from one
 * place is what keeps "which remote would this use" from being answered twice with
 * two subtly different rules.
 */
function resolveRemote(remotes: GitRemoteSummary[], remote?: string): { name: string } | { reason: string } {
  if (remotes.length === 0) return { reason: "No remote is configured" };

  const requested = remote?.trim();
  if (!requested) {
    // `origin` by convention, otherwise the only/first one configured.
    return { name: remotes.find((entry) => entry.name === "origin")?.name ?? remotes[0].name };
  }
  if (!remotes.some((entry) => entry.name === requested)) return { reason: `Unknown remote ${requested}` };
  return { name: requested };
}

/** One sentence describing divergence, for appending to an operation message. */
function describeTracking(tracking: GitTrackingStatus | null): string {
  if (!tracking) return "";
  if (!tracking.upstream) return `${tracking.branch} has no upstream.`;
  if (tracking.ahead === 0 && tracking.behind === 0) return `${tracking.branch} is up to date with ${tracking.upstream}.`;

  const parts: string[] = [];
  if (tracking.ahead > 0) parts.push(`${tracking.ahead} ahead`);
  if (tracking.behind > 0) parts.push(`${tracking.behind} behind`);
  return `${tracking.branch} is ${parts.join(", ")} of ${tracking.upstream}.`;
}

/**
 * Parses `git blame --line-porcelain`.
 *
 * Each line begins with `<sha> <origLine> <finalLine>[ <groupSize>]`, followed by
 * repeated headers, and ends with the source line prefixed by a TAB. The TAB
 * prefix is the only reliable content marker: a header value can otherwise look
 * like source, and source can look like a header.
 */
function parseBlamePorcelain(output: string): GitBlameLine[] {
  const lines: GitBlameLine[] = [];
  let current: Partial<GitBlameLine> & { hash?: string } = {};

  for (const raw of output.split(/\r?\n/)) {
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(raw);
    if (header) {
      current = { hash: header[1], line: Number.parseInt(header[2], 10) };
      continue;
    }
    if (raw.startsWith("author ")) {
      current.author = raw.slice("author ".length);
      continue;
    }
    if (raw.startsWith("author-time ")) {
      const seconds = Number.parseInt(raw.slice("author-time ".length), 10);
      if (Number.isFinite(seconds)) current.date = new Date(seconds * 1000).toISOString();
      continue;
    }
    if (raw.startsWith("summary ")) {
      current.summary = raw.slice("summary ".length);
      continue;
    }
    if (raw.startsWith("\t")) {
      if (current.hash && current.line) {
        lines.push({
          hash: current.hash,
          shortHash: current.hash.slice(0, 7),
          line: current.line,
          author: current.author ?? "",
          date: current.date ?? "",
          summary: current.summary ?? "",
          content: raw.slice(1),
        });
      }
      current = {};
    }
  }

  return lines;
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
async function resolveStashEntry(cwd: string, ref: string): Promise<GitStashEntry | null> {
  const trimmed = ref.trim();
  if (!/^stash@\{\d+\}$/.test(trimmed)) return null;
  const entries = await readGitStashes(cwd);
  return entries.find((entry) => entry.ref === trimmed) ?? null;
}

/** Both the shifting ref and immutable object id must identify the same entry. */
async function resolveExpectedStash(cwd: string, ref: string, expectedOid: string): Promise<GitStashEntry | null> {
  if (!/^[0-9a-f]{40,64}$/i.test(expectedOid.trim())) return null;
  const entry = await resolveStashEntry(cwd, ref);
  return entry?.oid === expectedOid.trim() ? entry : null;
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
 * this exact invocation — same never-throw contract — rather than growing a
 * second, subtly different git helper.
 *
 * `timeoutMs` defaults to a budget tuned for local plumbing: every read here
 * answers from `.git` in milliseconds, so 5s means "something is wedged".
 * Network operations (`fetch`, `pull`, `push`) legitimately take longer on a
 * cold TLS handshake or a large pack, and killing them at 5s would surface as a
 * spurious failure against a perfectly healthy remote — worse, a killed `push`
 * leaves the user unsure whether the objects landed. Those callers pass their own.
 */
export function git(cwd: string, args: string[], timeoutMs = 5_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Never let git stop for input. Without this a missing credential turns
        // a fetch into a child blocked forever on a username prompt that has no
        // terminal to appear on, and the operation only ends when the timeout
        // kills it — reported as a timeout rather than "you are not authenticated".
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

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
      if (timedOut) {
        resolve({ ok: false, output: `git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s` });
        return;
      }
      resolve({ ok: code === 0, output: code === 0 ? stdout : stderr || stdout });
    });
  });
}

