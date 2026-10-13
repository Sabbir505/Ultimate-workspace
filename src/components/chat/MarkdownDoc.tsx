// The full-fidelity markdown document renderer, shared by every surface that
// shows a .md document: the artifact preview pane (.md files), the PR/issue
// bodies in the Pulls panel, and future doc readers.
//
// PERF / CHUNKING: this module must only be imported lazily. It statically
// pulls the remark/rehype pipeline, KaTeX's stylesheet, Prism's highlighter
// and Mermaid — all of which used to sit in the entry chunk and delay first
// paint (see LazyMarkdown.tsx). Callers outside the lazy tool-panel chunk
// (e.g. PullsPanel) reach it through React.lazy(() => import(...)).
import { useCallback, useMemo, isValidElement } from "react";
import { LazyReactMarkdown, defaultUrlTransform } from "../common/LazyMarkdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
// PERF rec #3 (2026-09-06): this chunk imports katex.min.css — math can
// only render inside a markdown document, so the stylesheet (and the fonts it
// references) arrives with this lazy chunk instead of eagerly at boot.
// Vite dedupes the module across chunks (single emitted copy — C8 holds).
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { useSyntaxTheme } from "../../hooks/useSyntaxTheme";
import { ChatCitation } from "./ChatCitation";
import { MarkdownTable } from "./MarkdownTable";
import { MermaidDiagram } from "./MermaidDiagram";
import { linkCitations, parseChatSources } from "../../lib/chatCitations";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { MdLink } from "./MdLink";

// react-markdown's default URL sanitizer strips unknown schemes — including
// the internal `cite:` links the citation rewriter emits. Pass those through
// untouched; everything else keeps the default sanitization.
function citeUrlTransform(url: string): string {
  return url.startsWith("cite:") ? url : defaultUrlTransform(url);
}

/** Markdown document renderer (PERF): the parse runs in a useMemo keyed on
 *  the document text, so a parent re-render (ToolPanel ticks on every chat
 *  token) can't re-parse a large .md — only an actual document change re-runs
 *  remark/rehype. Long documents additionally rely on the `content-visibility`
 *  CSS on .artifact-preview-md to keep scrolling cheap.
 *
 *  Shares the chat bubble's markdown UX: interactive `[1]` / `(1,2)` citation
 *  chips (research docs carry their own Sources section), tables with a
 *  Copy/CSV toolbar, links opening in the built-in browser pane, and single-`$`
 *  text left as-is so "$5 and $10" doesn't collapse into KaTeX math. */
export function MarkdownDocument({ text }: { text: string }) {
  const rendered = useMemo(() => {
    const sources = parseChatSources(text);
    const body = sources.length > 0 ? linkCitations(text, sources) : text;
    return (
      <LazyReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={citeUrlTransform}
        components={{
          table: MarkdownTable,
          // ```mermaid fences render as diagrams, not code blocks — the
          // same pipeline chat messages use (MermaidDiagram).
          code({ node: _node, className, children, ...props }) {
            if (/language-mermaid\b/.test(className ?? "")) {
              return <MermaidDiagram code={String(children).replace(/\n$/, "")} />;
            }
            return <code className={className} {...props}>{children}</code>;
          },
          // Fenced blocks get the chat-style chrome — a language label and a
          // working Copy button. A generated doc whose content is meant to be
          // copied ("give me a post I can copy") used to render as bare
          // <pre> text with no affordance, and long unbroken lines pushed
          // past the pane edge.
          pre({ children }) {
            // react-markdown v9 hands `pre` the UNRESOLVED code-component
            // element (type = the component fn, not the "code" tag), so the
            // language/text are read from its props.
            const child = Array.isArray(children) ? children[0] : children;
            if (!isValidElement(child)) return <>{children}</>;
            const { className, children: rawChildren } = (child.props ??
              {}) as { className?: string; children?: unknown };
            const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
            if (lang === "mermaid") {
              // Diagrams flow through the code override above — no chrome.
              return <>{children}</>;
            }
            const code = String(
              Array.isArray(rawChildren) ? rawChildren.join("") : (rawChildren ?? ""),
            ).replace(/\n$/, "");
            return (
              <div className="doc-code-block">
                <div className="doc-code-header">
                  <span className="doc-code-lang">{lang ?? "text"}</span>
                  <MdCopyButton code={code} />
                </div>
                <ArtifactCodeBlock code={code} language={lang ?? "text"} />
              </div>
            );
          },
          a({ href, children }) {
            if (sources.length > 0 && href?.startsWith("cite:")) {
              const nums = href
                .slice("cite:".length)
                .split(",")
                .map((x) => parseInt(x, 10))
                .filter((n) => Number.isFinite(n));
              return <ChatCitation nums={nums} sources={sources} />;
            }
            return <MdLink href={href}>{children}</MdLink>;
          },
        }}
      >
        {body}
      </LazyReactMarkdown>
    );
  }, [text]);
  return rendered;
}

/** Copy affordance for fenced code blocks in the markdown preview — same
 *  behavior as the chat bubble's CopyButton (clipboard API, transient label). */
function MdCopyButton({ code }: { code: string }) {
  const [copied, copyToClipboard] = useCopyToClipboard(1800);
  const handleCopy = useCallback(async () => {
    await copyToClipboard(code);
  }, [code, copyToClipboard]);
  return (
    <button type="button" className="ghost copy-code-btn" onClick={() => void handleCopy()}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Code-block renderer for markdown docs and code previews — uses the current
 *  theme's syntax tokens (--syntax-*) so colors track data-theme. */
export function ArtifactCodeBlock({ code, language }: { code: string; language: string }) {
  const theme = useSyntaxTheme();
  return (
    <SyntaxHighlighter
      style={theme}
      language={language}
      PreTag="div"
      customStyle={{
        margin: 0,
        background: "transparent",
        padding: "12px 16px",
        fontSize: "12px",
        fontFamily: "var(--font-mono)",
        lineHeight: 1.5,
        // Wrap instead of scrolling sideways: a long line makes the code view
        // taller, so the file is readable without dragging the pane's
        // col-resize divider wider. Mirrors the chat code blocks.
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
      codeTagProps={{
        style: { fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
      }}
    >
      {code}
    </SyntaxHighlighter>
  );
}
