import {
  BookOpenText,
  Bot,
  Boxes,
  CircleGauge,
  Gauge,
  LayoutDashboard,
  Network,
  Settings2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ZoneId } from "./map/scene-config";

export type WorkspaceNavKey =
  | "Overview"
  | "Agents"
  | "Projects"
  | "Workflows"
  | "Tasks"
  | "Knowledge"
  | "Integrations"
  | "Analytics"
  | "Settings";

export type WorkspaceNavigationItem = {
  key: WorkspaceNavKey;
  label: string;
  icon: LucideIcon;
  summary: string;
};

export const workspaceNavigation: WorkspaceNavigationItem[] = [
  {
    key: "Overview",
    label: "Overview",
    icon: LayoutDashboard,
    summary: "AI agent command center",
  },
  {
    key: "Agents",
    label: "Agents",
    icon: Bot,
    summary: "Agent fleet, profiles, terminals",
  },
  {
    key: "Projects",
    label: "Projects",
    icon: Boxes,
    summary: "Local workspace and Git context",
  },
  {
    key: "Workflows",
    label: "Workflows",
    icon: Workflow,
    summary: "Workflow engine and approvals",
  },
  {
    key: "Tasks",
    label: "Tasks",
    icon: CircleGauge,
    summary: "Mission board and scheduler",
  },
  {
    key: "Knowledge",
    label: "Knowledge",
    icon: BookOpenText,
    summary: "CodeGraph and agent context",
  },
  {
    key: "Integrations",
    label: "Integrations",
    icon: Network,
    summary: "Providers, CLIs, proxy endpoints",
  },
  {
    key: "Analytics",
    label: "Analytics",
    icon: Gauge,
    summary: "Runs, throughput, efficiency",
  },
  {
    key: "Settings",
    label: "Settings",
    icon: Settings2,
    summary: "Account and provider access",
  },
];

export const workspaceNavKeys = workspaceNavigation.map((item) => item.key);

export const workspaceNavByKey = new Map<WorkspaceNavKey, WorkspaceNavigationItem>(
  workspaceNavigation.map((item) => [item.key, item]),
);

export const overviewZoneNavigation: Record<ZoneId, WorkspaceNavKey> = {
  code: "Tasks",
  deployment: "Workflows",
  documents: "Knowledge",
  engine: "Workflows",
  monitoring: "Analytics",
  planning: "Tasks",
  testing: "Tasks",
};

export function isWorkspaceNavKey(value: string): value is WorkspaceNavKey {
  return workspaceNavByKey.has(value as WorkspaceNavKey);
}

export function navForOverviewZone(zone: string): WorkspaceNavigationItem {
  const key = overviewZoneNavigation[zone as ZoneId] ?? "Overview";
  return workspaceNavByKey.get(key) ?? workspaceNavigation[0];
}
