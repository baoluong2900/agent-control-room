export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string;
}

export interface GitDiffSummary {
  cwd: string;
  branch: string;
  status: string;
  diffStat: string;
}

