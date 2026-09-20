// Reading view for a vault note: the existing react-markdown pipeline
// (GFM + math + mermaid + Prism, the chat-grade renderers) plus the vault
// layer — wikilinks become vault:// links routed to note navigation,
// external links open the in-app browser pane, and ![[embeds]] render as
// real components (vault images as <img> via base64, nested notes as
// recursive previews, depth-capped). Vault extras: frontmatter renders as a
// read-only properties card, GFM task checkboxes are clickable when the
// caller wires onToggleTaskLine, `> [!type]` blockquotes render as Obsidian
// callouts, and image embeds/alt text support the `|300` / `|50%` width
// syntax.

import { cloneElement, isValidElement, memo, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  Bug,
  CheckCircle2,
  CircleCheckBig,
  CircleHelp,
  CircleX,
  FlaskConical,
  Info,
  Lightbulb,
  ListChecks,
  PencilLine,
  Quote,
  TriangleAlert,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MermaidDiagram } from "../chat/MermaidDiagram";
import { openInBrowserPane } from "../../lib/openBrowserPane";
import { useVaultStore } from "../../state/vault";
import { splitFrontmatter } from "../../lib/vaultFrontmatter";
import {
  decodeVaultHref,
  resolveAssetPath,
  splitEmbeds,
  wikilinksToMarkdown,
  basenameOf,
  stemOf,
  VAULT_HREF,
} from "../../lib/vaultLinks";
import type { ContentSegment } from "../../lib/vaultLinks";
import { hoverHandlers } from "./VaultLinkHover";
// (VaultLinkHover pulls VaultPreviewContent back via React.lazy — the static
// edge only ever points this way, so there is no require cycle.)

/** Max recursion for note-in-note embeds (Obsidian warns past 8; 3 is sane). */
const MAX_EMBED_DEPTH = 3;

/** Bounded LRU-ish cache (insertion-ordered Map, oldest evicted). */
const IMAGE_CACHE_MAX = 120;
const imageCache = new Map<string, Promise<string>>();

/** Shared by the note preview (embeds) and the asset view (standalone
 *  image files) — one cache, one IPC cost per image per session. */
export function cachedVaultImage(path: string): Promise<string> {
  const hit = imageCache.get(path);
  if (hit) return hit;
  const p = import("../../lib/ipc")
    .then((m) => m.vaultReadBinary(path))
    .then(([mime, b64]) => `data:${mime};base64,${b64}`);
  // Failed loads are evicted so a file added to disk later can render on
  // the next render pass (a permanently negative cache survives restarts).
  p.catch(() => {
    if (imageCache.get(path) === p) imageCache.delete(path);
  });
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  imageCache.set(path, p);
  return p;
}

function useVaultImage(path: string | null): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setDataUrl(null);
      return;
    }
    let alive = true;
    void cachedVaultImage(path).then((url) => {
      if (alive) setDataUrl(url);
    }).catch(() => {
      if (alive) setDataUrl(null);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return dataUrl;
}

/** A vault file rendered inside a note (image embeds + md images). `width`
 *  carries the Obsidian `|300` / `|50%` size suffix when one was present. */
const VaultImage = memo(function VaultImage({ path, className, width }: { path: string | null; className?: string; width?: string }) {
  const dataUrl = useVaultImage(path);
  if (!path || !dataUrl) {
    return <span className="vault-embed-missing">⟨{path ?? "invalid asset path"}⟩</span>;
  }
  return (
    <img
      className={className ?? "vault-embed-img"}
      src={dataUrl}
      alt={basenameOf(path)}
      style={width ? { width } : undefined}
    />
  );
});

/** Vault media embeds (![[song.mp3]], ![[clip.mp4]]) ride the same cached
 *  base64 pipe as images — vaultReadBinary sniffs the mime server-side, so
 *  the data: URL works for audio/video too — just into native controls
 *  instead of <img>. */
const VaultAudio = memo(function VaultAudio({ path }: { path: string | null }) {
  const dataUrl = useVaultImage(path);
  if (!path || !dataUrl) {
    return <span className="vault-embed-missing">⟨{path ?? "invalid asset path"}⟩</span>;
  }
  return <audio className="vault-embed-audio" controls src={dataUrl} />;
});

const VaultVideo = memo(function VaultVideo({ path }: { path: string | null }) {
  const dataUrl = useVaultImage(path);
  if (!path || !dataUrl) {
    return <span className="vault-embed-missing">⟨{path ?? "invalid asset path"}⟩</span>;
  }
  return <video className="vault-embed-video" controls src={dataUrl} />;
});

/** A note rendered inside a note (![[Note]] transclusion). Resolution goes
 *  through the backend index (file: search): basenames carry the extension
 *  while embed targets are conventionally extensionless, so rank by exact
 *  basename → exact STEM, shortest path first — never blindly hits[0]
 *  (`![[Daily]]` with `Daily.md` + `Daily 2026.md` present must not pick
 *  the alphabetically-first wrong note). */
const NoteEmbed = memo(function NoteEmbed({ target, depth }: { target: string; depth: number }) {
  const [content, setContent] = useState<string | null>(null);
  const [resolved, setResolved] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { vaultSearch, vaultReadNote } = await import("../../lib/ipc");
      const lc = target.toLowerCase();
      const base = lc.split("/").pop() ?? lc;
      // `?? []` — a null RESOLUTION (stub IPC, backend hiccup) must behave
      // like "no hits", same guard as the store's runSearch.
      const hits = (await vaultSearch(`file:"${target}"`, 10).catch(() => [])) ?? [];
      const ranked = hits
        .filter((h) => {
          const hb = h.basename.toLowerCase();
          const dot = hb.lastIndexOf(".");
          const stem = dot > 0 ? hb.slice(0, dot) : hb;
          return hb === base || stem === base;
        })
        .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
      const hit = ranked[0] ?? null;
      if (!alive) return;
      if (!hit) {
        setResolved(null);
        setContent(null);
        return;
      }
      setResolved(hit.path);
      const text = await vaultReadNote(hit.path).catch(() => null);
      if (alive) setContent(text);
    })();
    return () => {
      alive = false;
    };
  }, [target]);
  if (depth >= MAX_EMBED_DEPTH) {
    return <div className="vault-embed-note vault-embed-note-capped">⟨embed depth limit: {target}⟩</div>;
  }
  if (content == null) {
    return <div className="vault-embed-missing">⟨unresolved embed: {target}⟩</div>;
  }
  return (
    <div className="vault-embed-note">
      <VaultPreviewContent content={content} notePath={resolved ?? target} depth={depth + 1} />
    </div>
  );
});

/** Obsidian-style `==highlight==` — a tiny mdast transformer (no extra
 *  dependency): splits text nodes containing ==…== and maps them to <mark>
 *  elements. Code nodes are skipped so inline code keeps its literal ==. */
function remarkVaultHighlight() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (node: any) => {
    if (!node || node.type === "code" || node.type === "inlineCode") return;
    if (!Array.isArray(node.children)) return;
    const next: any[] = [];
    for (const child of node.children) {
      if (child.type === "text" && /==[^=\n]+==/.test(child.value)) {
        const parts = String(child.value ?? "").split(/==([^=\n]+)==/);
        parts.forEach((part: string, i: number) => {
          if (i % 2 === 1) {
            next.push({
              type: "emphasis",
              data: { hName: "mark", hProperties: { className: ["vault-mark"] } },
              children: [{ type: "text", value: part }],
            });
          } else if (part) {
            next.push({ type: "text", value: part });
          }
        });
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: unknown) => walk(tree);
}

/** mdast-util-to-hast builds the GFM task-list `<input>` synthetically —
 *  verified to carry NO source position, so a click could never be mapped
 *  back to the note line. Copy the parent <li>'s position onto any
 *  position-less checkbox input (same source line). No-op otherwise. */
function rehypeTaskCheckboxPositions() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visit = (node: any, parent: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "element" && node.tagName === "input" && !node.position && parent?.position) {
      node.position = parent.position;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child, node);
    }
  };
  return (tree: unknown) => {
    visit(tree, null);
  };
}

interface SegmentMeta {
  /** 0-based lines of the note body BEFORE this segment starts — react-
   *  markdown reports segment-local line numbers, callers think in whole-
   *  note lines (frontmatter + earlier embeds included). */
  lineBase: number;
  /** Raw `![[inner]]` source text of an embed segment, when relocatable. */
  rawInner: string | null;
}

/** splitEmbeds carves `![[…]]` spans out of the text, which loses both the
 *  embed's position (needed to shift checkbox line numbers into whole-note
 *  coordinates) and its raw inner text (the wikilink parser keeps only the
 *  first `|` segment, so the Obsidian trailing `|300` size is dropped).
 *  Text segments are exact slices of the source, so walking them in order
 *  with indexOf re-anchors each segment; the `![[…]]` span sits immediately
 *  after the preceding text ends. */
function segmentMetaOf(body: string, segments: ContentSegment[]): SegmentMeta[] {
  const meta: SegmentMeta[] = [];
  let from = 0;
  let lines = 0;
  let scanned = 0;
  const scanTo = (end: number) => {
    if (end <= scanned) return;
    for (let i = scanned; i < end; i += 1) {
      if (body.charCodeAt(i) === 10) lines += 1;
    }
    scanned = end;
  };
  for (const seg of segments) {
    if (seg.type === "text") {
      const pos = body.indexOf(seg.text, from);
      const start = pos === -1 ? from : pos;
      scanTo(start);
      meta.push({ lineBase: lines, rawInner: null });
      from = start + seg.text.length;
      scanTo(from);
    } else {
      scanTo(from);
      const close = body.indexOf("]]", from);
      const inner = close === -1 ? null : body.slice(from + 3, close);
      meta.push({ lineBase: lines, rawInner: inner });
      from = close === -1 ? body.length : close + 2;
      scanTo(from);
    }
  }
  return meta;
}

/** Obsidian width suffix on images: `300`, `300px`, `50%` (a bare number
 *  means pixels). Anything else → null (no width applied). */
function parseImageSize(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^\s*(\d+(?:\.\d+)?)(px|%|)\s*$/i.exec(raw);
  if (!m) return null;
  return m[2].toLowerCase() === "%" ? `${m[1]}%` : `${m[1]}px`;
}

/** Markdown-image alt width: `![alt|300](src)` — the segment after the LAST
 *  `|` becomes the width when it parses as a size, and leaves the alt. */
function altImageWidth(alt: string | undefined): { alt: string; width: string | null } {
  const raw = alt ?? "";
  const pipe = raw.lastIndexOf("|");
  if (pipe !== -1) {
    const size = parseImageSize(raw.slice(pipe + 1));
    if (size) return { alt: raw.slice(0, pipe), width: size };
  }
  return { alt: raw, width: null };
}

/** Image-embed width: `![[img.png|300]]`, `![[img|caption|300]]` — the LAST
 *  `|` segment is the size when numeric. splitEmbeds' parser keeps only the
 *  first pipe (in `display`), so prefer the raw inner text and fall back to
 *  the display segment it did keep. */
function embedImageWidth(display: string | null, rawInner: string | null): string | null {
  if (rawInner != null) {
    const pipe = rawInner.lastIndexOf("|");
    if (pipe !== -1) {
      const size = parseImageSize(rawInner.slice(pipe + 1));
      if (size) return size;
    }
    return null;
  }
  return parseImageSize(display);
}

/** Flatten React children to text. `<br>` (which remarkBreaks plants for
 *  soft line breaks) counts as "\n" so callout title/body can be split the
 *  same way on source lines and on rendered children. */
function firstText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child) => firstText(child)).join("");
  if (isValidElement(node)) {
    if (node.type === "br") return "\n";
    const props = node.props as { children?: unknown } | undefined;
    return firstText(props?.children);
  }
  return "";
}

/** Remove the first `count` characters of the flattened text from rendered
 *  children: strings are sliced, wholly-consumed children are dropped, and
 *  an element cut mid-way recurses into its own children. Zero-text nodes
 *  in the cut region (the title's trailing <br>) disappear with it. */
function stripLeadingText(nodes: ReactNode, count: number): ReactNode {
  if (count <= 0) return nodes;
  if (typeof nodes === "string") return nodes.slice(count);
  if (typeof nodes === "number") return String(nodes).slice(count);
  if (Array.isArray(nodes)) {
    const out: ReactNode[] = [];
    let left = count;
    for (const child of nodes) {
      if (left <= 0) {
        out.push(child);
        continue;
      }
      const len = firstText(child).length;
      if (len <= left) {
        left -= len;
      } else {
        out.push(stripLeadingText(child, left));
        left = 0;
      }
    }
    return out;
  }
  if (isValidElement(nodes)) {
    const props = nodes.props as { children?: ReactNode };
    return cloneElement(nodes, undefined, stripLeadingText(props?.children, count));
  }
  return nodes;
}

/** Obsidian callouts: every marker name → its canonical CSS class + lucide
 *  icon. Aliases share the canonical class so CSS stays one rule per kind;
 *  unknown types fall back to the note styling. */
const CALLOUT_KINDS: Record<string, { cls: string; icon: LucideIcon }> = {
  note: { cls: "note", icon: PencilLine },
  abstract: { cls: "abstract", icon: ListChecks },
  summary: { cls: "abstract", icon: ListChecks },
  tldr: { cls: "abstract", icon: ListChecks },
  info: { cls: "info", icon: Info },
  todo: { cls: "todo", icon: CircleCheckBig },
  tip: { cls: "tip", icon: Lightbulb },
  hint: { cls: "tip", icon: Lightbulb },
  important: { cls: "tip", icon: Lightbulb },
  success: { cls: "success", icon: CheckCircle2 },
  check: { cls: "success", icon: CheckCircle2 },
  done: { cls: "success", icon: CheckCircle2 },
  question: { cls: "question", icon: CircleHelp },
  help: { cls: "question", icon: CircleHelp },
  faq: { cls: "question", icon: CircleHelp },
  warning: { cls: "warning", icon: TriangleAlert },
  caution: { cls: "warning", icon: TriangleAlert },
  attention: { cls: "warning", icon: TriangleAlert },
  failure: { cls: "failure", icon: CircleX },
  fail: { cls: "failure", icon: CircleX },
  missing: { cls: "failure", icon: CircleX },
  danger: { cls: "danger", icon: Zap },
  error: { cls: "danger", icon: Zap },
  bug: { cls: "bug", icon: Bug },
  example: { cls: "example", icon: FlaskConical },
  quote: { cls: "quote", icon: Quote },
  cite: { cls: "quote", icon: Quote },
};

/** Default titles that aren't just the capitalized type name. */
const CALLOUT_TITLE_FIXUPS: Record<string, string> = {
  tldr: "TL;DR",
  faq: "FAQ",
};

const CALLOUT_MARKER_RE = /^\s*\[!([A-Za-z][\w-]*)\][+-]?[ \t]*/;

const Md = memo(function Md({
  text,
  notePath,
  lineBase = 0,
  onToggleTaskLine,
}: {
  text: string;
  notePath: string;
  /** 0-based lines before this text segment within the whole note (separating
   *  frontmatter and embeds shift segment-local line numbers). */
  lineBase?: number;
  /** Present → GFM task checkboxes are clickable and report their 1-based
   *  whole-note line; the caller owns the actual content mutation. */
  onToggleTaskLine?: (line: number) => void;
}) {
  const openNote = useVaultStore((s) => s.openNote);
  const transformed = useMemo(() => wikilinksToMarkdown(text), [text]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkVaultHighlight, remarkGfm, remarkBreaks, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false }], rehypeTaskCheckboxPositions]}
      urlTransform={(url) => {
        // vault:// links and data: images are produced by THIS pipeline;
        // everything else defers to the library's default sanitizer (the
        // previous identity transform disabled URL sanitizing entirely and
        // was only safe while the a/img overrides were the sole URL sinks).
        if (url.startsWith(VAULT_HREF) || url.startsWith("data:image/")) return url;
        return defaultUrlTransform(url);
      }}
      components={{
        a: ({ href, children }) => {
          if (href) {
            const decoded = decodeVaultHref(href);
            if (decoded) {
              const target = decoded.target || notePath;
              return (
                <a
                  className="vault-link"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    if (!decoded.target) {
                      // Same-note heading link — scroll the preview.
                      window.dispatchEvent(
                        new CustomEvent("vault:scroll-text", { detail: { text: decoded.subpath?.slice(1) ?? "" } }),
                      );
                    } else {
                      void openNote(target, decoded.subpath);
                    }
                  }}
                  {...(decoded.target
                    ? // Page preview only for cross-note links: hovering a
                      // same-note heading link would preview the note the
                      // reader is already inside.
                      hoverHandlers(target, notePath)
                    : {})}
                >
                  {children}
                </a>
              );
            }
            if (/^https?:\/\//i.test(href)) {
              return (
                <a
                  className="vault-link"
                  href="#"
                  title={`${href} (opens in the built-in browser)`}
                  onClick={(e) => {
                    e.preventDefault();
                    openInBrowserPane(href);
                  }}
                >
                  {children}
                </a>
              );
            }
            if (href.startsWith("#")) {
              // Same-note anchors (GFM footnotes `#fn`/`#fnref`, manual
              // heading anchors): route through the scroll handler.
              return (
                <a
                  className="vault-link"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    window.dispatchEvent(
                      new CustomEvent("vault:scroll-text", { detail: { text: href.slice(1) } }),
                    );
                  }}
                >
                  {children}
                </a>
              );
            }
            // A plain relative link to another vault note ([x](Note.md)) —
            // was rendered href-less (dead). Percent-decode, strip the
            // extension and let openNote resolve it like a wikilink.
            if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
              let decoded = href;
              try {
                decoded = decodeURIComponent(href);
              } catch {
                // keep raw form on malformed encoding
              }
              const [rawTarget, subpath] = decoded.split("#", 2);
              const target = rawTarget.replace(/\.md$/i, "");
              if (target) {
                return (
                  <a
                    className="vault-link"
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      void openNote(target, subpath ? `#${subpath}` : null);
                    }}
                    {...hoverHandlers(target, notePath)}
                  >
                    {children}
                  </a>
                );
              }
            }
          }
          return <a className="vault-link">{children}</a>;
        },
        img: ({ src, alt }) => {
          const raw = typeof src === "string" ? src : "";
          const { alt: altText, width } = altImageWidth(alt);
          const style = width ? { width } : undefined;
          if (raw.startsWith("data:")) {
            return <img className="vault-embed-img" src={raw} alt={altText} style={style} />;
          }
          if (raw && !/^(https?:)?\/\//i.test(raw)) {
            return <VaultImage path={resolveAssetPath(notePath, raw.replace(/^\.\//, ""))} width={width ?? undefined} />;
          }
          return <img src={raw} alt={altText} style={style} />;
        },
        blockquote: ({ children }) => {
          // Obsidian callouts: `> [!type] Title` (fold markers `-`/`+` are
          // accepted but ignored — callouts always render expanded). The
          // first child paragraph carries the marker; everything after it
          // stays untouched below the title row. No marker → plain
          // blockquote, styled exactly as before.
          const kids = Array.isArray(children) ? children : [children];
          // react-markdown interleaves whitespace text nodes between block
          // children, so the marker paragraph is the first ELEMENT child,
          // not kids[0].
          const first = kids.find((k) => isValidElement(k) && k.type === "p");
          const paraProps = first ? (first.props as { children?: ReactNode }) : null;
          const flat = paraProps ? firstText(paraProps.children) : "";
          const marker = CALLOUT_MARKER_RE.exec(flat);
          if (!paraProps || !marker) {
            return <blockquote>{children}</blockquote>;
          }
          const rawType = marker[1].toLowerCase();
          const kind = CALLOUT_KINDS[rawType] ?? { cls: "note", icon: PencilLine };
          const Icon = kind.icon;
          // The title line is the marker-line remainder; the rest of the
          // paragraph (if any) becomes the callout body's first paragraph.
          const rest = flat.slice(marker[0].length);
          const nl = rest.indexOf("\n");
          const titleLine = (nl === -1 ? rest : rest.slice(0, nl)).trim();
          const title =
            titleLine ||
            CALLOUT_TITLE_FIXUPS[rawType] ||
            (rawType.charAt(0).toUpperCase() + rawType.slice(1));
          // Cut the marker + title line (+ its newline/<br>) out of the
          // rendered children. `firstText` counts <br> as "\n", so the flat
          // index and the child walk stay in sync. The cut can land at the
          // start of a text node remarkBreaks left a "\n" in — trim it.
          let bodyPara =
            nl !== -1
              ? stripLeadingText(paraProps.children, marker[0].length + nl + 1)
              : null;
          if (Array.isArray(bodyPara) && typeof bodyPara[0] === "string") {
            bodyPara = [bodyPara[0].replace(/^\s+/, ""), ...bodyPara.slice(1)];
          }
          const hasBodyPara = bodyPara != null && firstText(bodyPara).trim() !== "";
          return (
            <div className={`vault-callout vault-callout-${kind.cls}`}>
              <div className="vault-callout-title">
                <Icon className="vault-callout-icon" size={14} />
                <span>{title}</span>
              </div>
              <div className="vault-callout-body">
                {hasBodyPara && <p>{bodyPara}</p>}
                {kids.filter((k) => k !== first)}
              </div>
            </div>
          );
        },
        pre: ({ children }) => {
          // Mermaid fences route to the theme-aware renderer; other code
          // keeps plain (Prism comes via the chat pipeline in a later pass).
          const child = Array.isArray(children) ? children[0] : children;
          const cls = (child as { props?: { className?: string } } | undefined)?.props?.className ?? "";
          return <pre className={`vault-pre ${cls}`}>{children}</pre>;
        },
        code: ({ className, children }) => {
          const text = String(children ?? "");
          if (className?.includes("language-mermaid")) {
            return <MermaidDiagram code={text} />;
          }
          return (
            <code className={className}>
              {text}
              {/* react-markdown nests the raw text; trailing newline trimmed */}
            </code>
          );
        },
        input: (p) => {
          // react-markdown hands the hast node through `p` — it must never
          // reach the DOM. When a toggle handler is wired, GFM checkboxes go
          // live and report their whole-note line (rehypeTaskCheckboxPositions
          // guarantees the node carries one); otherwise they stay inert.
          const { node, checked, disabled, ...rest } = p;
          const toggle = onToggleTaskLine;
          const line = toggle ? node?.position?.start?.line : undefined;
          if (toggle && typeof line === "number") {
            return (
              <input
                {...rest}
                type="checkbox"
                className="vault-task-checkbox"
                checked={checked ?? false}
                onChange={() => toggle(lineBase + line)}
              />
            );
          }
          return <input {...rest} disabled readOnly />;
        },
      }}
    >
      {transformed}
    </ReactMarkdown>
  );
});

/** The full note body: frontmatter as a read-only properties card, text
 *  segments through the markdown pipeline, embeds as components. */
export function VaultPreviewContent({
  content,
  notePath,
  depth = 0,
  onToggleTaskLine,
}: {
  content: string;
  notePath: string;
  depth?: number;
  /** Present → clickable task checkboxes reporting whole-note lines. */
  onToggleTaskLine?: (line: number) => void;
}) {
  // Frontmatter never reaches the markdown renderer (raw YAML is ugly);
  // it becomes a properties card instead. Embeds/hover cards benefit too.
  const { data: properties, body, raw } = useMemo(() => splitFrontmatter(content), [content]);
  const segments = useMemo(() => splitEmbeds(body), [body]);
  const propertyKeys = Object.keys(properties);
  // Lines the body starts at in the whole note: leading blanks + the fence
  // block (frontmatter splitting tolerates both, so derive rather than
  // assume). Task toggle lines are reported in whole-note coordinates.
  const frontmatterLines = useMemo(() => {
    if (!raw) return 0;
    let lead = 0;
    for (const line of content.split("\n")) {
      if (line.trim() === "") lead += 1;
      else break;
    }
    return lead + raw.split("\n").length;
  }, [content, raw]);
  const metas = useMemo(() => segmentMetaOf(body, segments), [body, segments]);
  return (
    <div className="vault-preview" data-note={notePath}>
      {propertyKeys.length > 0 && (
        <div className="vault-properties">
          {propertyKeys.map((key) => {
            const value = properties[key];
            return (
              <div key={key} className="vault-property">
                <span className="vault-property-key">{key}</span>
                <span className="vault-property-value">
                  {Array.isArray(value) ? (value.length > 0 ? value.join(", ") : "—") : value}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {segments.map((seg, i) => {
        const meta = metas[i] ?? { lineBase: 0, rawInner: null };
        if (seg.type === "text") {
          return (
            <Md
              key={i}
              text={seg.text}
              notePath={notePath}
              lineBase={frontmatterLines + meta.lineBase}
              onToggleTaskLine={onToggleTaskLine}
            />
          );
        }
        const isImage = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i.test(seg.target);
        if (isImage) {
          return (
            <VaultImage
              key={i}
              path={resolveAssetPath(notePath, seg.target)}
              className="vault-embed-img"
              width={embedImageWidth(seg.display, meta.rawInner) ?? undefined}
            />
          );
        }
        // Media embeds render inline with native controls (before the .md
        // / attachment fallthrough, which would relegate them to a link).
        if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(seg.target)) {
          return <VaultAudio key={i} path={resolveAssetPath(notePath, seg.target)} />;
        }
        if (/\.(mp4|webm|mov)$/i.test(seg.target)) {
          return <VaultVideo key={i} path={resolveAssetPath(notePath, seg.target)} />;
        }
        if (/\.md$/i.test(seg.target) || !seg.target.includes(".")) {
          // A note embed — resolve and transclude.
          return <NoteEmbed key={i} target={seg.target} depth={depth} />;
        }
        // Other assets (pdf, audio, …) open in the asset view — NOT the
        // note path (that toasted "no note named …" for every pdf), and
        // NOT "unresolved": the file may well exist.
        return (
          <a
            key={i}
            className="vault-link vault-embed-asset"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              const resolvedPath = resolveAssetPath(notePath, seg.target);
              if (resolvedPath) void useVaultStore.getState().openFile(resolvedPath);
            }}
          >
            ⟨attachment: {seg.target}⟩
          </a>
        );
      })}
    </div>
  );
}

/** Standalone reading view for the active note (handles the frontmatter
 *  display and the scroll-to-heading event). */
export function VaultPreview({
  content,
  notePath,
  onToggleTaskLine,
}: {
  content: string;
  notePath: string;
  /** Called with the 1-based whole-note line of a clicked task checkbox;
   *  flipping `[ ]`↔`[x]` in the content is the caller's job. Optional —
   *  without it the preview is fully read-only. */
  onToggleTaskLine?: (line: number) => void;
}) {
  const meta = useVaultStore((s) => s.meta);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { text: string };
      const el = document.querySelector(`[data-note="${CSS.escape(notePath)}"]`);
      if (!el) return;
      const text = (detail.text ?? "").toLowerCase();
      const headings = Array.from(el.querySelectorAll("h1,h2,h3,h4,h5,h6"));
      const target = headings.find((h) => h.textContent?.trim().toLowerCase() === text);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("vault:scroll-text", handler);
    return () => window.removeEventListener("vault:scroll-text", handler);
  }, [notePath]);
  void meta;
  return (
    <>
      <VaultPreviewContent content={content} notePath={notePath} onToggleTaskLine={onToggleTaskLine} />
    </>
  );
}
