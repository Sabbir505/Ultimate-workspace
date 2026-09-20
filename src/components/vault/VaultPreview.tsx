// Reading view for a vault note: the existing react-markdown pipeline
// (GFM + math + mermaid + Prism, the chat-grade renderers) plus the vault
// layer — wikilinks become vault:// links routed to note navigation,
// external links open the in-app browser pane, and ![[embeds]] render as
// real components (vault images as <img> via base64, nested notes as
// recursive previews, depth-capped).

import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { MermaidDiagram } from "../chat/MermaidDiagram";
import { openInBrowserPane } from "../../lib/openBrowserPane";
import { useVaultStore } from "../../state/vault";
import {
  decodeVaultHref,
  resolveAssetPath,
  splitEmbeds,
  wikilinksToMarkdown,
  basenameOf,
  stemOf,
  VAULT_HREF,
} from "../../lib/vaultLinks";

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

/** A vault file rendered inside a note (image embeds + md images). */
const VaultImage = memo(function VaultImage({ path, className }: { path: string | null; className?: string }) {
  const dataUrl = useVaultImage(path);
  if (!path || !dataUrl) {
    return <span className="vault-embed-missing">⟨{path ?? "invalid asset path"}⟩</span>;
  }
  return <img className={className ?? "vault-embed-img"} src={dataUrl} alt={basenameOf(path)} />;
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
      const hits = await vaultSearch(`file:"${target}"`, 10).catch(() => []);
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

const Md = memo(function Md({ text, notePath }: { text: string; notePath: string }) {
  const openNote = useVaultStore((s) => s.openNote);
  const transformed = useMemo(() => wikilinksToMarkdown(text), [text]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkVaultHighlight, remarkGfm, remarkBreaks, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
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
          if (raw.startsWith("data:")) {
            return <img className="vault-embed-img" src={raw} alt={alt ?? ""} />;
          }
          if (raw && !/^(https?:)?\/\//i.test(raw)) {
            return <VaultImage path={resolveAssetPath(notePath, raw.replace(/^\.\//, ""))} />;
          }
          return <img src={raw} alt={alt ?? ""} />;
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
        input: (p) => <input {...p} disabled />,
      }}
    >
      {transformed}
    </ReactMarkdown>
  );
});

/** The full note body: text segments through the markdown pipeline, embeds
 *  as components. */
export function VaultPreviewContent({
  content,
  notePath,
  depth = 0,
}: {
  content: string;
  notePath: string;
  depth?: number;
}) {
  const segments = useMemo(() => splitEmbeds(content), [content]);
  return (
    <div className="vault-preview" data-note={notePath}>
      {segments.map((seg, i) => {
        if (seg.type === "text") {
          return <Md key={i} text={seg.text} notePath={notePath} />;
        }
        const isImage = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i.test(seg.target);
        if (isImage) {
          return <VaultImage key={i} path={resolveAssetPath(notePath, seg.target)} className="vault-embed-img" />;
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
export function VaultPreview({ content, notePath }: { content: string; notePath: string }) {
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
  return <VaultPreviewContent content={content} notePath={notePath} />;
}
