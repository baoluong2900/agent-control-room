import assert from "node:assert/strict";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { buildAgentPath, ensureAgentPath } from "../src/main/agents/path-env.ts";
import { getAgentDescriptor } from "../src/main/agents/catalog.ts";

const isPosix = process.platform !== "win32";

test("keeps the inherited PATH entries and their order", () => {
  const inherited = ["/usr/bin", "/bin"].join(delimiter);
  const resolved = buildAgentPath(inherited).split(delimiter);

  assert.equal(resolved[0], "/usr/bin");
  assert.equal(resolved[1], "/bin");
});

test("never emits duplicate entries", () => {
  const inherited = ["/usr/bin", "/bin", "/usr/bin"].join(delimiter);
  const resolved = buildAgentPath(inherited).split(delimiter);

  assert.equal(new Set(resolved).size, resolved.length);
});

test("recovers the Finder-launch case by appending known install roots", { skip: !isPosix }, () => {
  // What Electron actually inherits when the .app is opened from Finder/Dock.
  const minimal = "/usr/bin:/bin:/usr/sbin:/sbin";
  const resolved = buildAgentPath(minimal).split(delimiter);
  const localBin = join(homedir(), ".local", "bin");

  // Only assert on roots that exist on this machine; buildAgentPath filters
  // missing directories on purpose so spawn() never sees dead entries.
  const expected = [localBin, "/opt/homebrew/bin", "/usr/local/bin"].filter((dir) =>
    process.env.PATH?.split(delimiter).includes(dir),
  );

  for (const dir of expected) {
    assert.ok(resolved.includes(dir), `expected ${dir} to be recovered`);
  }
});

test("drops empty segments", () => {
  const resolved = buildAgentPath(["/usr/bin", "", "  ", "/bin"].join(delimiter)).split(delimiter);
  assert.ok(!resolved.includes(""));
});

test("ensureAgentPath writes the resolved PATH back to the environment", () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin";
    const resolved = ensureAgentPath();
    assert.equal(process.env.PATH, resolved);
    assert.ok(resolved.split(delimiter).includes("/usr/bin"));
  } finally {
    process.env.PATH = original;
  }
});

test("agy descriptor can list its own models", () => {
  const agy = getAgentDescriptor("agy");
  assert.deepEqual(agy.modelListArgs, ["models"]);
  assert.equal(agy.promptFlag, "-p");
  assert.equal(agy.promptMode, "flag");
});

test("claude descriptor targets the real binary name, not claude-cli", () => {
  const claude = getAgentDescriptor("claude");
  assert.ok(claude.commandCandidates.includes("claude"));
  assert.ok(!claude.commandCandidates.includes("claude-cli"));
  assert.deepEqual(claude.baseArgs, ["-p"]);
});

test("codex runs one-shot prompts through `codex exec`", () => {
  const codex = getAgentDescriptor("codex");
  assert.deepEqual(codex.baseArgs, ["exec"]);
  assert.equal(codex.modelFlag, "-m");
  assert.equal(codex.promptMode, "arg");
});
