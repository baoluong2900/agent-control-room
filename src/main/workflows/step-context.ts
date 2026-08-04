import type { WorkflowStepOutcome } from "@contracts";

/** Cap for injected context, so a chatty step cannot blow past CLI arg limits. */
export const CONTEXT_MAX_CHARS = 6000;

export type StepContextOptions = {
  maxChars?: number;
  /**
   * Append the previous step's output when the text contains no placeholder.
   *
   * True for an agent instruction: it is a prompt, so extra context helps and a
   * workflow authored before chaining existed starts passing work forward with no
   * edits. False for a shell command: that is code, and appending prose to it
   * produces lines the shell tries to execute.
   */
  appendWhenNoPlaceholder?: boolean;
};

/**
 * Placeholders a step may use to receive earlier output:
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
function clamp(output: string, maxChars: number): string {
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
 * Resolves context placeholders against the outputs of earlier steps.
 *
 * A placeholder that matches no step resolves to an explicit "(no output)" marker
 * rather than being left as literal braces for an agent to puzzle over.
 *
 * Note that a placeholder inside a shell command interpolates one process's
 * output into another's command line. That is the point of the feature, but it
 * means the author is responsible for quoting it — the same care any shell
 * variable needs.
 */
export function applyStepContext(
  text: string,
  outcomes: WorkflowStepOutcome[],
  options: StepContextOptions = {},
): string {
  const maxChars = options.maxChars ?? CONTEXT_MAX_CHARS;
  const appendWhenNoPlaceholder = options.appendWhenNoPlaceholder ?? true;

  if (placeholderPattern().test(text)) {
    return text.replace(placeholderPattern(), (_match, reference: string) => {
      const outcome = findOutcome(reference, outcomes);
      if (!outcome) return "(no output from that step)";
      return clamp(outcome.output, maxChars) || "(that step produced no output)";
    });
  }

  if (!appendWhenNoPlaceholder) return text;

  const previous = outcomes[outcomes.length - 1];
  if (!previous) return text;

  const body = clamp(previous.output, maxChars);
  if (!body) return text;

  return [
    text,
    "",
    `--- Context from the previous step "${previous.name}" (${previous.status}) ---`,
    body,
    "--- End of context ---",
  ].join("\n");
}
