/**
 * A ranked list element — a searchable document key with its position in a search result list.
 */
export interface Ranked {
  key: string;
  rank: number;
}

/**
 * Reciprocal rank fusion (spec D5): score = Σ 1 / (k + rank) over the lists a key appears in.
 * Best-scored keys first, ties broken by first appearance across all lists.
 */
export function rrf(lists: Ranked[][], k = 60): { key: string; score: number }[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    for (const { key, rank } of list) {
      score.set(key, (score.get(key) ?? 0) + 1 / (k + rank));
    }
  }
  return [...score.entries()].map(([key, s]) => ({ key, score: s })).sort((a, b) => b.score - a.score);
}
