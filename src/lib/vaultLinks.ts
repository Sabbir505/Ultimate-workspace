// Vault link utilities — the frontend half of the Obsidian-flavored link
// spec (the Rust half lives in src-tauri/src/vault/parse.rs; the two share a
// documented subset, enforced by tests on both sides). Used by the note
// preview (wikilink → standard-link transform + embed splitting), the quick
// switcher, and the editor's click handling.

/** Internal scheme for transformed wikilinks: `vault://<target>#<subpath>`.
 *  Rendered as ordinary markdown links, intercepted by the preview's <a>. */
export const VAULT_HREF = "vault://";

export interface WikiLinkToken {
  /** Link target WITHOUT display text or subpath ("" for `[[#Heading]]`). */
  target: string;
  display: string | null;
  /** `#Heading` / `#^blockid` including the `#`, when present. */
  subpath: string | null;
  isEmbed: boolean;
}

/** Split `target|display#subpath` into its parts (no positions — for the
 *  editor's decoration scan and the quick switcher). */
export function parseWikiLinkInner(inner: string): WikiLinkToken {
  const [targetPart, display] = inner.split("|", 2) as [string, string?];
  const hashIdx = targetPart.indexOf("#");
  const target = hashIdx === -1 ? targetPart : targetPart.slice(0, hashIdx);
  const subpath = hashIdx === -1 ? null : targetPart.slice(hashIdx);
  return {
    target: target.trim(),
    display: display?.trim() ?? null,
    subpath,
    isEmbed: false,
  };
}

/** Encode target+subpath into a vault:// href for markdown rendering. */
export function encodeVaultHref(target: string, subpath?: string | null): string {
  return VAULT_HREF + encodeURIComponent(target) + (subpath ?? "");
}

/** Decode a vault:// href back into (target, subpath). Non-vault hrefs → null. */
export function decodeVaultHref(href: string): { target: string; subpath: string | null } | null {
  if (!href.startsWith(VAULT_HREF)) return null;
  let rest = href.slice(VAULT_HREF.length);
  let subpath: string | null = null;
  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) {
    subpath = rest.slice(hashIdx);
    rest = rest.slice(0, hashIdx);
  }
  let target = rest;
  try {
    target = decodeURIComponent(rest);
  } catch {
    // Malformed percent-encoding: use the raw form.
  }
  return { target, subpath };
}

export type ContentSegment =
  | { type: "text"; text: string }
  | { type: "embed"; target: string; display: string | null; subpath: string | null };

/**
 * Split note content into markdown text segments and embeds
 * (`![[file]]` / `![[Note]]`), so the preview can render note-embeds and
 * vault images as real components instead of markdown links. Inline code is
 * respected: an embed inside backticks stays text.
 */
export function splitEmbeds(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let buf = "";
  let i = 0;
  let inCode = false;
  const pushText = () => {
    if (buf) segments.push({ type: "text", text: buf });
    buf = "";
  };
  while (i < content.length) {
    const ch = content[i];
    if (ch === "`") {
      inCode = !inCode;
      buf += ch;
      i += 1;
      continue;
    }
    if (inCode) {
      buf += ch;
      i += 1;
      continue;
    }
    // ![[ ... ]]
    if (ch === "!" && content.startsWith("[[", i + 1)) {
      const close = content.indexOf("]]", i + 3);
      if (close !== -1) {
        const inner = content.slice(i + 3, close);
        const tok = parseWikiLinkInner(inner);
        pushText();
        segments.push({ type: "embed", target: tok.target, display: tok.display, subpath: tok.subpath });
        i = close + 2;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  pushText();
  return segments;
}

/**
 * Replace `[[...]]` wikilinks with standard markdown links (vault:// hrefs)
 * so react-markdown renders them as <a> and the preview's link handler can
 * route them. Inline code spans are skipped. Embeds are handled separately
 * by splitEmbeds (this function can run on its output text segments, where
 * `![[…]]` no longer occurs).
 */
export function wikilinksToMarkdown(text: string): string {
  let out = "";
  let i = 0;
  let inCode = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      inCode = !inCode;
      out += ch;
      i += 1;
      continue;
    }
    if (inCode) {
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "[" && text.startsWith("[[", i)) {
      const close = text.indexOf("]]", i + 2);
      if (close !== -1) {
        const tok = parseWikiLinkInner(text.slice(i + 2, close));
        const label = tok.display ?? (tok.target || tok.subpath?.slice(1) || "link");
        out += `[${label}](${encodeVaultHref(tok.target, tok.subpath)})`;
        i = close + 2;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Strip frontmatter + markers from a snippet for single-line display. */
export function snippetToPlain(snippet: string): string {
  return snippet
    .replace(/⟨/g, "")
    .replace(/⟩/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Path utilities (vault-relative, forward slashes — mirrors Rust). */
export function basenameOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base;
}
export function stemOf(path: string): string {
  const base = basenameOf(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
export function folderOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}
/** Collapse `.`/`..` segments lexically (the backend's safe_join rejects any
 *  literal `..`, so `![[../assets/img.png]]` — valid Obsidian — must arrive
 *  at the IPC boundary already normalized). Returns null when the path
 *  escapes the vault root. */
function collapseRelPath(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** Resolve an image/asset target for the preview: './x' and bare 'x' are
 *  relative to the note's folder, `../`-spelled relatives collapse
 *  lexically, folder-qualified spellings are vault-relative. */
export function resolveAssetPath(notePath: string, target: string): string | null {
  const clean = target.replace(/^\.\//, "");
  const startsDotDot = target.startsWith("../");
  const isVaultRelative = target.includes("/") && !target.startsWith("./") && !startsDotDot;
  if (isVaultRelative) {
    return clean.startsWith("/") ? clean.slice(1) : clean;
  }
  const folder = folderOf(notePath);
  const joined = folder ? `${folder}/${clean}` : clean;
  return collapseRelPath(joined);
}
