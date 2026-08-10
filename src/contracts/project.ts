export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string;
}

/** Porcelain status codes collapsed into something the UI can label and colour. */
export type GitFileChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitFileChange {
  path: string;
  kind: GitFileChangeKind;
  /** True when the change is present in the index (staged). */
  staged: boolean;
  /** Raw two-character porcelain code, kept for tooltips. */
  code: string;
}

export interface GitDiffSummary {
  cwd: string;
  branch: string;
  status: string;
  diffStat: string;
  /** Per-file changes parsed from `git status --porcelain`. */
  files: GitFileChange[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  /** False when the folder is not a git work tree. */
  isRepository: boolean;
}

export interface GitFileDiff {
  cwd: string;
  path: string;
  staged: boolean;
  patch: string;
  isRepository: boolean;
  error?: string;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitOperationResult {
  ok: boolean;
  message: string;
  summary?: GitDiffSummary;
  commit?: GitCommitSummary;
}

export interface GitBranchSummary {
  name: string;
  /** True for the branch currently checked out. */
  current: boolean;
  /** Upstream tracking ref, when the branch has one (`origin/main`). */
  upstream?: string;
  /** Subject of the branch tip, for disambiguating similar branch names. */
  subject?: string;
}

/**
 * How far the current branch has diverged from its upstream, as of the last
 * fetch. Both counts are relative to the *local* view: `behind` only grows once
 * a fetch has updated the remote-tracking ref, which is why the UI has to offer
 * fetch before it can claim a branch is up to date.
 */
export interface GitTrackingStatus {
  branch: string;
  /** Upstream ref (`origin/main`), or undefined when the branch has none. */
  upstream?: string;
  /** Commits the local branch has that upstream does not. */
  ahead: number;
  /** Commits upstream has that the local branch does not. */
  behind: number;
}

/** Remote name and fetch URL, for showing what an outbound action would talk to. */
export interface GitRemoteSummary {
  name: string;
  fetchUrl?: string;
}

/**
 * What a push would actually do, resolved before anything leaves the machine.
 *
 * Push is the only Git operation in this app that sends data off the machine, so
 * the confirmation cannot be a generic "are you sure" — it has to name the
 * remote, the branch, and how many commits would be published. This is the shape
 * the confirm dialog renders, and it is computed by the main process so the UI
 * cannot disagree with what the push then does.
 */
export interface GitPushPlan {
  /** False when there is no repository, no branch, or no remote to push to. */
  pushable: boolean;
  branch: string;
  remote: string;
  /** Every configured remote, so the UI can offer a choice rather than assume `origin`. */
  remotes: GitRemoteSummary[];
  /** Existing upstream ref, when the branch already tracks one. */
  upstream?: string;
  /** True when the push would have to create the remote branch (`--set-upstream`). */
  createsUpstream: boolean;
  /** Commits that would be published. `undefined` when it cannot be computed yet. */
  ahead?: number;
  /** Commits upstream is ahead by; a non-zero value means the push is rejected. */
  behind?: number;
  /**
   * True for `main`/`master`. Not a hard block in the service — the caller must
   * opt in explicitly — but the UI keeps the confirm gated behind a second toggle.
   */
  protectedBranch: boolean;
  /** Human-readable reason when `pushable` is false. */
  reason?: string;
}

/** One line of a file, attributed to the commit that last touched it. */
export interface GitBlameLine {
  /** 1-based line number in the current file. */
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  /** ISO timestamp of the author date. */
  date: string;
  /** Subject of the attributed commit. */
  summary: string;
  /** The source line itself, so the view needs no second read of the file. */
  content: string;
}

/**
 * Line-level authorship for one file. Read-only: blame answers "who last touched
 * this", it changes nothing, so it needs none of the guards the write paths carry.
 */
export interface GitBlameResult {
  cwd: string;
  path: string;
  lines: GitBlameLine[];
  /** Set when the file is untracked, binary, or outside a repository. */
  error?: string;
}

export interface GitStashEntry {
  /** Stack reference (`stash@{0}`). Positional: it shifts as entries are added. */
  ref: string;
  /** Immutable commit object id: the stable identity behind the shifting ref. */
  oid: string;
  /** Index in the stack, so the UI never has to parse `ref`. */
  index: number;
  message: string;
  /** Branch the stash was taken on. */
  branch?: string;
  date: string;
}

/**
 * What a stash entry would restore. `git stash apply` is not reversible by any
 * single git command, so the UI shows this before asking for confirmation.
 */
export interface GitStashDetail {
  ref: string;
  oid: string;
  patch: string;
  files: string[];
  error?: string;
}
