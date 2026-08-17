// Minimal unified-diff parser (PRD §7.9 allows a minimal custom renderer
// instead of pulling in diff2html). Parses standard `git diff` output into
// per-file hunks of typed lines for display.

export type DiffLineType = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** Old-file line number (1-based). For added lines this is null. */
  oldLine: number | null;
  /** New-file line number (1-based). For deleted lines this is null. */
  newLine: number | null;
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  lines: DiffLine[];
}

/**
 * Parse `@@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@` into the
 * (oldStart, newStart) tuple the line-number gutter needs. Returns null for
 * malformed hunk headers (the renderer will then fall back to a "??" gutter).
 */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  // Drop the leading "@@" and trailing " @@ ..." (optional function/section
  // context after the second @@) so the rest is "-X,Y +A,B" with X and A
  // always present (Y/B may be omitted for a count of 1).
  const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!m) return null;
  return { oldStart: parseInt(m[1], 10), newStart: parseInt(m[2], 10) };
}

/** Parse unified diff text into a list of files with typed lines. */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  // Running line numbers across all hunks in the current file. Reset to the
  // hunk's start whenever we see a new `@@` line. The renderer relies on
  // these to fill the gutter; without them the user sees "??" everywhere,
  // which the user flagged as the diff being unreadable.
  let oldNo: number | null = null;
  let newNo: number | null = null;
  // True once the current file's first `@@` hunk header has been seen. Before
  // that, `--- `/`+++ ` lines are file headers; inside hunk bodies they are
  // ordinary del/add lines and must not be reparsed as headers (L14).
  let seenHunk = false;

  for (const rawLine of diffText.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      current = { oldPath: "", newPath: "", lines: [] };
      files.push(current);
      current.lines.push({ type: "meta", text: line, oldLine: null, newLine: null });
      oldNo = null;
      newNo = null;
      seenHunk = false;
      continue;
    }
    // Classic unified diffs (no `diff --git` header) start at `--- `. Start a
    // file there too — previously the whole input was dropped because
    // `current` stayed null and every line hit the `if (!current) continue`
    // guard below (audit L4).
    if (!current && line.startsWith("--- ")) {
      current = { oldPath: "", newPath: "", lines: [] };
      files.push(current);
    }
    if (!current) continue;

    if (!seenHunk && line.startsWith("--- ")) {
      current.oldPath = stripPrefix(line.slice(4));
      current.lines.push({ type: "meta", text: line, oldLine: null, newLine: null });
    } else if (!seenHunk && line.startsWith("+++ ")) {
      current.newPath = stripPrefix(line.slice(4));
      current.lines.push({ type: "meta", text: line, oldLine: null, newLine: null });
    } else if (line.startsWith("@@")) {
      seenHunk = true;
      const hunk = parseHunkHeader(line);
      oldNo = hunk?.oldStart ?? null;
      newNo = hunk?.newStart ?? null;
      current.lines.push({ type: "hunk", text: line, oldLine: oldNo, newLine: newNo });
    } else if (line.startsWith("+")) {
      current.lines.push({ type: "add", text: line.slice(1), oldLine: null, newLine: newNo });
      if (newNo !== null) newNo += 1;
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", text: line.slice(1), oldLine: oldNo, newLine: null });
      if (oldNo !== null) oldNo += 1;
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "context", text: line.slice(1), oldLine: oldNo, newLine: newNo });
      if (oldNo !== null) oldNo += 1;
      if (newNo !== null) newNo += 1;
    } else {
      current.lines.push({ type: "meta", text: line, oldLine: null, newLine: null });
    }
  }
  return files;
}

function stripPrefix(path: string): string {
  // git prefixes paths with a/ and b/
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}
