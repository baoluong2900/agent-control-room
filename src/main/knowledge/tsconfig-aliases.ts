import fs from "node:fs/promises";
import path from "node:path";

/**
 * tsconfig path-alias resolution for the knowledge scanner.
 *
 * The scanner used to treat every specifier that does not start with `.` as a
 * third-party package. That is wrong for any project using `compilerOptions.paths`,
 * and it is wrong *for this repo*: `@contracts` is the architectural centre of the
 * app and it was being rendered as an external npm node with 0.58 confidence.
 *
 * Two properties matter more than completeness here:
 *
 * 1. **Never throw.** A project with an exotic, malformed, or absent tsconfig must
 *    scan exactly as well as it did before. Every failure path returns "no aliases".
 * 2. **Tolerate JSONC.** `tsconfig.json` officially allows comments and trailing
 *    commas, and `JSON.parse` rejects both — this repo's own tsconfig has `//`
 *    comments, so a naive parser fails the very case this exists to fix.
 */

/** A single `paths` entry, pre-split around its optional `*` wildcard. */
interface AliasPattern {
  /** Text before the `*`, or the whole specifier for an exact alias. */
  prefix: string;
  /** Text after the `*`; empty for an exact alias. */
  suffix: string;
  /** True when the pattern contained a `*`. */
  wildcard: boolean;
  /** Candidate targets, project-relative and posix-separated. */
  targets: AliasTarget[];
}

interface AliasTarget {
  prefix: string;
  suffix: string;
  wildcard: boolean;
}

export interface AliasResolver {
  /**
   * Maps a specifier to candidate project-relative paths, most specific first.
   * Returns an empty array when no alias matches.
   */
  candidates(specifier: string): string[];
  /** True when at least one alias is configured; lets callers skip work. */
  readonly hasAliases: boolean;
}

const EMPTY_RESOLVER: AliasResolver = {
  candidates: () => [],
  hasAliases: false,
};

/** How many `extends` hops to follow before assuming a cycle. */
const MAX_EXTENDS_DEPTH = 8;

/**
 * Builds an alias resolver for `projectPath` by reading its tsconfig chain.
 *
 * `extends` is followed because splitting compilerOptions across a base config is
 * standard practice in monorepos, and `paths` very often lives in the base.
 */
export async function loadAliasResolver(projectPath: string): Promise<AliasResolver> {
  const config = await readTsconfigChain(projectPath);
  if (!config) return EMPTY_RESOLVER;

  const compilerOptions = isRecord(config.compilerOptions) ? config.compilerOptions : {};
  const rawPaths = isRecord(compilerOptions.paths) ? compilerOptions.paths : null;
  if (!rawPaths) return EMPTY_RESOLVER;

  // `paths` is resolved against baseUrl when present, otherwise against the
  // tsconfig's own directory — which is what `moduleResolution: bundler` does.
  const baseUrl = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
  const baseDir = toPosix(path.posix.normalize(baseUrl.replace(/\\/g, "/")));

  const patterns: AliasPattern[] = [];
  for (const [alias, rawTargets] of Object.entries(rawPaths)) {
    if (!Array.isArray(rawTargets)) continue;
    const targets: AliasTarget[] = [];
    for (const target of rawTargets) {
      if (typeof target !== "string") continue;
      const normalized = joinWithinProject(baseDir, target);
      if (normalized === null) continue;
      targets.push(splitTarget(normalized));
    }
    if (targets.length === 0) continue;
    patterns.push({ ...splitAlias(alias), targets });
  }

  if (patterns.length === 0) return EMPTY_RESOLVER;

  // Longest prefix first: with both `@contracts` and `@contracts/*` configured,
  // the exact alias must win for the bare specifier.
  patterns.sort((left, right) => right.prefix.length - left.prefix.length || Number(left.wildcard) - Number(right.wildcard));

  return {
    hasAliases: true,
    candidates(specifier: string): string[] {
      const trimmed = specifier.trim();
      if (!trimmed || trimmed.startsWith(".")) return [];

      const results: string[] = [];
      for (const pattern of patterns) {
        const matched = matchAlias(pattern, trimmed);
        if (matched === null) continue;
        for (const target of pattern.targets) {
          const candidate = target.wildcard ? `${target.prefix}${matched}${target.suffix}` : `${target.prefix}${target.suffix}`;
          const normalized = normalizeRelative(candidate);
          if (normalized !== null && !results.includes(normalized)) results.push(normalized);
        }
      }
      return results;
    },
  };
}

/** The captured `*` text, `""` for an exact match, or null when it does not match. */
function matchAlias(pattern: AliasPattern, specifier: string): string | null {
  if (!pattern.wildcard) return specifier === pattern.prefix ? "" : null;
  if (specifier.length < pattern.prefix.length + pattern.suffix.length) return null;
  if (!specifier.startsWith(pattern.prefix) || !specifier.endsWith(pattern.suffix)) return null;
  return specifier.slice(pattern.prefix.length, specifier.length - (pattern.suffix.length || 0));
}

function splitAlias(alias: string): Pick<AliasPattern, "prefix" | "suffix" | "wildcard"> {
  const star = alias.indexOf("*");
  if (star < 0) return { prefix: alias, suffix: "", wildcard: false };
  return { prefix: alias.slice(0, star), suffix: alias.slice(star + 1), wildcard: true };
}

function splitTarget(target: string): AliasTarget {
  const star = target.indexOf("*");
  if (star < 0) return { prefix: target, suffix: "", wildcard: false };
  return { prefix: target.slice(0, star), suffix: target.slice(star + 1), wildcard: true };
}

/**
 * Joins a `paths` target onto baseUrl, rejecting anything that escapes the project.
 *
 * A target like `../../shared/*` resolves outside the scanned tree, so it can never
 * match an indexed file; treating it as unresolvable is both correct and keeps the
 * "local but outside the index" signal meaningful.
 */
function joinWithinProject(baseDir: string, target: string): string | null {
  const cleaned = target.replace(/\\/g, "/");
  if (path.posix.isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned)) return null;
  return normalizeRelative(path.posix.join(baseDir, cleaned));
}

/** Normalizes to a project-relative posix path, or null if it escapes the root. */
function normalizeRelative(value: string): string | null {
  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized === "." ? "" : normalized;
}

/**
 * Reads `tsconfig.json` and merges the `extends` chain, nearest config winning.
 *
 * Only `compilerOptions` is merged: it is the only section the resolver reads, and
 * a shallow merge of it matches how TypeScript itself treats `paths`/`baseUrl`
 * (the child replaces the parent's value outright rather than merging entries).
 */
async function readTsconfigChain(projectPath: string): Promise<Record<string, unknown> | null> {
  let current: string | null = path.join(projectPath, "tsconfig.json");
  const visited = new Set<string>();
  const chain: Array<Record<string, unknown>> = [];

  for (let depth = 0; depth < MAX_EXTENDS_DEPTH && current; depth += 1) {
    const resolved: string = path.resolve(current);
    // A config that extends itself, directly or in a loop, must not hang the scan.
    if (visited.has(resolved)) break;
    visited.add(resolved);

    const parsed = await readJsonc(resolved);
    if (!parsed) break;
    chain.push(parsed);

    const extendsValue = parsed.extends;
    if (typeof extendsValue !== "string" || !extendsValue.trim()) break;
    // Bare-package extends (`extends: "@tsconfig/node22/tsconfig.json"`) would
    // need node resolution into node_modules. Stopping here keeps whatever the
    // local chain already provided instead of risking a wrong guess.
    if (!extendsValue.startsWith(".")) break;

    const next = path.resolve(path.dirname(resolved), extendsValue);
    current = next.endsWith(".json") ? next : path.join(next, "tsconfig.json");
  }

  if (chain.length === 0) return null;

  // Nearest config wins, so fold from the far end of the chain inward.
  const merged: Record<string, unknown> = {};
  const mergedCompilerOptions: Record<string, unknown> = {};
  for (const entry of chain.reverse()) {
    Object.assign(merged, entry);
    if (isRecord(entry.compilerOptions)) Object.assign(mergedCompilerOptions, entry.compilerOptions);
  }
  merged.compilerOptions = mergedCompilerOptions;
  return merged;
}

async function readJsonc(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(raw));
    return isRecord(parsed) ? parsed : null;
  } catch {
    // A malformed tsconfig is the user's problem to fix, not a reason to fail
    // their scan; the scanner simply proceeds without aliases.
    return null;
  }
}

/**
 * Strips comments and trailing commas so `JSON.parse` accepts a real tsconfig.
 *
 * Written as a small state machine rather than a regex because comment markers
 * inside string literals (a Windows path, a URL in a comment-like string) must be
 * preserved — a regex-based stripper corrupts exactly those configs.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    out += char;
  }

  // Trailing commas are legal in tsconfig and fatal to JSON.parse.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}
