// Session title generation (PRD §7.4): the frontend observes the user's first
// prompt, takes the first ~40 characters cleaned of newlines, and calls
// update_session_title once. Titles stay editable afterwards.

import { sliceCodePoints } from "./safeSlice";

export const TITLE_MAX_LENGTH = 40;

/**
 * Generate a session title from the user's first prompt.
 * - Collapses all whitespace (incl. newlines) to single spaces and trims.
 * - Truncates to 40 chars with an ellipsis when longer (code-point-safe: the
 *   title is PERSISTED, so a split surrogate pair would corrupt it forever).
 * - Returns null when the prompt has no usable text (caller keeps "Untitled").
 */
export function generateSessionTitle(firstPrompt: string): string | null {
  const cleaned = firstPrompt.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length <= TITLE_MAX_LENGTH) return cleaned;
  // Cut at a word boundary when possible so the ellipsis doesn't split a word.
  const slice = sliceCodePoints(cleaned, TITLE_MAX_LENGTH);
  const lastSpace = slice.lastIndexOf(" ");
  const base = lastSpace >= TITLE_MAX_LENGTH / 2 ? slice.slice(0, lastSpace) : slice;
  return base.trimEnd() + "…";
}

/** Display title for a session record. */
export function sessionDisplayTitle(title: string | null | undefined): string {
  return title && title.trim().length > 0 ? title : "Untitled Session";
}
