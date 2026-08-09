import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyGitStash,
  checkoutGitBranch,
  createGitStash,
  dropGitStash,
  readGitBranches,
  readGitStashDetail,
  readGitStashes,
} from "../src/main/git/git-service.ts";

/**
 * Branch and stash operations, exercised against real temporary repositories.
 *
 * These are the first Git operations in this app that can *lose* work — a
 * checkout can carry half-finished edits onto another branch, `stash drop` has no
 * undo — so the refusals matter as much as the happy paths and are asserted just
 * as explicitly.
 */

function tempDir(label: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agentic-${label}-`)));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

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

test("branches are listed with the current one first", async () => {
  const dir = initRepo("branch-list");
  git(dir, ["branch", "feature-a"]);
  git(dir, ["branch", "feature-b"]);

  const branches = await readGitBranches(dir);

  assert.deepEqual(
    branches.map((branch) => branch.name).sort(),
    ["feature-a", "feature-b", "main"],
    "every local branch should be listed",
  );
  assert.equal(branches[0].name, "main", "the checked-out branch must lead the list");
  assert.equal(branches[0].current, true);
  assert.equal(branches.filter((branch) => branch.current).length, 1, "exactly one branch is current");
  assert.equal(branches[0].subject, "base", "the tip subject disambiguates similar branch names");
});

test("a non-git folder yields no branches and no stashes rather than throwing", async () => {
  const dir = tempDir("branch-no-repo");

  assert.deepEqual(await readGitBranches(dir), []);
  assert.deepEqual(await readGitStashes(dir), []);
});

test("creating a branch switches to it and refuses a duplicate name", async () => {
  const dir = initRepo("branch-create");

  const created = await checkoutGitBranch(dir, "feature/login", true);
  assert.equal(created.ok, true, created.message);
  assert.equal(created.summary?.branch, "feature/login", "the returned summary reflects the new branch");

  const duplicate = await checkoutGitBranch(dir, "feature/login", true);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.message, /already exists/);

  // Still on the branch created first: the failed call must not have moved HEAD.
  const branches = await readGitBranches(dir);
  assert.equal(branches.find((branch) => branch.current)?.name, "feature/login");
});

test("checkout refuses to carry uncommitted tracked changes onto another branch", async () => {
  const dir = initRepo("branch-dirty");
  git(dir, ["branch", "other"]);
  fs.writeFileSync(path.join(dir, "committed.txt"), "work in progress\n");

  const result = await checkoutGitBranch(dir, "other");

  assert.equal(result.ok, false);
  assert.match(result.message, /Commit or stash/);
  // The refusal has to be real: HEAD unmoved and the edit still on disk.
  assert.equal((await readGitBranches(dir)).find((branch) => branch.current)?.name, "main");
  assert.equal(fs.readFileSync(path.join(dir, "committed.txt"), "utf8"), "work in progress\n");
});

test("an untracked file does not block a checkout", async () => {
  const dir = initRepo("branch-untracked");
  git(dir, ["branch", "other"]);
  // Git carries untracked files across a switch untouched, so blocking on them
  // would refuse a safe operation.
  fs.writeFileSync(path.join(dir, "scratch.txt"), "notes\n");

  const result = await checkoutGitBranch(dir, "other");

  assert.equal(result.ok, true, result.message);
  assert.equal(fs.readFileSync(path.join(dir, "scratch.txt"), "utf8"), "notes\n", "the untracked file survives");
});

test("a branch name git would reject is refused before git runs", async () => {
  const dir = initRepo("branch-invalid");

  for (const name of ["-f", "has space", "bad..name", "ends/", "tip.lock", "with~tilde", "@{0}", ""]) {
    const result = await checkoutGitBranch(dir, name, true);
    assert.equal(result.ok, false, `${JSON.stringify(name)} should be rejected`);
    assert.equal(result.message, "Invalid branch name", `${JSON.stringify(name)} got: ${result.message}`);
  }

  assert.deepEqual(
    (await readGitBranches(dir)).map((branch) => branch.name),
    ["main"],
    "no branch was created by any rejected name",
  );
});

test("switching to a branch that does not exist locally is refused", async () => {
  const dir = initRepo("branch-missing");

  const result = await checkoutGitBranch(dir, "nope");

  assert.equal(result.ok, false);
  assert.match(result.message, /does not exist locally/);
});

test("stash push stores tracked work, clears the tree, and restores on apply", async () => {
  const dir = initRepo("stash-round-trip");
  const file = path.join(dir, "committed.txt");
  fs.writeFileSync(file, "stashed edit\n");

  const pushed = await createGitStash(dir, "wip login");
  assert.equal(pushed.ok, true, pushed.message);
  assert.equal(fs.readFileSync(file, "utf8"), "base\n", "the work tree returns to HEAD after stashing");

  const entries = await readGitStashes(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ref, "stash@{0}");
  assert.equal(entries[0].index, 0);
  assert.match(entries[0].message, /wip login/);
  assert.equal(entries[0].branch, "main", "the branch the stash was taken on is parsed out");

  const detail = await readGitStashDetail(dir, "stash@{0}");
  assert.equal(detail.error, undefined);
  assert.deepEqual(detail.files, ["committed.txt"]);
  assert.match(detail.patch, /stashed edit/, "the patch shows what would be restored");

  const applied = await applyGitStash(dir, "stash@{0}", true);
  assert.equal(applied.ok, true, applied.message);
  assert.equal(fs.readFileSync(file, "utf8"), "stashed edit\n", "apply restores the edit");
  assert.equal((await readGitStashes(dir)).length, 1, "apply keeps the entry on the stack");
});

test("pop consumes the entry that apply would have kept", async () => {
  const dir = initRepo("stash-pop");
  fs.writeFileSync(path.join(dir, "committed.txt"), "popped\n");
  await createGitStash(dir, "wip");

  const popped = await applyGitStash(dir, "stash@{0}", false);

  assert.equal(popped.ok, true, popped.message);
  assert.equal(fs.readFileSync(path.join(dir, "committed.txt"), "utf8"), "popped\n");
  assert.deepEqual(await readGitStashes(dir), [], "pop removes the entry");
});

test("stashing a clean tree is reported as a failure, not a silent success", async () => {
  const dir = initRepo("stash-clean");

  // `git stash push` exits 0 on a clean tree while creating nothing, so a naive
  // wrapper would report a stash the user cannot find.
  const result = await createGitStash(dir, "nothing here");

  assert.equal(result.ok, false);
  assert.match(result.message, /Nothing to stash/);
  assert.deepEqual(await readGitStashes(dir), []);
});

test("untracked-only changes need the include-untracked flag, and it works", async () => {
  const dir = initRepo("stash-untracked");
  fs.writeFileSync(path.join(dir, "fresh.txt"), "new file\n");

  const refused = await createGitStash(dir, "wip");
  assert.equal(refused.ok, false, "plain stash push would not have captured the untracked file");
  assert.match(refused.message, /Include untracked/);
  assert.equal(fs.existsSync(path.join(dir, "fresh.txt")), true, "the file is untouched by the refusal");

  const included = await createGitStash(dir, "wip", true);
  assert.equal(included.ok, true, included.message);
  assert.equal(fs.existsSync(path.join(dir, "fresh.txt")), false, "the untracked file was stashed away");

  const detail = await readGitStashDetail(dir, "stash@{0}");
  assert.ok(detail.files.includes("fresh.txt"), "the preview includes the untracked file that would be restored");
  assert.match(detail.patch, /new file mode/, "the untracked file has a real patch in the preview");

  const restored = await applyGitStash(dir, "stash@{0}", false);
  assert.equal(restored.ok, true, restored.message);
  assert.equal(fs.readFileSync(path.join(dir, "fresh.txt"), "utf8"), "new file\n");
});

test("restoring a stash over a dirty tree is refused", async () => {
  const dir = initRepo("stash-dirty");
  const file = path.join(dir, "committed.txt");
  fs.writeFileSync(file, "first edit\n");
  await createGitStash(dir, "first");
  fs.writeFileSync(file, "second edit\n");

  const result = await applyGitStash(dir, "stash@{0}", true);

  assert.equal(result.ok, false);
  assert.match(result.message, /clean tree/);
  assert.equal(fs.readFileSync(file, "utf8"), "second edit\n", "the current edit is left alone");
  assert.equal((await readGitStashes(dir)).length, 1, "the stash is still there to restore later");
});

test("restoring a stash over an untracked file is refused too", async () => {
  const dir = initRepo("stash-untracked-collision");
  const fresh = path.join(dir, "fresh.txt");
  fs.writeFileSync(fresh, "from stash\n");
  await createGitStash(dir, "untracked", true);
  fs.writeFileSync(fresh, "current local file\n");

  const result = await applyGitStash(dir, "stash@{0}", true);

  assert.equal(result.ok, false);
  assert.match(result.message, /clean tree/);
  assert.equal(fs.readFileSync(fresh, "utf8"), "current local file\n", "the local untracked file is untouched");
  assert.equal((await readGitStashes(dir)).length, 1, "the stash stays available after the refusal");
});

test("an unknown or malformed stash ref is refused instead of passed to git", async () => {
  const dir = initRepo("stash-bad-ref");
  fs.writeFileSync(path.join(dir, "committed.txt"), "edit\n");
  await createGitStash(dir, "only entry");

  for (const ref of ["stash@{7}", "refs/stash", "stash@{0}; rm -rf /", "HEAD", ""]) {
    const applied = await applyGitStash(dir, ref, true);
    assert.equal(applied.ok, false, `${JSON.stringify(ref)} should be refused`);
    const detail = await readGitStashDetail(dir, ref);
    assert.ok(detail.error, `${JSON.stringify(ref)} should report an error`);
  }

  assert.equal((await readGitStashes(dir)).length, 1, "the real entry is untouched");
});

test("drop refuses when the stack shifted under the message the UI showed", async () => {
  const dir = initRepo("stash-drop-guard");
  const file = path.join(dir, "committed.txt");

  fs.writeFileSync(file, "older\n");
  await createGitStash(dir, "older work");
  fs.writeFileSync(file, "newer\n");
  await createGitStash(dir, "newer work");

  // Pushing shifts everything down: what the UI rendered as stash@{0} ("older
  // work") is now stash@{1}, and dropping stash@{0} would delete the wrong entry.
  const entries = await readGitStashes(dir);
  assert.match(entries[0].message, /newer work/);
  assert.match(entries[1].message, /older work/);

  const stale = await dropGitStash(dir, "stash@{0}", "On main: older work");
  assert.equal(stale.ok, false);
  assert.match(stale.message, /stash stack shifted/);
  assert.equal((await readGitStashes(dir)).length, 2, "nothing was dropped");

  const dropped = await dropGitStash(dir, "stash@{0}", entries[0].message);
  assert.equal(dropped.ok, true, dropped.message);
  const remaining = await readGitStashes(dir);
  assert.equal(remaining.length, 1);
  assert.match(remaining[0].message, /older work/, "the entry the user meant to keep survived");
});
