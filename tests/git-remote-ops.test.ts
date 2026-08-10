import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fetchGitRemote,
  pullGitRemote,
  pushGitBranch,
  readGitBlame,
  readGitPushPlan,
  readGitRemotes,
  readGitTracking,
} from "../src/main/git/git-service.ts";

/**
 * Outbound Git, exercised against real repositories with a real remote.
 *
 * The remote is a local bare repository rather than a network host: `git push` and
 * `git fetch` take the identical code path through the transport layer, so the
 * ahead/behind arithmetic, upstream creation and rejection handling are all
 * genuinely exercised without the suite needing network access.
 *
 * These are the first operations in this app that send data *off* the machine, so
 * the refusals carry more weight than the happy paths: a push that publishes a
 * branch the user was not shown, or one that fast-forwards a protected trunk
 * without a second confirmation, is the failure mode worth pinning.
 */

function tempDir(label: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agentic-${label}-`)));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function capture(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A clone with a bare remote, so push/fetch/pull are the real commands. */
function initWithRemote(label: string): { dir: string; remote: string } {
  const root = tempDir(label);
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(remote);
  git(remote, ["init", "--bare", "--initial-branch=main"]);

  const dir = path.join(root, "work");
  fs.mkdirSync(dir);
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@agentic.local"]);
  git(dir, ["config", "user.name", "Agentic Test"]);
  git(dir, ["remote", "add", "origin", remote]);
  fs.writeFileSync(path.join(dir, "committed.txt"), "base\n");
  git(dir, ["add", "committed.txt"]);
  git(dir, ["commit", "-m", "base"]);
  return { dir, remote };
}

function commit(dir: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ["add", file]);
  git(dir, ["commit", "-m", message]);
}

test("remotes are listed with their fetch URL", async () => {
  const { dir, remote } = initWithRemote("remote-list");

  const remotes = await readGitRemotes(dir);

  assert.equal(remotes.length, 1, "one remote configured, one entry (fetch and push lines must collapse)");
  assert.equal(remotes[0].name, "origin");
  assert.equal(remotes[0].fetchUrl, remote, "the URL is what tells the user where code would go");
});

test("a folder without a repository reports no remotes and no tracking rather than throwing", async () => {
  const dir = tempDir("remote-no-repo");

  assert.deepEqual(await readGitRemotes(dir), []);
  assert.equal(await readGitTracking(dir), null);
});

test("a branch with no upstream reports no upstream instead of a false zero-divergence", async () => {
  const { dir } = initWithRemote("tracking-no-upstream");

  const tracking = await readGitTracking(dir);

  assert.equal(tracking?.branch, "main");
  assert.equal(tracking?.upstream, undefined, "rev-parse echoes @{upstream} back when unresolvable; that is not an upstream");
  assert.equal(tracking?.ahead, 0);
  assert.equal(tracking?.behind, 0);
});

test("the first push creates the remote branch, sets upstream, and publishes every commit", async () => {
  const { dir, remote } = initWithRemote("push-first");
  commit(dir, "second.txt", "second\n", "second");

  const plan = await readGitPushPlan(dir);
  assert.equal(plan.pushable, true, plan.reason);
  assert.equal(plan.remote, "origin");
  assert.equal(plan.branch, "main");
  assert.equal(plan.createsUpstream, true, "nothing on the remote yet, so upstream has to be created");
  assert.equal(plan.ahead, 2, "with no remote ref, every commit on the branch would be published");
  assert.equal(plan.protectedBranch, true, "main is protected");

  const pushed = await pushGitBranch(dir, { allowProtected: true });
  assert.equal(pushed.ok, true, pushed.message);
  assert.match(pushed.message, /2 commits/, "the message states how many commits actually left the machine");
  assert.match(pushed.message, /set it as upstream/);

  // The remote genuinely received the branch, and the local branch now tracks it.
  assert.equal(capture(remote, ["rev-parse", "main"]), capture(dir, ["rev-parse", "HEAD"]));
  const tracking = await readGitTracking(dir);
  assert.equal(tracking?.upstream, "origin/main");
  assert.equal(tracking?.ahead, 0);
  assert.equal(tracking?.behind, 0);
});

test("a protected branch is refused until the caller opts in, and nothing is published meanwhile", async () => {
  const { dir, remote } = initWithRemote("push-protected");

  const refused = await pushGitBranch(dir);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /protected branch/);

  // The point of the guard: the remote must still be empty.
  assert.equal(
    execFileSync("git", ["branch", "--list"], { cwd: remote, encoding: "utf8" }).trim(),
    "",
    "a refused push must not have created the remote branch",
  );

  const allowed = await pushGitBranch(dir, { allowProtected: true });
  assert.equal(allowed.ok, true, allowed.message);
  assert.equal(capture(remote, ["rev-parse", "main"]), capture(dir, ["rev-parse", "HEAD"]));
});

test("a feature branch pushes without the protected-branch opt-in", async () => {
  const { dir, remote } = initWithRemote("push-feature");
  git(dir, ["switch", "--create", "feature/login"]);
  commit(dir, "feature.txt", "feature\n", "feature work");

  const plan = await readGitPushPlan(dir);
  assert.equal(plan.protectedBranch, false);
  assert.equal(plan.branch, "feature/login");

  const pushed = await pushGitBranch(dir);
  assert.equal(pushed.ok, true, pushed.message);
  assert.equal(capture(remote, ["rev-parse", "feature/login"]), capture(dir, ["rev-parse", "HEAD"]));
  // Only the named branch was published: a bare `git push` under push.default=matching
  // would have taken `main` along with it.
  assert.equal(
    execFileSync("git", ["branch", "--list"], { cwd: remote, encoding: "utf8" }).trim(),
    "feature/login",
    "push must name one refspec rather than obeying push.default",
  );
});

test("push refuses when HEAD moved after the confirmation was rendered", async () => {
  const { dir } = initWithRemote("push-stale-branch");
  git(dir, ["switch", "--create", "feature/a"]);

  const stale = await pushGitBranch(dir, { expectedBranch: "feature/b" });

  assert.equal(stale.ok, false);
  assert.match(stale.message, /is now feature\/a, not feature\/b/);
});

test("push reports up to date instead of claiming it published nothing", async () => {
  const { dir } = initWithRemote("push-idempotent");
  git(dir, ["switch", "--create", "feature/idem"]);
  await pushGitBranch(dir);

  const again = await pushGitBranch(dir);

  assert.equal(again.ok, true, again.message);
  assert.match(again.message, /already up to date/);
});

test("push is rejected when the remote carries commits the branch does not, and says what to do", async () => {
  const { dir, remote } = initWithRemote("push-rejected");
  git(dir, ["switch", "--create", "shared"]);
  await pushGitBranch(dir);

  // A second clone advances the shared branch behind our back.
  const other = path.join(path.dirname(remote), "other");
  execFileSync("git", ["clone", remote, other], { stdio: "ignore" });
  git(other, ["config", "user.email", "other@agentic.local"]);
  git(other, ["config", "user.name", "Other Clone"]);
  git(other, ["switch", "shared"]);
  commit(other, "theirs.txt", "theirs\n", "their work");
  git(other, ["push", "origin", "shared"]);

  commit(dir, "ours.txt", "ours\n", "our work");
  const rejected = await pushGitBranch(dir);

  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /rejected the push/);
  assert.match(rejected.message, /Fetch and pull first/, "the message has to name the recovery, not just the failure");
});

test("fetch updates the remote-tracking ref and reports the resulting divergence", async () => {
  const { dir, remote } = initWithRemote("fetch-updates");
  await pushGitBranch(dir, { allowProtected: true });

  const other = path.join(path.dirname(remote), "other");
  execFileSync("git", ["clone", remote, other], { stdio: "ignore" });
  git(other, ["config", "user.email", "other@agentic.local"]);
  git(other, ["config", "user.name", "Other Clone"]);
  commit(other, "theirs.txt", "theirs\n", "their work");
  git(other, ["push", "origin", "main"]);

  // Before fetching, the local view cannot know it is behind — that is the whole
  // reason the UI has to offer fetch rather than claiming "up to date".
  const before = await readGitTracking(dir);
  assert.equal(before?.behind, 0, "behind is 0 until a fetch updates the remote-tracking ref");

  const fetched = await fetchGitRemote(dir);
  assert.equal(fetched.ok, true, fetched.message);
  assert.match(fetched.message, /1 behind of origin\/main/, "fetch is quiet on success, so it must report the divergence itself");

  const after = await readGitTracking(dir);
  assert.equal(after?.behind, 1);
  assert.equal(after?.ahead, 0);
});

test("pull fast-forwards a behind branch and leaves the tree clean", async () => {
  const { dir, remote } = initWithRemote("pull-ff");
  await pushGitBranch(dir, { allowProtected: true });

  const other = path.join(path.dirname(remote), "other");
  execFileSync("git", ["clone", remote, other], { stdio: "ignore" });
  git(other, ["config", "user.email", "other@agentic.local"]);
  git(other, ["config", "user.name", "Other Clone"]);
  commit(other, "theirs.txt", "theirs\n", "their work");
  git(other, ["push", "origin", "main"]);

  const pulled = await pullGitRemote(dir);

  assert.equal(pulled.ok, true, pulled.message);
  assert.match(pulled.message, /up to date with origin\/main/);
  assert.equal(fs.existsSync(path.join(dir, "theirs.txt")), true, "the pulled commit's file must be in the tree");
  const tracking = await readGitTracking(dir);
  assert.equal(tracking?.ahead, 0);
  assert.equal(tracking?.behind, 0);
});

test("pull refuses on a dirty tree rather than risking local edits", async () => {
  const { dir } = initWithRemote("pull-dirty");
  await pushGitBranch(dir, { allowProtected: true });
  fs.writeFileSync(path.join(dir, "committed.txt"), "work in progress\n");

  const refused = await pullGitRemote(dir);

  assert.equal(refused.ok, false);
  assert.match(refused.message, /Commit or stash them first/);
  assert.equal(
    fs.readFileSync(path.join(dir, "committed.txt"), "utf8"),
    "work in progress\n",
    "the refusal must leave the local edit untouched",
  );
});

test("pull refuses to resolve divergence, naming it rather than starting a merge", async () => {
  const { dir, remote } = initWithRemote("pull-diverged");
  await pushGitBranch(dir, { allowProtected: true });

  const other = path.join(path.dirname(remote), "other");
  execFileSync("git", ["clone", remote, other], { stdio: "ignore" });
  git(other, ["config", "user.email", "other@agentic.local"]);
  git(other, ["config", "user.name", "Other Clone"]);
  commit(other, "theirs.txt", "theirs\n", "their work");
  git(other, ["push", "origin", "main"]);

  commit(dir, "ours.txt", "ours\n", "our work");
  const refused = await pullGitRemote(dir);

  assert.equal(refused.ok, false);
  assert.match(refused.message, /have diverged/);
  assert.match(refused.message, /only fast-forwards/, "the refusal must say why, since git's own wording does not");
  // No merge was started: a half-finished merge with no conflict UI is the state
  // this refusal exists to avoid.
  assert.equal(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD")), false);
});

test("a branch with no upstream is refused by pull with the reason, not a git error dump", async () => {
  const { dir } = initWithRemote("pull-no-upstream");

  const refused = await pullGitRemote(dir);

  assert.equal(refused.ok, false);
  assert.match(refused.message, /main has no upstream to pull from/);
});

test("an unknown remote is rejected before any command runs", async () => {
  const { dir } = initWithRemote("remote-unknown");

  const fetched = await fetchGitRemote(dir, "upstream");
  assert.equal(fetched.ok, false);
  assert.match(fetched.message, /Unknown remote upstream/);

  const plan = await readGitPushPlan(dir, "upstream");
  assert.equal(plan.pushable, false);
  assert.match(plan.reason ?? "", /Unknown remote upstream/);
});

test("a repository with no remote is not pushable and says so", async () => {
  const root = tempDir("remote-none");
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@agentic.local"]);
  git(root, ["config", "user.name", "Agentic Test"]);
  commit(root, "a.txt", "a\n", "only commit");

  const plan = await readGitPushPlan(root);

  assert.equal(plan.pushable, false);
  assert.match(plan.reason ?? "", /No remote is configured/);
  assert.deepEqual(plan.remotes, []);
  assert.equal(plan.branch, "main", "the branch is still reported so the UI can name it in the empty state");
});

test("blame attributes each line to the commit that wrote it", async () => {
  const { dir } = initWithRemote("blame-basic");
  fs.writeFileSync(path.join(dir, "notes.txt"), "first\nsecond\n");
  git(dir, ["add", "notes.txt"]);
  git(dir, ["commit", "-m", "add notes"]);
  const firstCommit = capture(dir, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(dir, "notes.txt"), "first\nsecond\nthird\n");
  git(dir, ["add", "notes.txt"]);
  git(dir, ["commit", "-m", "append third"]);
  const secondCommit = capture(dir, ["rev-parse", "HEAD"]);

  const blame = await readGitBlame(dir, "notes.txt");

  assert.equal(blame.error, undefined);
  assert.equal(blame.lines.length, 3);
  assert.deepEqual(
    blame.lines.map((line) => line.content),
    ["first", "second", "third"],
    "content comes from blame itself, so the view needs no second file read",
  );
  assert.deepEqual(blame.lines.map((line) => line.line), [1, 2, 3]);
  assert.equal(blame.lines[0].hash, firstCommit, "untouched lines keep their original commit");
  assert.equal(blame.lines[2].hash, secondCommit, "the appended line belongs to the later commit");
  assert.equal(blame.lines[2].summary, "append third");
  assert.equal(blame.lines[2].author, "Agentic Test");
  assert.equal(blame.lines[2].shortHash, secondCommit.slice(0, 7));
  assert.match(blame.lines[2].date, /^\d{4}-\d{2}-\d{2}T/, "the date crosses IPC as an ISO string, not a Date");
});

test("blame handles a line that looks like a porcelain header", async () => {
  const { dir } = initWithRemote("blame-lookalike");
  // A source line matching the `<sha> <n> <n>` header shape would derail a parser
  // that does not treat the TAB prefix as the only content marker.
  const lookalike = `${"a".repeat(40)} 1 1`;
  fs.writeFileSync(path.join(dir, "tricky.txt"), `${lookalike}\nreal line\n`);
  git(dir, ["add", "tricky.txt"]);
  git(dir, ["commit", "-m", "tricky content"]);

  const blame = await readGitBlame(dir, "tricky.txt");

  assert.equal(blame.lines.length, 2, "a header-shaped source line must not be swallowed as a header");
  assert.equal(blame.lines[0].content, lookalike);
  assert.equal(blame.lines[1].content, "real line");
});

test("blame refuses paths that escape the repository and files it cannot read", async () => {
  const { dir } = initWithRemote("blame-guards");

  const escaping = await readGitBlame(dir, "../outside.txt");
  assert.deepEqual(escaping.lines, []);
  assert.match(escaping.error ?? "", /Invalid repository path/);

  fs.writeFileSync(path.join(dir, "untracked.txt"), "nothing here\n");
  const untracked = await readGitBlame(dir, "untracked.txt");
  assert.deepEqual(untracked.lines, []);
  assert.ok(untracked.error, "an untracked file has no blame; that must be reported, not returned as zero lines");
});
