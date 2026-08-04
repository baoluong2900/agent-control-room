import {
  Bell,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Eye,
  FlaskConical,
  GitBranch,
  Play,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type {
  AgentCliId,
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowStepKind,
  WorkflowTriggerType,
} from "@contracts";

export type Accent = "blue" | "cyan" | "purple" | "amber" | "green" | "orange" | "red";

export const stepKindMeta: Record<WorkflowStepKind, { label: string; icon: LucideIcon; accent: Accent }> = {
  trigger: { label: "Trigger", icon: Clock3, accent: "cyan" },
  investigate: { label: "Investigate", icon: Search, accent: "blue" },
  analyze: { label: "Analyze", icon: BrainCircuit, accent: "blue" },
  plan: { label: "Plan", icon: Sparkles, accent: "purple" },
  review: { label: "Review", icon: Eye, accent: "green" },
  execute: { label: "Execute", icon: Play, accent: "amber" },
  test: { label: "Test", icon: FlaskConical, accent: "orange" },
  deploy: { label: "Deploy", icon: Rocket, accent: "orange" },
  notify: { label: "Notify", icon: Bell, accent: "purple" },
  approval: { label: "Approval", icon: ShieldCheck, accent: "amber" },
};

export const stepKinds = Object.keys(stepKindMeta) as WorkflowStepKind[];

export const triggerMeta: Record<WorkflowTriggerType, { label: string; icon: LucideIcon }> = {
  manual: { label: "Manual", icon: Play },
  schedule: { label: "Scheduled", icon: Clock3 },
  "git-push": { label: "On Push", icon: GitBranch },
  "file-change": { label: "On File Change", icon: Workflow },
  "issue-created": { label: "On Issue", icon: Bell },
  webhook: { label: "Webhook", icon: Terminal },
};

export const triggerTypes = Object.keys(triggerMeta) as WorkflowTriggerType[];

export const locallyRunnableTriggerTypes: WorkflowTriggerType[] = ["manual", "schedule", "file-change"];

export const unsupportedTriggerCopy: Partial<Record<WorkflowTriggerType, string>> = {
  "git-push": "Git push needs a Git provider webhook before it can run locally.",
  "issue-created": "Issue-created needs a tracker integration before it can run locally.",
  webhook: "Webhook needs an inbound HTTP listener before it can run locally.",
};

export function isLocallyRunnableTrigger(type: WorkflowTriggerType): boolean {
  return locallyRunnableTriggerTypes.includes(type);
}

export const cliLabels: Record<AgentCliId, string> = {
  claude: "Claude",
  kiro: "Kiro",
  codex: "Codex",
  gemini: "Gemini",
  agy: "Agy",
  grok: "Grok",
  amazonq: "Amazon Q",
  aider: "Aider",
  opencode: "OpenCode",
  cursor: "Cursor",
  copilot: "Copilot",
  qwen: "Qwen",
  ollama: "Ollama",
  shell: "Shell",
  custom: "Custom",
};

export const cliOptions = Object.keys(cliLabels) as AgentCliId[];

export const statusMeta: Record<WorkflowStatus, { label: string; accent: Accent }> = {
  active: { label: "Active", accent: "green" },
  paused: { label: "Paused", accent: "amber" },
  draft: { label: "Draft", accent: "blue" },
  error: { label: "Error", accent: "red" },
};

export const runStatusMeta: Record<WorkflowRunStatus, { label: string; accent: Accent; icon: LucideIcon }> = {
  queued: { label: "Queued", accent: "blue", icon: Clock3 },
  running: { label: "Running", accent: "cyan", icon: Play },
  "waiting-approval": { label: "Waiting", accent: "amber", icon: ShieldCheck },
  success: { label: "Success", accent: "green", icon: CheckCircle2 },
  failed: { label: "Failed", accent: "red", icon: Bell },
  cancelled: { label: "Cancelled", accent: "amber", icon: Bell },
};

export function formatDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function formatRelative(input?: string | null): string {
  if (!input) return "—";
  // Pass through friendly strings like "2 min ago" used by seed data.
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) return input;

  const deltaMs = Date.now() - parsed;
  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(parsed).toLocaleDateString();
}

export function formatDate(input?: string | null): string {
  if (!input) return "—";
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) return input;
  return new Date(parsed).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
