import { spawn } from "node:child_process";
import process from "node:process";
import type { AgentCliId, AgentPromptMode, AgentRunInput } from "@contracts";
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
  const structuredChat = usesStructuredChat(input);

  args.push(...(structuredChat ? structuredChatArgs(input.cliId) : input.interactive ? descriptor.interactiveArgs : descriptor.baseArgs));

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
    args.push(...parseArgs(input.extraArgs.trim()));
  }

  if (structuredChat && input.resumeConversationId?.trim()) {
    args.push(...structuredChatResumeArgs(input.cliId, input.resumeConversationId.trim()));
  }

  const promptMode: AgentPromptMode = structuredChat
    ? "arg"
    : input.interactive
      ? "stdin"
      : input.promptMode ?? descriptor.promptMode;

  let stdinPrompt: string | undefined;
  if (prompt) {
    if (promptMode === "arg") {
      args.push(prompt);
    } else if (promptMode === "flag" && descriptor.promptFlag) {
      args.push(descriptor.promptFlag, prompt);
    } else {
      stdinPrompt = prompt;
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

export function usesStructuredChat(input: Pick<AgentRunInput, "cliId" | "uiMode">): boolean {
  return input.uiMode === "chat" && (input.cliId === "claude" || input.cliId === "agy");
}

function structuredChatArgs(cliId: AgentCliId): string[] {
  if (cliId === "claude") {
    return ["-p", "--output-format", "json"];
  }

  if (cliId === "agy") {
    return ["--print", "--output-format", "json"];
  }

  return [];
}

function structuredChatResumeArgs(cliId: AgentCliId, conversationId: string): string[] {
  if (cliId === "claude") return ["--resume", conversationId];
  if (cliId === "agy") return ["--conversation", conversationId];
  return [];
}
