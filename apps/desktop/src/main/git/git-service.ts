import { spawn } from "node:child_process";
import type { GitDiffSummary } from "@contracts";

export async function readGitDiff(cwd: string): Promise<GitDiffSummary> {
  const [branch, status, diffStat] = await Promise.all([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["status", "--short"]),
    git(cwd, ["diff", "--stat"]),
  ]);

  return {
    cwd,
    branch: branch.trim() || "detached",
    status: status.trim() || "Clean working tree",
    diffStat: diffStat.trim() || "No unstaged diff",
  };
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => resolve(error.message));
    child.on("exit", () => resolve(output));
  });
}

