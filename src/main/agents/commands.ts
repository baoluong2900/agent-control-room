import { spawn } from "node:child_process";
import process from "node:process";
import { buildOptionArgs } from "@contracts";
import type { AgentCliId, AgentPromptMode, AgentRunInput, AgentStructuredChat } from "@contracts";
import { getAgentDescriptor, listAgentCatalog } from "./catalog";

export type Invocation = {
  executable: string;
  args: string[];
  /** Prompt that still needs to be written to stdin after spawn. */
  stdinPrompt?: string;
};

export const cliDisplayNames = Object.fromEntries(
  listAgentCatalog().map((entry) => [entry.id, entry.displayName]),
) as Record<AgentCliId, string>;

export function candidatesForCli(id: AgentCliId): string[] {
  return getAgentDescriptor(id).commandCandidates;
}

export async function resolveExecutable(id: AgentCliId, override?: string): Promise<string | null> {
  const explicit = override?.trim();
  if (explicit) {
    const parsed = parseArgs(explicit);
    const binary = parsed[0] ?? explicit;
    return (await commandExists(binary)) || binary.includes("/") || binary.includes("\\") ? explicit : null;
  }

  for (const candidate of candidatesForCli(id)) {
    if (await commandExists(candidate)) return candidate;
  }

  return null;
}

export async function commandExists(command: string): Promise<boolean> {
  const lookup = process.platform === "win32" ? "where" : "which";

  return new Promise((resolve) => {
    const child = spawn(lookup, [command], { windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Splits a command string into argv, honouring single and double quotes.
 * Keeps behaviour predictable without shelling out (no injection surface).
 */
export function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) args.push(current);
  return args;
}

export function shellInvocation(command: string): Invocation {
  if (process.platform === "win32") {
    return { executable: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { executable: process.env.SHELL || "sh", args: ["-lc", command] };
}

/** Builds the concrete process invocation for a run. */
export async function buildInvocation(input: AgentRunInput): Promise<Invocation> {
  const prompt = input.prompt.trim();

  if (input.cliId === "shell") {
    const command = input.shellCommand?.trim() || prompt;
    return withTty(shellInvocation(command), input.forceTty);
  }

  const descriptor = getAgentDescriptor(input.cliId);
  const resolved = await resolveExecutable(input.cliId, input.commandOverride);
  if (!resolved) {
    throw new Error(
      input.commandOverride
        ? `Command "${input.commandOverride}" was not found.`
        : `${descriptor.displayName} was not found on PATH.`,
    );
  }

  const overrideParts = parseArgs(resolved);
  const executable = overrideParts[0] ?? resolved;
  const args = overrideParts.slice(1);
  const chat = input.uiMode === "chat" ? descriptor.structuredChat : undefined;
  const structuredChat = Boolean(chat);

  // A chat promptFlag carries the prompt as its value, so it must be emitted
  // last (after resume args) rather than in its declared position.
  const chatArgs = chat
    ? chat.promptFlag
      ? chat.args.filter((arg) => arg !== chat.promptFlag)
      : chat.args
    : [];

  args.push(...(chat ? chatArgs : input.interactive ? descriptor.interactiveArgs : descriptor.baseArgs));

  const model = input.model?.trim();
  // Sentinel ids mean "let the CLI use its own default", so no flag is sent.
  const sentinelModels = new Set(["none", "default", "cli default"]);
  if (model && descriptor.modelFlag && !sentinelModels.has(model.toLowerCase())) {
    args.push(descriptor.modelFlag, model);
  }
  if (input.cliId === "ollama" && model) {
    args.push(model);
  }

  if (input.extraArgs?.trim()) {
    const extraArgs = parseArgs(input.extraArgs.trim());
    args.push(...(chat ? withoutStructuredChatConflicts(extraArgs, chat.args) : extraArgs));
  }

  if (input.autoApprove && descriptor.autoApproveArgs?.length) {
    args.push(...descriptor.autoApproveArgs);
  }

  const systemPrompt = input.systemPrompt?.trim();
  if (systemPrompt && descriptor.systemPromptFlag) {
    args.push(descriptor.systemPromptFlag, systemPrompt);
  }

  args.push(...buildOptionArgs(descriptor, input.options, { interactive: Boolean(input.interactive) }));

  if (chat && input.resumeConversationId?.trim()) {
    args.push(chat.resumeFlag, input.resumeConversationId.trim());
  }

  // Structured chat never pipes the prompt: these CLIs are one-shot print-mode
  // invocations that take the prompt in argv. Sending it on stdin (which the old
  // `interactive ? "stdin"` branch did) left agy erroring on a missing flag
  // argument and claude waiting on a pipe that never carried the task.
  let stdinPrompt: string | undefined;
  if (prompt) {
    if (chat) {
      if (chat.promptFlag) {
        args.push(chat.promptFlag, prompt);
      } else {
        args.push(prompt);
      }
    } else {
      const promptMode: AgentPromptMode = input.interactive
        ? "stdin"
        : input.promptMode ?? descriptor.promptMode;

      if (promptMode === "arg") {
        args.push(prompt);
      } else if (promptMode === "flag" && descriptor.promptFlag) {
        args.push(descriptor.promptFlag, prompt);
      } else {
        stdinPrompt = prompt;
      }
    }
  }

  return withTty({ executable, args, stdinPrompt }, input.forceTty && !structuredChat);
}

/**
 * Wraps the invocation in `script` so CLIs that require a TTY still stream
 * output. macOS and Linux only; Windows falls back to a plain pipe.
 */
export function withTty(invocation: Invocation, forceTty?: boolean): Invocation {
  if (!forceTty || process.platform === "win32") return invocation;

  const command = quoteCommand([invocation.executable, ...invocation.args]);

  if (process.platform === "darwin") {
    return {
      executable: "script",
      args: ["-q", "/dev/null", "/bin/sh", "-c", command],
      stdinPrompt: invocation.stdinPrompt,
    };
  }

  return {
    executable: "script",
    args: ["-qfec", command, "/dev/null"],
    stdinPrompt: invocation.stdinPrompt,
  };
}

export function quoteCommand(parts: string[]): string {
  return parts
    .map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}

/**
 * Whether this run is a structured chat. Driven entirely by the catalog: a CLI
 * without a `structuredChat` block cannot chat, no matter what `uiMode` asks
 * for. `shell` has no descriptor, so it is excluded before the lookup.
 */
export function usesStructuredChat(input: Pick<AgentRunInput, "cliId" | "uiMode">): boolean {
  return input.uiMode === "chat" && Boolean(structuredChatFor(input.cliId));
}

/** The chat capability for a CLI, or undefined when it has none. */
export function structuredChatFor(cliId: AgentCliId): AgentStructuredChat | undefined {
  if (cliId === "shell") return undefined;
  try {
    return getAgentDescriptor(cliId).structuredChat;
  } catch {
    return undefined;
  }
}

/**
 * Removes user/profile args that set a flag already owned by structured chat.
 * The capability is authoritative while chat mode is active; sending two
 * `--output-format` values otherwise makes behaviour depend on the CLI parser.
 */
export function withoutStructuredChatConflicts(extraArgs: string[], chatArgs: string[]): string[] {
  const ownedFlags = new Set(chatArgs.filter((arg) => arg.startsWith("-")));
  const filtered: string[] = [];

  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index];
    const flag = arg.split("=", 1)[0];
    if (!ownedFlags.has(flag)) {
      filtered.push(arg);
      continue;
    }

    // `--flag=value` is self-contained. For `--flag value`, discard the value
    // too unless the next token is another flag.
    if (!arg.includes("=") && extraArgs[index + 1] && !extraArgs[index + 1].startsWith("-")) {
      index += 1;
    }
  }

  return filtered;
}
