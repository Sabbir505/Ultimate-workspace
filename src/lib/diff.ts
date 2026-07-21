// Minimal unified-diff parser (PRD §7.9 allows a minimal custom renderer
// instead of pulling in diff2html). Parses standard `git diff` output into
// per-file hunks of typed lines for display.

export type DiffLineType = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  lines: DiffLine[];
}

/** Parse unified diff text into a list of files with typed lines. */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;

  for (const rawLine of diffText.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      current = { oldPath: "", newPath: "", lines: [] };
      files.push(current);
      current.lines.push({ type: "meta", text: line });
      continue;
    }
    if (!current) continue;

    if (line.startsWith("--- ")) {
      current.oldPath = stripPrefix(line.slice(4));
      current.lines.push({ type: "meta", text: line });
    } else if (line.startsWith("+++ ")) {
      current.newPath = stripPrefix(line.slice(4));
      current.lines.push({ type: "meta", text: line });
    } else if (line.startsWith("@@")) {
      current.lines.push({ type: "hunk", text: line });
    } else if (line.startsWith("+")) {
      current.lines.push({ type: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "context", text: line.slice(1) });
    } else {
      current.lines.push({ type: "meta", text: line });
    }
  }
  return files;
}

function stripPrefix(path: string): string {
  // git prefixes paths with a/ and b/
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}
