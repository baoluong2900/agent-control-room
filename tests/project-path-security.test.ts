import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { requireApprovedProjectPath } from "../src/main/projects/approved-project-path.ts";

function setup(label: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agentic-${label}-`)));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath);
  const approved = [{
    id: "approved-project",
    name: "project",
    path: projectPath,
    lastOpenedAt: new Date().toISOString(),
  }];
  return { approved, projectPath, root };
}

test("Git IPC paths are limited to projects selected by the user", () => {
  const { approved, projectPath, root } = setup("project-allowlist");

  assert.equal(requireApprovedProjectPath(projectPath, approved), fs.realpathSync(projectPath));
  assert.throws(
    () => requireApprovedProjectPath(root, approved),
    /limited to projects selected/,
    "the parent folder is not approved merely because it contains an approved project",
  );
  assert.throws(() => requireApprovedProjectPath(os.homedir(), approved), /limited to projects selected/);
});

test("a symlink alias resolves to the same approved project, not an allowlist bypass", () => {
  const { approved, projectPath, root } = setup("project-symlink");
  const alias = path.join(root, "project-alias");
  fs.symlinkSync(projectPath, alias);

  assert.equal(requireApprovedProjectPath(alias, approved), fs.realpathSync(projectPath));

  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  const outsideAlias = path.join(root, "outside-alias");
  fs.symlinkSync(outside, outsideAlias);
  assert.throws(() => requireApprovedProjectPath(outsideAlias, approved), /limited to projects selected/);
});

test("an empty recent-project list revokes the Git capability", () => {
  const { projectPath } = setup("project-revoke");
  assert.throws(() => requireApprovedProjectPath(projectPath, []), /limited to projects selected/);
});
