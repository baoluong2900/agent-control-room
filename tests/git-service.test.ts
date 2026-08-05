import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitGitChanges,
  readGitDiff,
  readGitFileDiff,
  readGitLog,
  stageGitFile,
  unstageGitFile,
} from "../src/main/git/git-service.ts";

function tempDir(label: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agentic-${label}-`)));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A repo with one committed file, so later tests have a HEAD to diff against. */
function initRepo(label: string): string {
  const dir = tempDir(label);
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@agentic.local"]);
  git(dir, ["config", "user.name", "Agentic Test"]);
  fs.writeFileSync(path.join(dir, "committed.txt"), "base\n");
  git(dir, ["add", "committed.txt"]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

function findChange(files: Awaited<ReturnType<typeof readGitDiff>>["files"], filePath: string, staged: boolean) {
  return files.find((file) => file.path === filePath && file.staged === staged);
}

test("a non-git folder is reported as such instead of throwing", async () => {
  const dir = tempDir("no-repo");

  const summary = await readGitDiff(dir);

  assert.equal(summary.isRepository, false);
  assert.equal(summary.branch, "—");
  assert.deepEqual(summary.files, []);
  assert.equal(summary.stagedCount, 0);
  assert.equal(summary.unstagedCount, 0);
  assert.equal(summary.untrackedCount, 0);
});

test("a clean repository reports its branch and no file changes", async () => {
  const dir = initRepo("clean");

  const summary = await readGitDiff(dir);

  assert.equal(summary.isRepository, true);
  assert.equal(summary.branch, "main");
  assert.equal(summary.status, "Clean working tree");
  assert.deepEqual(summary.files, []);
});

test("staged, unstaged, and untracked changes are counted separately", async () => {
  const dir = initRepo("mixed");

  // Staged addition.
  fs.writeFileSync(path.join(dir, "added.txt"), "new\n");
  git(dir, ["add", "added.txt"]);

  // Tracked file modified but not staged.
  fs.appendFileSync(path.join(dir, "committed.txt"), "more\n");

  // Never added to the index.
  fs.writeFileSync(path.join(dir, "untracked.txt"), "loose\n");

  const summary = await readGitDiff(dir);

  assert.equal(summary.isRepository, true);
  assert.equal(summary.stagedCount, 1);
  assert.equal(summary.unstagedCount, 1);
  assert.equal(summary.untrackedCount, 1);

  assert.equal(findChange(summary.files, "added.txt", true)?.kind, "added");
  assert.equal(findChange(summary.files, "committed.txt", false)?.kind, "modified");
  assert.equal(findChange(summary.files, "untracked.txt", false)?.kind, "untracked");
});

test("a file staged and then modified again appears on both sides", async () => {
  const dir = initRepo("both-sides");

  fs.writeFileSync(path.join(dir, "committed.txt"), "staged change\n");
  git(dir, ["add", "committed.txt"]);
  fs.appendFileSync(path.join(dir, "committed.txt"), "further edit\n");

  const summary = await readGitDiff(dir);

  assert.equal(findChange(summary.files, "committed.txt", true)?.kind, "modified");
  assert.equal(findChange(summary.files, "committed.txt", false)?.kind, "modified");
  assert.equal(summary.stagedCount, 1);
  assert.equal(summary.unstagedCount, 1);
});

test("the diff stat separates staged from unstaged work", async () => {
  const dir = initRepo("stat");

  fs.writeFileSync(path.join(dir, "staged-only.txt"), "one\n");
  git(dir, ["add", "staged-only.txt"]);
  fs.appendFileSync(path.join(dir, "committed.txt"), "dirty\n");

  const summary = await readGitDiff(dir);

  assert.match(summary.diffStat, /Staged:/);
  assert.match(summary.diffStat, /staged-only\.txt/);
  assert.match(summary.diffStat, /Unstaged:/);
  assert.match(summary.diffStat, /committed\.txt/);
});

test("a staged deletion is classified as deleted", async () => {
  const dir = initRepo("deleted");

  git(dir, ["rm", "committed.txt"]);

  const summary = await readGitDiff(dir);

  assert.equal(findChange(summary.files, "committed.txt", true)?.kind, "deleted");
  assert.equal(summary.stagedCount, 1);
});

test("a staged rename resolves to the new path", async () => {
  const dir = initRepo("renamed");

  git(dir, ["mv", "committed.txt", "renamed.txt"]);

  const summary = await readGitDiff(dir);
  const renamed = summary.files.find((file) => file.staged && file.kind === "renamed");

  assert.ok(renamed, "expected a staged rename entry");
  assert.equal(renamed.path, "renamed.txt");
});

test("paths with spaces survive porcelain quoting", async () => {
  const dir = initRepo("quoted");

  fs.writeFileSync(path.join(dir, "has space.txt"), "spaced\n");
  git(dir, ["add", "has space.txt"]);

  const summary = await readGitDiff(dir);

  assert.equal(findChange(summary.files, "has space.txt", true)?.kind, "added");
});

test("a detached HEAD is labelled instead of shown as empty", async () => {
  const dir = initRepo("detached");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  git(dir, ["checkout", head]);

  const summary = await readGitDiff(dir);

  assert.equal(summary.isRepository, true);
  assert.equal(summary.branch, "detached HEAD");
});

test("file diff returns staged, unstaged, and untracked patches", async () => {
  const dir = initRepo("file-diff");

  fs.writeFileSync(path.join(dir, "staged.txt"), "new staged\n");
  git(dir, ["add", "staged.txt"]);
  fs.appendFileSync(path.join(dir, "committed.txt"), "dirty\n");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "loose\n");

  const staged = await readGitFileDiff(dir, "staged.txt", true);
  const unstaged = await readGitFileDiff(dir, "committed.txt", false);
  const untracked = await readGitFileDiff(dir, "untracked.txt", false);

  assert.match(staged.patch, /new staged/);
  assert.match(unstaged.patch, /dirty/);
  assert.match(untracked.patch, /new file mode/);
  assert.match(untracked.patch, /\+loose/);
});

test("stage and unstage update the working tree summary", async () => {
  const dir = initRepo("stage-unstage");
  fs.appendFileSync(path.join(dir, "committed.txt"), "change\n");

  const staged = await stageGitFile(dir, "committed.txt");
  assert.equal(staged.ok, true);
  assert.equal(staged.summary?.stagedCount, 1);
  assert.equal(staged.summary?.unstagedCount, 0);

  const unstaged = await unstageGitFile(dir, "committed.txt");
  assert.equal(unstaged.ok, true);
  assert.equal(unstaged.summary?.stagedCount, 0);
  assert.equal(unstaged.summary?.unstagedCount, 1);
});

test("commit creates a new log entry from staged changes", async () => {
  const dir = initRepo("commit");
  fs.writeFileSync(path.join(dir, "feature.txt"), "feature\n");
  git(dir, ["add", "feature.txt"]);

  const result = await commitGitChanges(dir, "add feature");
  const log = await readGitLog(dir, 2);

  assert.equal(result.ok, true);
  assert.equal(result.summary?.stagedCount, 0);
  assert.equal(result.commit?.subject, "add feature");
  assert.equal(log[0]?.subject, "add feature");
});

test("git path operations reject parent traversal", async () => {
  const dir = initRepo("unsafe-path");

  const stage = await stageGitFile(dir, "../outside.txt");
  const diff = await readGitFileDiff(dir, "../outside.txt");

  assert.equal(stage.ok, false);
  assert.equal(diff.error, "Invalid repository path");
});
