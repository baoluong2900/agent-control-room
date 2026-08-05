import path from "node:path";
import type {
  KnowledgeSearchHit,
  KnowledgeSearchMatchKind,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
} from "@contracts";

/**
 * Ranked search over an indexed snapshot.
 *
 * This replaces a client-side filter that joined seven fields into one string and
 * called `.includes()` on it. That had no ordering at all: a file merely mentioning
 * "workflow" in prose ranked identically to `workflow-service.ts`, and the caller
 * got results in whatever order the scan produced them.
 *
 * No embeddings or inverted index. At snapshot scale (hundreds to a few thousand
 * files) a single scoring pass is fast, has no build step, and stays explainable —
 * every hit can say *why* it matched, which a similarity score cannot.
 */

/**
 * Field weights. Ordered by how strongly a match predicts "this is the file I
 * meant": a filename match is the strongest signal a developer gives, and prose in
 * a purpose line is the weakest.
 */
const WEIGHTS = {
  fileName: 100,
  pathSegment: 60,
  symbol: 45,
  export: 40,
  import: 18,
  purpose: 12,
  language: 8,
  category: 8,
} as const;

/** Multiplier for a term that starts the field rather than sitting inside it. */
const PREFIX_BONUS = 1.6;
/** Multiplier for an exact, whole-field match. */
const EXACT_BONUS = 2.2;
/** Ceiling on the graph-centrality nudge, so connectivity can never outrank relevance. */
const MAX_CENTRALITY_BONUS = 12;

export function searchSnapshot(snapshot: KnowledgeSnapshot, rawQuery: string, limit = 20): KnowledgeSearchResult {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return { query: rawQuery, hits: [], scanned: snapshot.files.length };

  // Multi-word queries are treated as AND over terms: "workflow service" should
  // find workflow-service.ts, not every file matching either word.
  const terms = query.split(/\s+/).filter(Boolean);
  const centrality = edgeCountsByPath(snapshot);
  const maxEdges = Math.max(1, ...centrality.values());

  const hits: KnowledgeSearchHit[] = [];

  for (const file of snapshot.files) {
    const fileName = path.posix.basename(file.path).toLowerCase();
    const lowerPath = file.path.toLowerCase();

    let total = 0;
    const matches = new Set<KnowledgeSearchMatchKind>();
    let matchedTerm: string | undefined;
    let everyTermMatched = true;

    for (const term of terms) {
      let best = 0;
      let bestKind: KnowledgeSearchMatchKind | undefined;
      let bestTerm: string | undefined;

      const consider = (score: number, kind: KnowledgeSearchMatchKind, termLabel?: string): void => {
        if (score <= best) return;
        best = score;
        bestKind = kind;
        bestTerm = termLabel;
      };

      if (fileName.includes(term)) {
        consider(WEIGHTS.fileName * positionBonus(fileName, term, stripExtension(fileName)), "path");
      }
      if (lowerPath.includes(term)) {
        // A directory-name match ("main", "renderer") is weaker than a filename
        // match but still a real structural signal.
        consider(WEIGHTS.pathSegment * positionBonus(lowerPath, term), "path");
      }

      for (const symbol of file.symbols) {
        const lower = symbol.toLowerCase();
        if (!lower.includes(term)) continue;
        consider(WEIGHTS.symbol * positionBonus(lower, term, lower), "symbol", symbol);
      }
      for (const exported of file.exports) {
        const lower = exported.toLowerCase();
        if (!lower.includes(term)) continue;
        consider(WEIGHTS.export * positionBonus(lower, term, lower), "export", exported);
      }
      for (const imported of file.imports) {
        const lower = imported.toLowerCase();
        if (!lower.includes(term)) continue;
        consider(WEIGHTS.import * positionBonus(lower, term), "import", imported);
      }

      if (file.purpose.toLowerCase().includes(term)) {
        consider(WEIGHTS.purpose, "purpose");
      }
      if (file.language.toLowerCase().includes(term)) {
        consider(WEIGHTS.language * positionBonus(file.language.toLowerCase(), term, file.language.toLowerCase()), "language");
      }
      if (file.category.toLowerCase().includes(term)) {
        consider(WEIGHTS.category * positionBonus(file.category.toLowerCase(), term, file.category.toLowerCase()), "category");
      }

      if (best === 0) {
        everyTermMatched = false;
        break;
      }

      total += best;
      if (bestKind) matches.add(bestKind);
      // Report the term from the strongest field overall, which is the one a user
      // is most likely to recognise.
      if (bestTerm && !matchedTerm) matchedTerm = bestTerm;
    }

    if (!everyTermMatched || total === 0) continue;

    // A well-connected file is more likely to be the one worth opening, but this is
    // a nudge and nothing more — capped so it can never reorder a filename match
    // below a prose match.
    const edges = centrality.get(file.path) ?? 0;
    total += (edges / maxEdges) * MAX_CENTRALITY_BONUS;

    hits.push({
      path: file.path,
      language: file.language,
      category: file.category,
      purpose: file.purpose,
      score: Math.round(total * 100) / 100,
      matches: [...matches],
      matchedTerm,
    });
  }

  hits.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  return {
    query: rawQuery,
    hits: hits.slice(0, Math.max(1, Math.min(limit, 200))),
    scanned: snapshot.files.length,
  };
}

/**
 * Scales a match by where the term sits in the field.
 *
 * An exact match beats a prefix, and a prefix beats a substring: someone typing
 * "task" wants `task.ts` before `subtask-helper.ts`. `exactAgainst` lets a filename
 * be compared without its extension, so "knowledge" is exact for "knowledge.ts".
 */
function positionBonus(haystack: string, term: string, exactAgainst?: string): number {
  if (exactAgainst !== undefined && exactAgainst === term) return EXACT_BONUS;
  if (haystack === term) return EXACT_BONUS;
  return haystack.startsWith(term) ? PREFIX_BONUS : 1;
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** How many graph edges touch each file node, as a proxy for centrality. */
function edgeCountsByPath(snapshot: KnowledgeSnapshot): Map<string, number> {
  const pathById = new Map<string, string>();
  for (const node of snapshot.graph.nodes) {
    if (node.kind === "file" && node.path) pathById.set(node.id, node.path);
  }

  const counts = new Map<string, number>();
  for (const edge of snapshot.graph.edges) {
    for (const endpoint of [edge.source, edge.target]) {
      const filePath = pathById.get(endpoint);
      if (!filePath) continue;
      counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
    }
  }
  return counts;
}
