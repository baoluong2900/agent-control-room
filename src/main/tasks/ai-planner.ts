import { spawn } from "node:child_process";
import process from "node:process";
import type { AgentCliId, KnowledgeSnapshot, TaskDifficulty } from "@contracts";
import { buildInvocation } from "../agents/commands";

/**
 * Optional LLM-backed task planning.
 *
 * The template planner is deliberately still the default: it is instant,
 * deterministic, needs no credentials, and works offline. This path trades all of
 * that for a plan that has actually seen the project, so it is opt-in per request.
 *
 * The hard part is not prompting, it is refusing to trust the answer. Every failure
 * mode here — no CLI, timeout, non-zero exit, prose instead of JSON, JSON of the
 * wrong shape, steps naming CLIs that do not exist — has to end in the caller
 * falling back to the template plan with a stated reason, never in an empty plan.
 */

/** One step as proposed by the model, after validation. */
export interface AiPlanStep {
  title: string;
  directive: string;
  cliId?: AgentCliId;
}

export interface AiPlanOutcome {
  steps: AiPlanStep[];
  difficulty?: TaskDifficulty;
  /** Raw model output, kept for diagnostics when validation fails. */
  raw: string;
}

export interface AiPlanRequest {
  request: string;
  cwd: string;
  /** `shell` and `custom` are excluded: neither can answer a planning prompt. */
  cliId: Exclude<AgentCliId, "shell" | "custom">;
  model?: string;
  availableCliIds: AgentCliId[];
  snapshot?: KnowledgeSnapshot | null;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * A planning call must not hang a user waiting on a spinner. 90s is generous for a
 * single structured completion and still bounded.
 */
const DEFAULT_TIMEOUT_MS = 90_000;

/** Cap on plan size: beyond this the model is padding, not planning. */
const MAX_STEPS = 8;

const DIFFICULTIES: TaskDifficulty[] = ["small", "medium", "large", "epic"];

/**
 * Asks an agent CLI for a plan and returns it only if it validates.
 *
 * Throws on every failure path. The caller is expected to catch and fall back —
 * that is the contract, and it is why nothing here tries to repair a bad answer.
 */
export async function requestAiPlan(input: AiPlanRequest): Promise<AiPlanOutcome> {
  const prompt = buildPlannerPrompt(input);
  const invocation = await buildInvocation({
    cliId: input.cliId,
    cwd: input.cwd,
    prompt,
    model: input.model,
    // One-shot and headless: no TTY, no interactive session.
    uiMode: "terminal",
  });

  const raw = await runOnce({
    executable: invocation.executable,
    args: invocation.args,
    stdinPrompt: invocation.stdinPrompt ?? prompt,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: input.env,
  });

  return parseAiPlan(raw, input.availableCliIds);
}

/**
 * Extracts and validates a plan from raw CLI output.
 *
 * Exported for tests: this is where most of the risk lives, and it must be
 * verifiable without spawning anything.
 */
export function parseAiPlan(raw: string, availableCliIds: AgentCliId[]): AiPlanOutcome {
  const payload = extractJsonObject(raw);
  if (!payload) throw new Error("Planner output contained no JSON object.");

  const stepsValue = (payload as { steps?: unknown }).steps;
  if (!Array.isArray(stepsValue)) throw new Error("Planner output has no `steps` array.");

  const available = new Set(availableCliIds);
  const steps: AiPlanStep[] = [];

  for (const entry of stepsValue) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const directive = typeof record.directive === "string" ? record.directive.trim() : "";
    if (!title || !directive) continue;

    // A model will happily propose a CLI that is not installed. Dropping the
    // suggestion (rather than the step) lets the existing role-based resolution
    // assign something real.
    const proposed = typeof record.cliId === "string" ? (record.cliId.trim().toLowerCase() as AgentCliId) : undefined;
    const cliId = proposed && available.has(proposed) ? proposed : undefined;

    steps.push({ title: title.slice(0, 80), directive: directive.slice(0, 600), cliId });
    if (steps.length >= MAX_STEPS) break;
  }

  if (steps.length === 0) throw new Error("Planner output had no usable steps.");

  const difficultyValue = (payload as { difficulty?: unknown }).difficulty;
  const difficulty =
    typeof difficultyValue === "string" && DIFFICULTIES.includes(difficultyValue as TaskDifficulty)
      ? (difficultyValue as TaskDifficulty)
      : undefined;

  return { steps, difficulty, raw };
}

/**
 * Finds a JSON object in text that may also contain prose or a fenced block.
 *
 * Models wrap JSON in ```json fences, prefix it with "Here's the plan:", or emit it
 * as one object among several lines. Brace-matching from the first `{` handles all
 * three without a fragile regex, and it ignores braces inside string literals so a
 * directive containing `}` cannot truncate the parse.
 */
export function extractJsonObject(raw: string): unknown | null {
  const text = raw.trim();
  if (!text) return null;

  // Prefer a fenced block when present: it is the model being explicit.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1], text] : [text];

  for (const candidate of candidates) {
    const parsed = firstJsonObject(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstJsonObject(text: string): unknown | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1));
          } catch {
            // Not valid JSON after all; try the next opening brace.
            break;
          }
        }
      }
    }
  }
  return null;
}

/** Builds the planner prompt, including project context when a snapshot exists. */
export function buildPlannerPrompt(input: {
  request: string;
  availableCliIds: AgentCliId[];
  snapshot?: KnowledgeSnapshot | null;
}): string {
  const agents = input.availableCliIds.filter((cliId) => cliId !== "custom");
  const lines = [
    "You are planning a software task. Return ONLY a JSON object, no prose, no markdown fence.",
    "",
    "Schema:",
    '{"difficulty":"small|medium|large|epic","steps":[{"title":"short label","directive":"what to do","cliId":"one of the available agents"}]}',
    "",
    `Rules: between 2 and ${MAX_STEPS} steps. Each directive is one actionable instruction.`,
    `Available agents (use only these ids): ${agents.join(", ") || "shell"}.`,
    "Use \"shell\" for steps that run commands or tests.",
    "",
    "Task request:",
    input.request,
  ];

  const context = projectContext(input.snapshot);
  if (context) {
    lines.push("", "Project context (from the indexed code graph):", context);
  } else {
    // Said explicitly so the model does not invent file paths it was never shown.
    lines.push("", "No project index is available. Do not invent file paths.");
  }

  return lines.join("\n");
}

/** A compact project summary: enough to ground the plan, small enough to send. */
function projectContext(snapshot?: KnowledgeSnapshot | null): string | null {
  if (!snapshot || snapshot.files.length === 0) return null;

  const languages = snapshot.languages
    .slice(0, 4)
    .map((entry) => `${entry.language} (${entry.files} files)`)
    .join(", ");
  const categories = snapshot.categories
    .slice(0, 6)
    .map((entry) => `${entry.category} (${entry.files})`)
    .join(", ");

  // Most-connected files first: they are the ones a plan most likely has to touch.
  const edgeCounts = new Map<string, number>();
  const pathById = new Map<string, string>();
  for (const node of snapshot.graph.nodes) {
    if (node.kind === "file" && node.path) pathById.set(node.id, node.path);
  }
  for (const edge of snapshot.graph.edges) {
    for (const endpoint of [edge.source, edge.target]) {
      const filePath = pathById.get(endpoint);
      if (filePath) edgeCounts.set(filePath, (edgeCounts.get(filePath) ?? 0) + 1);
    }
  }

  const central = [...edgeCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([filePath]) => filePath);

  const lines = [
    `Project: ${snapshot.projectName} (${snapshot.indexedFiles} files indexed)`,
    languages ? `Languages: ${languages}` : "",
    categories ? `Areas: ${categories}` : "",
    central.length ? `Central files: ${central.join(", ")}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

/** Runs a CLI once, captures stdout, and enforces a timeout. Never leaks a child. */
function runOnce(params: {
  executable: string;
  args: string[];
  stdinPrompt: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(params.executable, params.args, {
        cwd: params.cwd,
        env: { ...process.env, ...params.env },
        windowsHide: true,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      // Kill before rejecting: a planning call that timed out must not leave a CLI
      // running against the user's project.
      child.kill(process.platform === "win32" ? undefined : "SIGKILL");
      settle(() => reject(new Error(`Planner timed out after ${params.timeoutMs}ms.`)));
    }, params.timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) => {
      settle(() => {
        // Some CLIs write the answer to stdout and diagnostics to stderr while
        // still exiting non-zero, so usable stdout wins over the exit code.
        if (stdout.trim()) resolve(stdout);
        else reject(new Error(`Planner exited with code ${code ?? "unknown"}: ${stderr.trim().slice(0, 300)}`));
      });
    });

    if (params.stdinPrompt && child.stdin?.writable) {
      child.stdin.write(`${params.stdinPrompt}\n`);
      child.stdin.end();
    }
  });
}
