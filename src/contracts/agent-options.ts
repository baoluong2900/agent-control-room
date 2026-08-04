import type { AgentCliDescriptor, AgentCliOption, AgentOptionValue, AgentOptionValues } from "./agent";

export interface AgentOptionArgContext {
  interactive?: boolean;
}

function optionApplies(option: AgentCliOption, context: AgentOptionArgContext): boolean {
  const appliesTo = option.appliesTo ?? "both";
  if (appliesTo === "both") return true;
  return appliesTo === (context.interactive ? "interactive" : "oneshot");
}

function normalizeListValue(value: AgentOptionValue): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function optionValue(option: AgentCliOption, values?: AgentOptionValues): AgentOptionValue | undefined {
  const selected = values?.[option.id];
  return selected ?? option.defaultValue;
}

function pushFlag(args: string[], option: AgentCliOption, value?: string): void {
  if (value !== undefined && option.joinWithEquals) {
    args.push(`${option.flag}=${value}`);
    return;
  }
  args.push(option.flag);
  if (value !== undefined) args.push(value);
}

function assertStringValue(option: AgentCliOption, value: AgentOptionValue): string {
  if (typeof value !== "string") {
    throw new Error(`${option.label} must be a text value.`);
  }
  return value.trim();
}

/**
 * Converts a profile/run's declared option values into CLI argv. Unknown values are
 * ignored; malformed known values throw so broken profiles fail before spawning.
 */
export function buildOptionArgs(
  descriptor: Pick<AgentCliDescriptor, "displayName" | "options">,
  values: AgentOptionValues | undefined,
  context: AgentOptionArgContext = {},
): string[] {
  const args: string[] = [];
  for (const option of descriptor.options ?? []) {
    if (!optionApplies(option, context)) continue;
    const value = optionValue(option, values);
    if (value === undefined || value === false || value === "") continue;

    if (option.kind === "toggle") {
      if (typeof value !== "boolean") {
        throw new Error(`${option.label} must be on or off.`);
      }
      if (!value) continue;
      if (option.valueless) pushFlag(args, option);
      else pushFlag(args, option, "true");
      continue;
    }

    if (option.kind === "list") {
      const entries = normalizeListValue(value);
      if (!entries.length) continue;
      if (option.repeatable) {
        for (const entry of entries) pushFlag(args, option, entry);
      } else {
        pushFlag(args, option, entries.join(","));
      }
      continue;
    }

    const text = assertStringValue(option, value);
    if (!text) continue;

    if (option.kind === "select") {
      const allowed = new Set((option.choices ?? []).map((choice) => choice.value));
      if (allowed.size > 0 && !allowed.has(text)) {
        throw new Error(`${option.label} is not a valid ${descriptor.displayName} option.`);
      }
    }

    pushFlag(args, option, text);
  }
  return args;
}
