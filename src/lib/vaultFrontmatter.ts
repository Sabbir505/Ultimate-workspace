// Obsidian-style frontmatter (properties) — a deliberately small YAML
// subset: `key: value` lines, `key:` followed by `  - item` list entries,
// optional quoting, `---` fences on the first line. This covers what the
// vault itself writes (tags, aliases, source, lesson) plus ordinary user
// frontmatter, without pulling a YAML dependency. Anything the subset can't
// parse round-trips VERBATIM (we keep the raw text and only rewrite it when
// a property actually changes), so exotic YAML never corrupts notes.

export type FrontmatterValue = string | string[];

export interface SplitNote {
  /** Parsed key → value (lists preserved as arrays). */
  data: Record<string, FrontmatterValue>;
  /** The note body after the closing fence. */
  body: string;
  /** Raw fence block INCLUDING both `---` lines, or null when absent. */
  raw: string | null;
}

const isBlank = (line: string) => !line.trim();

/** Split a note into frontmatter + body. Tolerates leading blank lines and
 *  CRLF. No closing fence → the whole block is body (never guess). */
export function splitFrontmatter(content: string): SplitNote {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && isBlank(lines[i])) i += 1;
  if (lines[i]?.trim() !== "---") return { data: {}, body: content, raw: null };
  const start = i;
  let end = -1;
  for (let j = start + 1; j < lines.length; j += 1) {
    if (lines[j].trim() === "---") {
      end = j;
      break;
    }
  }
  if (end === -1) return { data: {}, body: content, raw: null };
  const raw = lines.slice(start, end + 1).join("\n");
  return { data: parseFrontmatterLines(lines.slice(start + 1, end)), body: lines.slice(end + 1).join("\n"), raw };
}

/** Parse the inner lines of a fence block. Unknown shapes (nested maps,
 *  multi-line strings) are skipped — serialize keeps their raw text only
 *  when we didn't need to touch them (see serializeFrontmatter). */
function parseFrontmatterLines(lines: string[]): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  const unquote = (v: string) => {
    const t = v.trim();
    if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) || (t.startsWith("'") && t.endsWith("'") && t.length > 1)) {
      return t.slice(1, -1);
    }
    return t;
  };
  for (const line of lines) {
    const listItem = /^(\s+)-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      currentList?.push(unquote(listItem[2]));
      continue;
    }
    const kv = /^([A-Za-z][\w -]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      if (currentKey && currentList) data[currentKey] = currentList;
      const key = kv[1].trim();
      if (kv[2].trim() === "") {
        currentKey = key;
        currentList = [];
      } else {
        data[key] = unquote(kv[2]);
        currentKey = null;
        currentList = null;
      }
      continue;
    }
    // Anything unparseable ends an in-progress list; its collected items are
    // kept (best effort) rather than dropped.
    currentKey = null;
    currentList = null;
  }
  if (currentKey && currentList) data[currentKey] = currentList;
  return data;
}

const needsQuotes = (v: string) => /^[#&*!|>%@`{}[\]"']/.test(v) || v.includes(": ") || v.endsWith(":") || /^\s|\s$/.test(v) || v === "";

function quote(v: string): string {
  return needsQuotes(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

/** Rebuild a fence block from parsed data. Field order follows the input
 *  record (JS insertion order) — callers pass a pre-ordered object. */
export function serializeFrontmatter(data: Record<string, FrontmatterValue>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}:`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${quote(item)}`);
      }
    } else {
      // Defensive String(): callers handing a number/boolean shouldn't crash.
      lines.push(`${key}: ${quote(String(value))}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/** Replace (or insert, or remove) the frontmatter of a note body. Leading
 *  blank lines are normalized away — they only ever existed as the gap
 *  after a removed/replaced fence. */
export function withFrontmatter(body: string, data: Record<string, FrontmatterValue> | null): string {
  const { body: rawBody } = splitFrontmatter(body);
  const cleanBody = rawBody.replace(/^\n+/, "");
  if (!data || Object.keys(data).length === 0) return cleanBody;
  return `${serializeFrontmatter(data)}\n\n${cleanBody}`;
}
