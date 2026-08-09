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
