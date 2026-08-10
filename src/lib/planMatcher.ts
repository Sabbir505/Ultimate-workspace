import type { PlanStep } from "../state/chat";

/** Word-overlap ratio (Jaccard-style on word sets). */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/** Try to match a backend signal (stepLabel + optional toolCall) against
 *  a pending PlanStep. Returns the matched step or null.
 *
 *  Matching strategies (tried in order):
 *  1. Exact label match (case-insensitive, trimmed)
 *  2. Significant word overlap (>60%)
 *  3. File-path match — signal.toolCall is a path that appears in the label
 */
export function matchPlanStep(
  signal: { stepLabel: string; toolCall?: string },
  pendingSteps: PlanStep[],
): PlanStep | null {
  const sig = signal.stepLabel.toLowerCase().trim();
  if (!sig) return null;

  // 1. Exact match
  for (const step of pendingSteps) {
    if (step.label.toLowerCase().trim() === sig) return step;
  }

  // 2. Word overlap > 0.6
  let best: { step: PlanStep; score: number } | null = null;
  for (const step of pendingSteps) {
    const score = wordOverlap(sig, step.label);
    if (score > 0.6 && (!best || score > best.score)) {
      best = { step, score };
    }
  }
  if (best) return best.step;

  // 3. File path match
  if (signal.toolCall) {
    const fileName = signal.toolCall.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    if (fileName) {
      for (const step of pendingSteps) {
        if (step.label.toLowerCase().includes(fileName)) return step;
      }
    }
  }

  return null;
}

/** Scan an assistant message text for completion markers and return the
 *  matching pending steps that should be marked complete.
 *
 *  Patterns detected:
 *  - `- [x] <label text>` (checked checkbox)
 *  - `✓ <label text>` or `✔ <label text>`
 *  - `~~<label text>~~` (strikethrough)
 *  - `completed <label text>` or `finished <label text>` or `done <label text>`
 */
export function scanForCompletions(
  messageText: string,
  pendingSteps: PlanStep[],
): PlanStep[] {
  if (pendingSteps.length === 0) return [];
  const completed: PlanStep[] = [];

  // Build patterns to search: each pending step's label as a sub-pattern
  for (const step of pendingSteps) {
    if (step.status === "completed" || step.status === "failed") continue;

    const label = step.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // escape regex chars
    const patterns = [
      new RegExp(`-\\s*\\[x\\]\\s*${label}`, "i"),
      new RegExp(`[✓✔]\\s*${label}`, "i"),
      new RegExp(`~~${label}~~`, "i"),
      new RegExp(`(?:completed|finished|done)[\\s:]*${label}`, "i"),
    ];

    for (const re of patterns) {
      if (re.test(messageText)) {
        completed.push(step);
        break;
      }
    }
  }

  return completed;
}
