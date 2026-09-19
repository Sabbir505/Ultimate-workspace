// Reading view for a vault note: the existing react-markdown pipeline
// (GFM + math + mermaid + Prism, the chat-grade renderers) plus the vault
// layer — wikilinks become vault:// links routed to note navigation,
// external links open the in-app browser pane, and ![[embeds]] render as
// real components (vault images as <img> via base64, nested notes as
// recursive previews, depth-capped).

import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
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
} from "../../lib/vaultLinks";

/** Max recursion for note-in-note embeds (Obsidian warns past 8; 3 is sane). */
const MAX_EMBED_DEPTH = 3;

const imageCache = new Map<string, Promise<string>>();

function useVaultImage(path: string | null): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setDataUrl(null);
      return;
    }
    let alive = true;
    let p = imageCache.get(path);
    if (!p) {
      p = import("../../lib/ipc").then((m) => m.vaultReadBinary(path)).then(([mime, b64]) => `data:${mime};base64,${b64}`);
      imageCache.set(path, p);
    }
    void p.then((url) => {
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
const VaultImage = memo(function VaultImage({ path, className }: { path: string; className?: string }) {
  const dataUrl = useVaultImage(path);
  if (!dataUrl) {
    return <span className="vault-embed-missing">⟨{path}⟩</span>;
  }
  return <img className={className ?? "vault-embed-img"} src={dataUrl} alt={basenameOf(path)} />;
});

/** A note rendered inside a note (![[Note]] transclusion). Resolution goes
 *  through the backend index (file: search), so aliases resolve too. */
const NoteEmbed = memo(function NoteEmbed({ target, depth }: { target: string; depth: number }) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { vaultSearch, vaultReadNote } = await import("../../lib/ipc");
      const hits = await vaultSearch(`file:"${target}"`, 5).catch(() => []);
      const hit = hits.find((h) => h.basename === target) ?? hits[0];
      if (!alive) return;
      if (!hit) {
        setContent(null);
        return;
      }
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
      <VaultPreviewContent content={content} notePath={target} depth={depth + 1} />
    </div>
  );
});

const Md = memo(function Md({ text, notePath }: { text: string; notePath: string }) {
  const openNote = useVaultStore((s) => s.openNote);
  const transformed = useMemo(() => wikilinksToMarkdown(text), [text]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
      urlTransform={(url) => {
        // vault:// links and data: images pass through; relative asset paths
        // resolve against the note's folder for the img component.
        return url;
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
        // Other assets (pdf, audio, …) render as an openable link chip for
        // now — NOT "unresolved", the file may well exist.
        return (
          <a
            key={i}
            className="vault-link vault-embed-asset"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              void useVaultStore.getState().openNote(seg.target);
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
