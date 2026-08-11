// Splits freeform markdown release notes into Features / Bug Fixes / Other
// sections for structured display. The updater manifest ships notes as a single
// markdown string (see scripts/make-latest-json.mjs), so we classify by heading
// keyword here on the client rather than restructuring the manifest.
//
// Headings recognized (case-insensitive, any level #–###):
//   features: "new", "feature", "features", "added", "additions", "improvements"
//   bugfixes: "fix", "fixed", "fixes", "bug", "bugs", "bugfixes", "patch"
//   other:    everything else (e.g. "Changes", "Notes", "Internal")
//
// Bullets are collected per heading block (lines starting with -, *, or +).
// A prose paragraph under a heading with no list items becomes one bullet so
// prose-only release notes aren't lost. If there are NO headings at all, every
// list item in the whole note is returned under `features` — unstructured notes
// still render as a "What's new" list rather than nothing.

export interface ParsedReleaseNotes {
  features: string[];
  bugfixes: string[];
  other: string[];
}

const FEATURE_RE = /\b(new|feature|features|added|additions?|improvements?)\b/i;
const FIX_RE = /\b(fix(es|ed)?|bugs?|bugfixes?|patch(es|ed)?)\b/i;

/** Strip markdown emphasis/inline-code wrappers, returning plain text. Keeps
 *  inline code spans readable by dropping only the backticks. */
function stripMarkdown(line: string): string {
  return line
    .replace(/`{1,3}/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .trim();
}

/** True for a markdown list-item line (`-`, `*`, or `+` then a space). Ordered
 *  list items (`1. `) also count. */
function isListItem(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line);
}

function listItemText(line: string): string {
  return line.replace(/^\s*[-*+]\s+/, "").replace(/^\s*\d+\.\s+/, "");
}

/** Classify a heading into one of the three buckets. */
function classify(heading: string): "features" | "bugfixes" | "other" {
  if (FEATURE_RE.test(heading)) return "features";
  if (FIX_RE.test(heading)) return "bugfixes";
  return "other";
}

export function parseReleaseNotes(notes: string | null | undefined): ParsedReleaseNotes {
  const result: ParsedReleaseNotes = { features: [], bugfixes: [], other: [] };
  if (!notes || !notes.trim()) return result;

  const lines = notes.split(/\r?\n/);

  // Split into [heading, bodyLines[]] blocks. Lines before the first heading
  // form an implicit "preamble" block with an empty heading.
  interface Block {
    heading: string;
    body: string[];
  }
  const blocks: Block[] = [];
  let current: Block = { heading: "", body: [] };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      if (current.heading || current.body.some((l) => l.trim())) blocks.push(current);
      current = { heading: m[2].trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.heading || current.body.some((l) => l.trim())) blocks.push(current);

  const hasAnyHeading = blocks.some((b) => b.heading);

  for (const block of blocks) {
    const items: string[] = [];
    let prose: string[] = [];
    for (const line of block.body) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (isListItem(line)) {
        items.push(stripMarkdown(listItemText(line)));
      } else {
        prose.push(stripMarkdown(trimmed));
      }
    }
    // If a block has list items, those are its bullets; otherwise fold any
    // prose paragraph lines into a single bullet so the section isn't empty.
    const bullets = items.length > 0 ? items : prose.length > 0 ? [prose.join(" ")] : [];

    // No headings anywhere → everything is "What's new" (features).
    const bucket = hasAnyHeading ? classify(block.heading) : "features";
    result[bucket].push(...bullets);
  }

  return result;
}
