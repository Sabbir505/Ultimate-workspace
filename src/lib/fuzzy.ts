// Small hand-rolled fuzzy matcher for the command palette (no dependency).
// Subsequence match with bonuses for consecutive hits, word/camelCase starts,
// and shorter targets. Case-insensitive.

export interface FuzzyResult {
  score: number;
  matches: number[]; // indices into the target string that matched
}

/**
 * Score `query` against `target`. Returns null when the query is not a
 * subsequence of the target. Higher score = better match.
 */
export function fuzzyScore(query: string, target: string): FuzzyResult | null {
  const q = query.trim().toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return { score: 0, matches: [] };
  if (q.length > t.length) return null;

  const matches: number[] = [];
  let score = 0;
  let ti = 0;
  let prevMatch = -2;

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        ti++;
        break;
      }
      ti++;
    }
    if (found === -1) return null;

    let charScore = 1;
    // Consecutive-match bonus — deliberately stronger than word-boundary so
    // "abc" ranks "abc …" above "a … b … c …" even with boundary hits.
    if (found === prevMatch + 1) charScore += 6;
    // Word-boundary bonus (start of string or after a separator).
    if (found === 0) {
      charScore += 6;
    } else {
      const before = target[found - 1];
      if (before === " " || before === "-" || before === "_" || before === "/" || before === ".") {
        charScore += 4;
      } else if (
        // camelCase boundary: lowercase -> uppercase transition
        before === before.toLowerCase() &&
        target[found] === target[found].toUpperCase() &&
        target[found] !== target[found].toLowerCase()
      ) {
        charScore += 4;
      }
    }
    score += charScore;
    matches.push(found);
    prevMatch = found;
  }

  // Prefer shorter targets and earlier first matches.
  score -= t.length * 0.05;
  score -= matches[0] * 0.1;

  return { score, matches };
}

export interface RankedItem<T> {
  item: T;
  score: number;
  matches: number[];
}

/** Rank and filter a list by fuzzy score against `getText(item)`. */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  limit = Infinity,
): RankedItem<T>[] {
  const out: RankedItem<T>[] = [];
  for (const item of items) {
    const res = fuzzyScore(query, getText(item));
    if (res) out.push({ item, score: res.score, matches: res.matches });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
