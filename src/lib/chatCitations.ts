// Inline citation support for chat markdown (and markdown artifact previews).
//
// Research turns cite sources with bracketed numbers — `…claim [1]`, `…[1,2]`,
// `…(1,2)` — that resolve against a numbered `## Sources` section at the end of
// the message (or of the generated research artifact). This module:
//   1. parses that Sources section into { number, title, url } records, and
//   2. rewrites recognized citation markers into `cite:` markdown links so the
//      renderer can turn them into interactive chips (hover = source preview,
//      click = open in the built-in browser pane).
//
// Only markers whose numbers ALL resolve to a parsed source are rewritten —
// prose enumerations like "step (3)" never become fake links, and content with
// no Sources section is left byte-identical.

export interface ChatSource {
  /** The number the model cites, e.g. 2 for `[2]`. */
  n: number;
  /** Human label for the tooltip (falls back to the URL host). */
  title: string;
  url: string;
}

/** A "Sources" / "References" / "Citations" heading line. Tolerates the
 *  decorations models actually emit: markdown markers ("## Sources"),
 *  numbering ("6. Source References"), bold ("**Sources**"), a trailing
 *  colon, and compound titles ("Sources & References"). Anchored so a prose
 *  sentence that merely mentions sources never matches. */
const SOURCES_HEADING_RE =
  /^(?:#{1,6}\s*)?(?:\*\*)?\s*(?:\d{1,2}\s*[.)]\s*)?(?:the\s+)?(?:source|reference|citation)s?(?:\s+(?:references?|list|section|notes?|appendix))?(?:\s*(?:&|and|\/|,)\s*(?:source|reference|citation)s?)?\s*:?\s*(?:\*\*)?\s*$/i;
/** Any markdown heading line — closes the Sources section. */
const ANY_HEADING_RE = /^\s*#{1,6}\s*\S/;
/** One numbered entry line: "1. …", "1) …", "- 1. …", "[3] …". */
const ENTRY_RE = /^\s*(?:[-*•]\s*)?(?:\*\*)?\[?(\d{1,2})[\].:)\s]\s*(.+)$/;
const URL_RE = /https?:\/\/[^\s)\]>"]+/i;
const MD_LINK_RE = /\[([^\]]+)\]\(\s*(https?:\/\/[^)\s]+)\s*\)/i;

/** Parse the LAST Sources-style section of `content` into numbered sources.
 *  Returns an empty array when the message carries no parsable section —
 *  callers then leave citations as plain text. */
export function parseChatSources(content: string): ChatSource[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  // The LAST matching heading wins: an answer could legitimately QUOTE an
  // earlier "## Sources" line before producing its own.
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SOURCES_HEADING_RE.test(lines[i].trim())) headingIdx = i;
  }
  if (headingIdx === -1) return [];

  const sources: ChatSource[] = [];
  const seen = new Set<number>();
  for (const rawLine of lines.slice(headingIdx + 1)) {
    const line = rawLine.trim();
    // A following markdown heading closes the section.
    if (line && ANY_HEADING_RE.test(rawLine)) break;
    if (!line) continue;
    const entry = ENTRY_RE.exec(line);
    if (!entry) continue;
    const n = parseInt(entry[1], 10);
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
    const body = entry[2].replace(/\*\*/g, "").trim();
    const urlMatch = URL_RE.exec(body);
    if (!urlMatch) continue;
    const url = urlMatch[0].replace(/[.,;]+$/, "");
    // Prefer the markdown-link label when the entry is "[Title](url)"; else
    // use the remaining prose with the URL and list separators stripped.
    const mdLink = MD_LINK_RE.exec(body);
    let title: string;
    if (mdLink && mdLink[2] === url) {
      title = mdLink[1];
    } else {
      title = body
        .replace(url, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[\s—–·|:]+/g, " ")
        .replace(/^[-–—\s]+|[-–—\s]+$/g, "")
        .trim();
    }
    if (!title) {
      try {
        title = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        title = url;
      }
    }
    if (title.length > 120) title = `${title.slice(0, 117)}…`;
    seen.add(n);
    sources.push({ n, title, url });
  }
  return sources;
}

/**
 * Fenced code block / inline code / markdown link. These regions must never
 * gain citation links (a `[2]` inside a code sample or inside an existing
 * link label is source text, not a citation), so they're swapped for
 * \u0000<idx>\u0000 placeholders before the citation pass and restored after.
 */
function protectRegions(content: string): { text: string; store: string[] } {
  const store: string[] = [];
  const protect = (re: RegExp, text: string): string =>
    text.replace(re, (m) => {
      store.push(m);
      return `\u0000${store.length - 1}\u0000`;
    });
  let out = content;
  out = protect(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, out); // fenced code
  out = protect(/`[^`\n]*`/g, out); // inline code
  // Markdown links/images: label in brackets + parenthesized target. The
  // digits-only guard in the citation regexes already makes false hits inside
  // real links near-impossible; protecting keeps the `](` lookahead exact.
  out = protect(/!?\[[^\]\n]*\]\([^)\n]*\)/g, out);
  return { text: out, store };
}

const BRACKET_CITE_RE = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\s*[(:])/g;
// Paren style requires AT LEAST TWO numbers — a bare "(3)" in prose is far
// more often an enumeration than a citation, while "(1,2)" is unambiguous.
const PAREN_CITE_RE = /\((\d{1,2}\s*,\s*\d{1,2}(?:\s*,\s*\d{1,2})*)\)/g;

/** Rewrite `[1]`, `[1,2]`, `[1][2]` and `(1,2)` markers into
 *  `[1,2](cite:1,2)` markdown links, but ONLY when every number resolves to a
 *  parsed source. Code regions, inline code and existing links are untouched. */
export function linkCitations(content: string, sources: ChatSource[]): string {
  if (!content || sources.length === 0) return content;
  const known = new Set(sources.map((s) => s.n));
  const { text, store } = protectRegions(content);

  const rewrite = (raw: string, numsRaw: string): string => {
    const nums = numsRaw.split(",").map((x) => parseInt(x.trim(), 10));
    if (nums.length === 0 || nums.some((n) => !known.has(n))) return raw;
    return `[${nums.join(",")}](cite:${nums.join(",")})`;
  };

  let out = text.replace(BRACKET_CITE_RE, (match, nums) => rewrite(match, nums));
  out = out.replace(PAREN_CITE_RE, (match, nums) => rewrite(match, nums));
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => store[Number(i)] ?? "");
  return out;
}

/** Stable fingerprint of a source list, used to extend markdown render-cache
 *  keys so two messages with identical text but different sources never share
 *  a cached element tree. Empty string when there are no sources. */
export function sourcesFingerprint(sources: ChatSource[] | undefined): string {
  if (!sources || sources.length === 0) return "";
  return sources.map((s) => `${s.n}:${s.url}`).join("|");
}
