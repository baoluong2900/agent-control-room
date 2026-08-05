import type {
  AgentCliId,
  TaskDifficulty,
  TaskPlanInput,
  TaskPlanSummary,
  TaskRecord,
  TaskSaveInput,
} from "@contracts";

type PlannerStep = {
  title: string;
  directive: string;
  assignedCliId: AgentCliId;
  weight: number;
};

export type TaskPlanDraft = {
  parent: TaskSaveInput;
  subtasks: TaskSaveInput[];
  summary: TaskPlanSummary;
};

const complexityKeywords = [
  "automation",
  "automatic",
  "database",
  "deadline",
  "deployment",
  "e2e",
  "electron",
  "ipc",
  "migration",
  "multi-agent",
  "schedule",
  "scheduler",
  "sqlite",
  "workflow",
];

const defaultModelByCli: Record<AgentCliId, string> = {
  claude: "sonnet",
  kiro: "claude-sonnet-4-5",
  codex: "gpt-5-codex",
  gemini: "gemini-2.5-pro",
  agy: "default",
  grok: "grok-4.5",
  amazonq: "default",
  aider: "default",
  opencode: "default",
  cursor: "default",
  copilot: "default",
  qwen: "default",
  ollama: "default",
  shell: "none",
  custom: "default",
};

/**
 * Ranked CLI preferences per planner role.
 *
 * The planner used to hardcode one CLI per step regardless of what was installed,
 * so a plan could contain steps that simply could not run and the user only found
 * out when they failed. These lists are preference order, not requirements: the
 * first installed candidate wins, and `shell` is the universal last resort because
 * it is always available.
 */
/**
 * Steps supplied by the AI planner instead of the template.
 *
 * Kept structural rather than importing from `ai-planner` so the template path has
 * no dependency on the LLM path — the default plan must stay buildable in isolation.
 */
export type AiPlanOverride = {
  steps: Array<{ title: string; directive: string; cliId?: AgentCliId }>;
  difficulty?: TaskDifficulty;
};

const rolePreferences: Record<string, AgentCliId[]> = {
  Investigate: ["kiro", "claude", "codex", "gemini", "cursor", "copilot"],
  Analyze: ["gemini", "claude", "codex", "kiro", "cursor"],
  Plan: ["claude", "codex", "gemini", "kiro", "cursor"],
  Execute: ["codex", "claude", "cursor", "kiro", "gemini", "aider"],
  Review: ["claude", "codex", "gemini", "kiro", "cursor"],
  Verify: ["shell"],
};

/**
 * Picks a CLI for a role, honouring what is installed.
 *
 * `available` of `undefined` means "caller did not tell us", which keeps the old
 * behaviour: take the intended CLI as-is. An empty set means "we checked and found
 * nothing", which is different and must fall back to `shell`.
 */
function resolveCliForRole(
  role: string,
  intended: AgentCliId,
  available: Set<AgentCliId> | undefined,
  reassigned: string[],
): AgentCliId {
  if (!available) return intended;
  if (available.has(intended)) return intended;

  const candidates = rolePreferences[role] ?? [];
  for (const candidate of candidates) {
    if (available.has(candidate)) {
      reassigned.push(`${role}: ${intended} -> ${candidate}`);
      return candidate;
    }
  }

  // Nothing suitable for this role: anything else installed beats a dead step.
  for (const candidate of available) {
    if (candidate !== "custom") {
      reassigned.push(`${role}: ${intended} -> ${candidate}`);
      return candidate;
    }
  }

  reassigned.push(`${role}: ${intended} -> shell`);
  return "shell";
}

export function buildTaskPlan(input: TaskPlanInput, aiPlan?: AiPlanOverride): TaskPlanDraft {
  const request = input.request.trim();
  if (!request) throw new Error("Task request is required.");

  const title = input.title?.trim() || titleFromRequest(request);
  // A model that has read the project is a better difficulty judge than a word
  // count, but the heuristic still supplies the estimate scale.
  const difficulty = aiPlan?.difficulty ?? estimateDifficulty(request);
  const estimatedMinutes = estimateMinutes(request, difficulty);

  const available = input.availableCliIds ? new Set(input.availableCliIds) : undefined;
  // A preferred CLI the machine does not have is not a preference, it is a broken
  // step; drop it so role resolution can pick something real.
  const preferred =
    input.preferredCliId && (!available || available.has(input.preferredCliId)) ? input.preferredCliId : undefined;
  const reassignedSteps: string[] = [];

  // AI steps go through exactly the same availability resolution as template ones:
  // a model suggesting an uninstalled CLI must not reintroduce dead steps.
  const plannedSteps: PlannerStep[] = aiPlan
    ? aiPlan.steps.map((step): PlannerStep => ({
        title: step.title,
        directive: step.directive,
        assignedCliId: step.cliId ?? preferred ?? "codex",
        weight: 1,
      }))
    : plannerStepsFor(difficulty, preferred);

  const steps = plannedSteps.map((step) => ({
    ...step,
    assignedCliId: resolveCliForRole(step.title, step.assignedCliId, available, reassignedSteps),
  }));

  const automationEnabled = Boolean(input.dueAt) && input.automationEnabled !== false;
  const dueAt = normalizeIso(input.dueAt);
  const agentCount = new Set(steps.map((step) => step.assignedCliId)).size;

  // `shell` is always installed, so "no agents" means no *agent* CLI, not literally
  // nothing. Reported separately because it changes what the plan can be trusted to do.
  const noAgentsAvailable = Boolean(
    available && [...available].every((cliId) => cliId === "shell" || cliId === "custom"),
  );
  const parentCli = preferred ?? steps.find((step) => step.title === "Execute")?.assignedCliId ?? "shell";

  const parent: TaskSaveInput = {
    projectPath: input.projectPath ?? null,
    title,
    prompt: request,
    status: "open",
    assignedCliId: parentCli,
    assignedModel: input.model?.trim() || defaultModelForCli(parentCli),
    dueAt,
    difficulty,
    estimatedMinutes,
    automationEnabled: false,
  };

  const subtasks = steps.map((step, index) => {
    const assignedModel =
      preferred && step.assignedCliId === preferred
        ? input.model?.trim() || defaultModelForCli(step.assignedCliId)
        : defaultModelForCli(step.assignedCliId);

    return {
      projectPath: input.projectPath ?? null,
      title: `${step.title}: ${title}`,
      prompt: subtaskPrompt({
        originalRequest: request,
        step,
        order: index + 1,
        total: steps.length,
        difficulty,
        finalDueAt: dueAt,
      }),
      status: "open" as const,
      assignedCliId: step.assignedCliId,
      assignedModel,
      dueAt: dueForStep(dueAt, index, steps.length),
      difficulty,
      estimatedMinutes: Math.max(5, Math.round((estimatedMinutes * step.weight) / totalWeight(steps))),
      automationEnabled,
    };
  });

  return {
    parent,
    subtasks,
    summary: {
      difficulty,
      estimatedMinutes,
      agentCount,
      subtaskCount: subtasks.length,
      source: aiPlan ? "ai" : "template",
      ...(noAgentsAvailable ? { noAgentsAvailable: true } : {}),
      ...(reassignedSteps.length > 0 ? { reassignedSteps } : {}),
    },
  };
}

export function buildScheduledTaskPrompt(task: TaskRecord): string {
  const dueLine = task.dueAt ? `Scheduled due time: ${task.dueAt}` : "Scheduled due time: not set";
  const difficultyLine = task.difficulty ? `Difficulty: ${task.difficulty}` : "Difficulty: not scored";
  const estimateLine = task.estimatedMinutes ? `Estimate: ${task.estimatedMinutes} minutes` : "Estimate: not set";
  const parentLine = task.parentTaskId ? `Parent task: ${task.parentTaskId}` : "Parent task: none";

  return [
    "You are executing a scheduled task from Agentic Workspace.",
    dueLine,
    difficultyLine,
    estimateLine,
    parentLine,
    "",
    "Task title:",
    task.title,
    "",
    "Task prompt:",
    task.prompt,
    "",
    "Return concise output with:",
    "1. Completed work or investigation result.",
    "2. Files, commands, or decisions touched.",
    "3. Remaining subtasks or blockers, if any.",
  ].join("\n");
}

export function buildShellScheduledTaskOutput(task: TaskRecord): string {
  return [
    `Scheduled task: ${task.title}`,
    `Status: queued for ${task.assignedCliId ?? "shell"}`,
    task.dueAt ? `Due: ${task.dueAt}` : "Due: not set",
    task.difficulty ? `Difficulty: ${task.difficulty}` : "Difficulty: not scored",
    "",
    task.prompt,
  ].join("\n");
}

export function estimateDifficulty(request: string): TaskDifficulty {
  const words = request.trim().split(/\s+/).filter(Boolean).length;
  const lower = request.toLowerCase();
  const keywordHits = complexityKeywords.filter((keyword) => lower.includes(keyword)).length;
  const sentenceCount = request.split(/[.!?\n]+/).filter((part) => part.trim().length > 0).length;
  const score = Math.ceil(words / 24) + keywordHits + Math.max(0, sentenceCount - 2);

  if (score <= 2) return "small";
  if (score <= 4) return "medium";
  if (score <= 7) return "large";
  return "epic";
}

export function defaultModelForCli(cliId: AgentCliId): string {
  return defaultModelByCli[cliId] ?? "default";
}

function plannerStepsFor(difficulty: TaskDifficulty, preferredCliId?: AgentCliId): PlannerStep[] {
  const implementCli = preferredCliId ?? "codex";
  const base: PlannerStep[] = [
    {
      title: "Investigate",
      directive: "Map ownership, affected files, constraints, and risks before any change.",
      assignedCliId: "kiro",
      weight: 1,
    },
    {
      title: "Plan",
      directive: "Break the request into concrete implementation steps with acceptance checks.",
      assignedCliId: "claude",
      weight: 1,
    },
    {
      title: "Execute",
      directive: "Implement the smallest coherent slice and keep changes scoped to the request.",
      assignedCliId: implementCli,
      weight: 2,
    },
    {
      title: "Verify",
      directive: "Run focused validation, capture failures, and identify missing tests or commands.",
      assignedCliId: "shell",
      weight: 1,
    },
  ];

  if (difficulty === "small") return base.slice(1);
  if (difficulty === "medium") return base;

  const review: PlannerStep = {
    title: "Review",
    directive: "Review output for regressions, edge cases, and follow-up tasks before marking complete.",
    assignedCliId: "claude",
    weight: 1,
  };

  if (difficulty === "large") return [...base, review];

  return [
    base[0],
    {
      title: "Analyze",
      directive: "Model dependencies, unknowns, sequencing, and likely task difficulty before implementation.",
      assignedCliId: "gemini",
      weight: 1,
    },
    ...base.slice(1),
    review,
  ];
}

function subtaskPrompt(params: {
  originalRequest: string;
  step: PlannerStep;
  order: number;
  total: number;
  difficulty: TaskDifficulty;
  finalDueAt?: string | null;
}): string {
  return [
    `Scheduled subtask ${params.order}/${params.total}: ${params.step.title}`,
    `Difficulty: ${params.difficulty}`,
    params.finalDueAt ? `Final deadline: ${params.finalDueAt}` : "Final deadline: not set",
    "",
    "Original request:",
    params.originalRequest,
    "",
    "Subtask directive:",
    params.step.directive,
    "",
    "Output contract:",
    "- State what was completed.",
    "- List concrete files, commands, or evidence.",
    "- Name blockers and next subtasks if work cannot proceed.",
  ].join("\n");
}

function dueForStep(dueAt: string | null | undefined, index: number, total: number): string | null {
  if (!dueAt) return null;
  const dueMs = Date.parse(dueAt);
  if (!Number.isFinite(dueMs)) return dueAt;

  const now = Date.now();
  if (dueMs <= now) return new Date(dueMs).toISOString();

  const slotMs = (dueMs - now) / total;
  return new Date(now + slotMs * (index + 1)).toISOString();
}

function estimateMinutes(request: string, difficulty: TaskDifficulty): number {
  const words = request.trim().split(/\s+/).filter(Boolean).length;
  const base: Record<TaskDifficulty, number> = {
    small: 25,
    medium: 60,
    large: 140,
    epic: 260,
  };
  return base[difficulty] + Math.min(120, Math.max(0, words - 20));
}

function titleFromRequest(request: string): string {
  const compact = request.replace(/\s+/g, " ").trim();
  const firstClause = compact.split(/[.!?\n]/)[0]?.trim() || compact;
  const title = firstClause.slice(0, 72).replace(/[,;:]$/, "");
  return title || "Scheduled task";
}

function totalWeight(steps: PlannerStep[]): number {
  return steps.reduce((sum, step) => sum + step.weight, 0) || 1;
}

function normalizeIso(value?: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}
