import type { WorkflowStepOutcome } from "@contracts";

/** Cap for injected context, so a chatty step cannot blow past CLI arg limits. */
export const CONTEXT_MAX_CHARS = 6000;

/**
 * Placeholders a step instruction may use to receive earlier output:
 *
 * - `{{previous.output}}` — the step that ran immediately before.
 * - `{{steps.<stepId>.output}}` — a specific earlier step, by id.
 * - `{{steps.<name>.output}}` — a specific earlier step, by slugified name.
 *
 * Built per call rather than shared: a `g` regex carries `lastIndex` between uses.
 */
function placeholderPattern(): RegExp {
  return /\{\{\s*(previous|steps\.[A-Za-z0-9_-]+)\.output\s*\}\}/g;
}

export function slugifyStepName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Keeps the tail, which is where CLI output puts its conclusions. */
function clamp(output: string, maxChars = CONTEXT_MAX_CHARS): string {
  const trimmed = output.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `…(earlier output truncated)\n${trimmed.slice(-maxChars)}`;
}

function findOutcome(reference: string, outcomes: WorkflowStepOutcome[]): WorkflowStepOutcome | undefined {
  if (reference === "previous") return outcomes[outcomes.length - 1];

  const key = reference.slice("steps.".length);
  return (
    outcomes.find((outcome) => outcome.stepId === key) ??
    outcomes.find((outcome) => slugifyStepName(outcome.name) === key.toLowerCase())
  );
}

/**
 * Resolves context placeholders in a step instruction against earlier outputs.
 *
 * When the instruction names no placeholder, the previous step's output is
 * appended as a labelled context block instead — so a workflow authored before
 * chaining existed still passes work forward without being edited. A placeholder
 * that matches no step resolves to an explicit "(no output)" marker rather than
 * being left as literal braces for the agent to puzzle over.
 */
export function applyStepContext(
  instruction: string,
  outcomes: WorkflowStepOutcome[],
  maxChars = CONTEXT_MAX_CHARS,
): string {
  const pattern = placeholderPattern();

  if (pattern.test(instruction)) {
    return instruction.replace(placeholderPattern(), (_match, reference: string) => {
      const outcome = findOutcome(reference, outcomes);
      if (!outcome) return "(no output from that step)";
      const body = clamp(outcome.output, maxChars);
      return body || "(that step produced no output)";
    });
  }

  const previous = outcomes[outcomes.length - 1];
  if (!previous) return instruction;

  const body = clamp(previous.output, maxChars);
  if (!body) return instruction;

  return [
    instruction,
    "",
    `--- Context from the previous step "${previous.name}" (${previous.status}) ---`,
    body,
    "--- End of context ---",
  ].join("\n");
}
