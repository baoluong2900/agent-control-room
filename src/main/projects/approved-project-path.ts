import fs from "node:fs";
import path from "node:path";
import type { ProjectSummary } from "@contracts";

/**
 * Resolves a renderer-supplied cwd to a project selected through the native folder
 * picker. Realpath comparison prevents a symlink alias from bypassing the list.
 */
export function requireApprovedProjectPath(projectPath: string, approvedProjects: ProjectSummary[]): string {
  const requested = canonicalProjectPath(projectPath);
  const approved = approvedProjects.some((project) => canonicalProjectPath(project.path) === requested);
  if (!approved) {
    throw new Error("Git operations are limited to projects selected in Agentic Workspace.");
  }
  return requested;
}

export function canonicalProjectPath(value: string): string {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}
