import type { KnowledgeSearchHit, KnowledgeSearchMatchKind, KnowledgeSearchResult } from "@contracts";
import { workspaceNavigation, type WorkspaceNavKey, type WorkspaceNavigationItem } from "../workspace-navigation";

/**
 * Logic behind the top-bar search box.
 *
 * The box used to filter `workspaceNavigation` and nothing else, so "Search
 * workspace" meant "open a menu item". The ranked snapshot search already existed
 * in the main process (`knowledge:search`), it simply had one caller. This module
 * joins the two surfaces and keeps the branching out of the component so it can be
 * tested without a renderer.
 */

/** Navigation matches shown at once; the area list is short and self-explanatory. */
export const MAX_NAV_RESULTS = 4;
/** Source matches shown at once. More than this turns a popover into a file tree. */
export const MAX_FILE_RESULTS = 6;

/**
 * Areas matching the query. An empty query lists every area, which is what makes
 * the box usable as a launcher before anything is typed.
 */
export function matchNavigationAreas(rawQuery: string): WorkspaceNavigationItem[] {
  const needle = rawQuery.trim().toLowerCase();
  if (!needle) return workspaceNavigation;
  return workspaceNavigation
    .filter(
      (target) => target.label.toLowerCase().includes(needle) || target.summary.toLowerCase().includes(needle),
    )
    .slice(0, MAX_NAV_RESULTS);
}

const MATCH_LABELS: Record<KnowledgeSearchMatchKind, string> = {
  path: "path",
  symbol: "symbol",
  export: "export",
  import: "import",
  purpose: "purpose",
  language: "language",
  category: "category",
};

/** Match kinds strong enough that the user most likely meant a file, not a menu. */
const STRONG_MATCHES: readonly KnowledgeSearchMatchKind[] = ["path", "symbol", "export"];

/**
 * Why this file matched, for the row's second line. The scorer already reports its
 * reasons, and showing them is the difference between a ranked result and an
 * unexplained one.
 */
export function describeHit(hit: KnowledgeSearchHit): string {
  const reasons = hit.matches.map((kind) => MATCH_LABELS[kind]).filter(Boolean);
  const where = reasons.length > 0 ? reasons.join(" · ") : "match";
  return hit.matchedTerm ? `${where} · ${hit.matchedTerm}` : where;
}

/**
 * The five states the source half of the popover can be in.
 *
 * `not-indexed` is deliberately distinct from `empty`: "this project has no
 * CodeGraph yet" needs a scan, while "nothing matched 800 indexed files" needs a
 * different query. Collapsing them would tell users to search harder when the real
 * answer is that nothing was ever indexed.
 */
export type SourceSearchState =
  | { kind: "idle" }
  | { kind: "no-project" }
  | { kind: "searching" }
  | { kind: "not-indexed" }
  | { kind: "empty"; scanned: number }
  | { kind: "hits"; hits: KnowledgeSearchHit[]; scanned: number };

export function summarizeSourceSearch(input: {
  query: string;
  hasProject: boolean;
  result: KnowledgeSearchResult | null;
  limit?: number;
}): SourceSearchState {
  const query = input.query.trim();
  if (!query) return { kind: "idle" };
  if (!input.hasProject) return { kind: "no-project" };
  // A result for an older query is still in state while the debounce runs; showing
  // it would mean rows that do not match what is on screen.
  if (!input.result || input.result.query.trim() !== query) return { kind: "searching" };
  if (input.result.scanned === 0) return { kind: "not-indexed" };
  if (input.result.hits.length === 0) return { kind: "empty", scanned: input.result.scanned };
  return {
    kind: "hits",
    hits: input.result.hits.slice(0, Math.max(1, input.limit ?? MAX_FILE_RESULTS)),
    scanned: input.result.scanned,
  };
}

/** Row text for a state with nothing to list; `null` when there are hits to show. */
export function sourceSearchMessage(state: SourceSearchState): string | null {
  switch (state.kind) {
    case "no-project":
      return "Select a project to search its source.";
    case "searching":
      return "Searching indexed source...";
    case "not-indexed":
      return "No CodeGraph yet. Scan the project in Knowledge.";
    case "empty":
      return `No source match in ${state.scanned} indexed files.`;
    default:
      return null;
  }
}

export type SearchTarget = { kind: "area"; key: WorkspaceNavKey } | { kind: "file"; path: string };

/**
 * What Enter opens.
 *
 * An exact area name wins outright — typing "Tasks" and landing in a file called
 * `tasks.ts` would be surprising. Otherwise a strong source match (filename,
 * symbol, export) beats a fuzzy area match, since those are the queries where the
 * user is clearly naming code rather than a menu.
 */
export function chooseEnterTarget(
  rawQuery: string,
  areas: WorkspaceNavigationItem[],
  state: SourceSearchState,
): SearchTarget | null {
  const needle = rawQuery.trim().toLowerCase();
  const exactArea = areas.find((area) => area.label.toLowerCase() === needle);
  if (exactArea) return { kind: "area", key: exactArea.key };

  const topHit = state.kind === "hits" ? state.hits[0] : undefined;
  if (topHit && topHit.matches.some((kind) => STRONG_MATCHES.includes(kind))) {
    return { kind: "file", path: topHit.path };
  }
  if (areas[0] && needle) return { kind: "area", key: areas[0].key };
  if (topHit) return { kind: "file", path: topHit.path };
  return null;
}
