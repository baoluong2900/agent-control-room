import path from "node:path";
import { randomUUID } from "node:crypto";
import { dialog } from "electron";
import type { ProjectSummary } from "@contracts";
import type { DesktopDatabase } from "../database/desktop-database";
import { requireApprovedProjectPath } from "./approved-project-path";

export class ProjectService {
  constructor(private readonly db: DesktopDatabase) {}

  async selectFolder(): Promise<ProjectSummary | null> {
    const result = await dialog.showOpenDialog({
      title: "Select project folder",
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const projectPath = result.filePaths[0];
    const project: ProjectSummary = {
      id: randomUUID(),
      name: path.basename(projectPath),
      path: projectPath,
      lastOpenedAt: new Date().toISOString(),
    };

    this.db.createOrUpdateProject(project);
    return project;
  }

  listRecent(): ProjectSummary[] {
    return this.db.listRecentProjects();
  }

  /**
   * Resolves one renderer-supplied cwd to a project the user selected through the
   * native folder picker. Destructive Git handlers must not accept an arbitrary
   * directory merely because renderer code supplied that string.
   */
  requireApprovedPath(projectPath: string): string {
    return requireApprovedProjectPath(projectPath, this.db.listRecentProjects());
  }

  /** Drops a folder from the recent list without touching run history or tasks. */
  remove(projectPath: string): ProjectSummary[] {
    this.db.removeProject(projectPath);
    return this.db.listRecentProjects();
  }
}

