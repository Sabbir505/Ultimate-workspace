import type { PlanStep } from "../state/chat";

/** Normalize a step label: strip markdown formatting, trim whitespace,
 *  collapse internal newlines. */
function normalizeLabel(raw: string): string {
  return raw
    .replace(/\*\*(.+?)\*\*/g, "$1")    // bold
    .replace(/\*(.+?)\*/g, "$1")         // italic
    .replace(/`(.+?)`/g, "$1")           // inline code
    // Only markdown-EMPHASIS underscores (paired _like_this_), never the
    // single underscores inside snake_case identifiers — stripping all of
    // them mangled labels like "parse_plan_steps" (audit L7).
    .replace(/(?<![\w])_([^_\s]+)_(?![\w])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Word-overlap ratio between two strings. Used to deduplicate steps
 *  that are near-identical. */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/** Parse individual plan steps from a plan markdown section.
 *  Returns steps in order, deduplicated by label overlap.
 *  `sessionId` and `planIndex` are used to construct unique `stepId` values. */
export function parsePlanSteps(
  markdown: string,
  sessionId: string,
  planIndex: number,
): PlanStep[] {
  const lines = markdown.split("\n");
  const rawSteps: { label: string; isChecked: boolean }[] = [];

  // Strategy 1: Checkboxes — "- [x] Do the thing" or "- [ ] Not done yet"
  const checkboxRe = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/;
  // Strategy 2: Numbered items — "1. Do X", "2) Do Y"
  const numberedRe = /^\s*(\d+)[.)]\s+(.+)$/;
  // Strategy 3: Bullet lists (but NOT checkboxes)
  const bulletRe = /^\s*[-*•]\s+(?!(?:\[[ xX]\]))(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let match: RegExpExecArray | null;

    match = checkboxRe.exec(line);
    if (match) {
      rawSteps.push({ label: normalizeLabel(match[2]), isChecked: /[xX]/.test(match[1]) });
      continue;
    }

    match = numberedRe.exec(line);
    if (match) {
      rawSteps.push({ label: normalizeLabel(match[2]), isChecked: false });
      continue;
    }

    match = bulletRe.exec(line);
    if (match) {
      rawSteps.push({ label: normalizeLabel(match[1]), isChecked: false });
    }
  }

  // Deduplicate by word overlap
  const unique: { label: string; isChecked: boolean }[] = [];
  for (const s of rawSteps) {
    if (s.label.length < 3) continue; // skip noise like "1." with no text
    const isDup = unique.some((u) => wordOverlap(u.label, s.label) > 0.8);
    if (!isDup) unique.push(s);
  }

  // Build PlanStep array
  return unique.map((s, i) => ({
    stepId: `plan-${sessionId}-${planIndex}-${i}`,
    label: s.label,
    status: s.isChecked ? "completed" : (i === 0 ? "in_progress" : "pending"),
    source: "parsed" as const,
    planIndex,
    stepIndex: i,
  }));
}
