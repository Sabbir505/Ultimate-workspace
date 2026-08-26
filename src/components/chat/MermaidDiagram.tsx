// Renders a fenced ```mermaid diagram block as SVG, inline in the chat
// message. Mermaid is loaded lazily (its bundle is heavy) and only on the
// first diagram; subsequent diagrams reuse the initialized singleton.
//
// During streaming the diagram source is incomplete, so we don't try to
// render on every token. We render once the source is "settled" (no change
// for ~250ms) and fall back to showing the raw source + a note if rendering
// fails — so a half-streamed or malformed diagram is never a blank box.
//
// While the diagram is still being created we show "Creating the diagram of
// <topic>…" where <topic> is a short label guessed from the source.
import { memo, useEffect, useRef, useState } from "react";
import { sanitizeSvg } from "../../lib/sanitize";
import { DiagramLightbox } from "./DiagramLightbox";

export interface MermaidDiagramProps {
  /** The raw mermaid source (the text inside the ```mermaid fence). */
  code: string;
}

type MermaidModule = typeof import("mermaid").default;
type RenderResult = { svg: string };

// Mermaid is only imported client-side, inside an effect, so the heavy
// bundle stays out of the initial page path and never runs under SSR/tests.
let lastTheme: string | null = null;

async function loadMermaid(theme: string): Promise<MermaidModule> {
  const mod = await import("mermaid");
  const mermaid = mod.default;
  // Read token values from CSS custom properties so diagrams track the
  // app's data-theme instead of being pinned to one palette.
  const cs = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const tok = (name: string, fallback: string) =>
    cs ? cs.getPropertyValue(name).trim() || fallback : fallback;
  // Re-init only when the theme actually changes — cheap no-op otherwise.
  if (lastTheme !== theme) {
    const isDark = theme === "dark";
    mermaid.initialize({
      startOnLoad: false,
      // "antiscript" (not "loose") strips <script> from labels while keeping
      // htmlLabels/foreignObject working. It is only the FIRST layer: label
      // HTML still reaches the DOM with inline event handlers intact, so the
      // rendered SVG is ALSO run through sanitizeSvg() before injection.
      securityLevel: "antiscript",
      theme: isDark ? "dark" : "default",
      fontFamily: "var(--font-sans)",
      themeVariables: isDark
        ? {
            // Transparent canvas so the diagram floats on the app surface.
            background: "transparent",
            mainBkg: tok("--surface-2", "#1f1f1f"),
            secondBkg: tok("--surface-glass-2", "#252525"),
            tertiaryBkg: tok("--surface-glass", "#1e1e1e"),
            // Cool neutral edges/text; cyan primary accent.
            lineColor: tok("--syntax-operator", "#d4d4d4"),
            textColor: tok("--text", "#e4e4e4"),
            edgeLabelBackground: "transparent",
            primaryColor: tok("--accent", "#88C0D0"),
            primaryTextColor: tok("--editor-bg", "#1a1a1a"),
            primaryBorderColor: tok("--accent", "#88C0D0"),
            secondaryColor: tok("--surface-glass-2", "#252525"),
            secondaryTextColor: tok("--text", "#e4e4e4"),
            secondaryBorderColor: tok("--border-strong", "#3a3a3a"),
            tertiaryColor: tok("--surface-2", "#1f1f1f"),
            tertiaryTextColor: tok("--text", "#e4e4e4"),
            tertiaryBorderColor: tok("--border", "#2a2a2a"),
            fontSize: "14px",
          }
        : {
            background: "transparent",
            lineColor: tok("--text", "#1a1a1a"),
            textColor: tok("--text", "#1a1a1a"),
            edgeLabelBackground: "transparent",
            primaryColor: tok("--accent", "#0078a8"),
            primaryTextColor: "#ffffff",
            primaryBorderColor: tok("--accent", "#0078a8"),
            secondaryColor: tok("--surface-2", "#f3f3f3"),
            secondaryTextColor: tok("--text", "#1a1a1a"),
            secondaryBorderColor: tok("--border", "#e0e0e0"),
            tertiaryColor: tok("--surface", "#ffffff"),
            tertiaryTextColor: tok("--text", "#1a1a1a"),
            tertiaryBorderColor: tok("--border", "#e0e0e0"),
            fontSize: "14px",
          },
    });
    lastTheme = theme;
  }
  return mermaid;
}

/// Normalize the rendered SVG so it displays cleanly in-app: strip the solid
/// background Mermaid bakes in (so the diagram floats on the app's glass
/// surface) and ensure the viewBox drives scaling so the diagram shrinks to
/// fit the chat column without clipping node text.
///
/// We strip any explicit width/height attributes Mermaid emits and keep only
/// the viewBox. With a viewBox present, the CSS `max-width: 100%` scales the
/// SVG down proportionally (the browser preserves aspect ratio from the
/// viewBox), so wide diagrams shrink-to-fit instead of overflowing with a
/// scrollbar. Pinning explicit pixel width/height here (as an earlier version
/// did) fights the CSS: the fixed attributes take precedence over
/// `width: auto`, which breaks aspect-ratio scaling and produces BOTH x and y
/// scrollbars on diagrams wider than the column.
///
/// SECURITY: the output of this function is fed to `dangerouslySetInnerHTML`
/// (see the JSX below). Callers must pass the raw mermaid SVG through
/// `sanitizeSvg` FIRST (mermaid emits label HTML into <foreignObject> for
/// htmlLabels; event handlers inside it would execute in the app window).
/// This function then only adjusts presentation, and we cap the input source
/// to bound the work Mermaid does on untrusted model output, wrapping the
/// render in a try/catch so a malformed diagram surfaces a clear error
/// instead of a broken page.
function normalizeSvg(svg: string): string {
  let out = svg
    // `background: #fff;` / `background-color: ...;` inside the inline <style>.
    .replace(/background-color\s*:\s*[^;"']+;?/gi, "")
    .replace(/background\s*:\s*[^;"']+;?/gi, "")
    // `background="..."` attribute on the root <svg> element.
    .replace(/\sbackground="[^"]*"/gi, "")
    // A leading <rect ... class="background" .../> fill covering the canvas.
    .replace(/<rect[^>]*class="[^"]*background[^"]*"[^>]*\/?>/gi, "")
    .replace(/<rect[^>]*fill="(?:white|#ffffff|#fff|#00000000|transparent)"[^>]*\/>/gi, "");

  // Strip explicit width/height so the viewBox (which Mermaid always bakes
  // in) can drive proportional scaling via CSS max-width. A diagram that
  // omits a viewBox falls back to its native intrinsic size, which the CSS
  // still caps via max-width/max-height.
  out = out.replace(
    /<svg\b([^>]*)>/,
    (_m, attrs: string) =>
      `<svg${attrs.replace(/\swidth="[^"]*"/i, "").replace(/\sheight="[^"]*"/i, "")}>`,
  );
  return out;
}

// The Mermaid diagram-type keywords (first token of a block). Used to detect
// whether enough source has streamed to identify a topic.
const DIAGRAM_TYPES = new Set([
  "graph",
  "flowchart",
  "flowchart-tb",
  "flowchart-lr",
  "sequenceDiagram",
  "classDiagram",
  "classDiagram-v2",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "gantt",
  "pie",
  "journey",
  "gitGraph",
  "mindmap",
  "timeline",
  "quadrantChart",
  "requirementDiagram",
  "c4Context",
  "c4Container",
  "c4Component",
]);

/// Best-effort short topic label for the "Creating the diagram of …" hint.
/// Prefers an explicit `title:` directive, then the first node/label text in
/// the source, then falls back to the diagram type.
function guessTopic(code: string): string | null {
  const src = code.trim();
  if (!src) return null;

  // `title: My Diagram` (mermaid frontmatter/directive).
  const titleMatch = /^title:\s*(.+)$/m.exec(src);
  if (titleMatch) return titleMatch[1].trim();

  const firstLine = src.split(/\n/)[0]?.trim() ?? "";
  const firstWord = firstLine.split(/[\s]/)[0] ?? "";
  const isTyped = DIAGRAM_TYPES.has(firstWord);

  // Pull the first quoted label, or the first node text after `-->`/`---`/`->>`.
  const quoted = src.match(/"([^"]{2,80})"/);
  if (quoted) return quoted[1];

  const labelAfterPipe = src.match(/\|([^|]{2,80})\|/);
  if (labelAfterPipe) return labelAfterPipe[1].trim();

  // First node label like `A[Hello World]` or `B(Rounded)`.
  const nodeLabel = src.match(/\[[^[\]]{2,80}\]|\([^()]{2,80}\)/);
  if (nodeLabel) {
    return nodeLabel[0].replace(/[[\]()]/g, "").trim();
  }

  if (isTyped) return firstWord;
  return firstLine || null;
}

// A stable, monotonically increasing id base so each diagram gets a unique
// render target even when several appear in one message.
let diagramSeq = 0;

export function MermaidDiagramInner({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);
  // The raw source as of the last successful render — shown as a fallback.
  const [renderedFrom, setRenderedFrom] = useState<string>("");
  // The topic label captured at the moment we kicked off a render, so the
  // "Creating the diagram of …" hint stays stable while the model keeps
  // streaming more tokens.
  const [topic, setTopic] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const trimmed = code.trim();

    // Nothing to render yet (still empty or whitespace). Keep the placeholder.
    if (!trimmed) {
      setSvg(null);
      setError(null);
      setRenderedFrom("");
      setTopic(null);
      return;
    }

    // Capture the topic up-front so the loading hint is meaningful even
    // before the debounce fires.
    setTopic(guessTopic(trimmed));

    // Debounce: render only after the source stops changing for 250ms.
    // During streaming this means we render the final diagram once it lands,
    // not on every partial token (which would throw parse errors).
    //
    // SECURITY: cap the diagram source to a sane size before handing it to
    // mermaid. Mermaid's parser is JS and is not designed for hostile input;
    // a 10 MB diagram block from a misbehaving model would block the
    // renderer thread (no streaming parse). 256 KB is well above any
    // legitimate diagram and bounds the worst case.
    const MAX_DIAGRAM_SOURCE_BYTES = 256 * 1024;
    const timer = setTimeout(() => {
      if (cancelled) return;
      (async () => {
        try {
          const theme =
            document.documentElement.dataset.theme === "light" ? "light" : "dark";
          const mermaid = await loadMermaid(theme);
          if (cancelled) return;
          // Wait for webfonts before rendering: mermaid measures label text
          // with DOM metrics, and a not-yet-loaded font yields clipped /
          // overflowing node and edge labels.
          try {
            await document.fonts.ready;
          } catch {
            /* older webview without document.fonts — render anyway */
          }
          if (cancelled) return;
          const id = `mermaid-${Date.now()}-${diagramSeq++}`;
          const source =
            trimmed.length > MAX_DIAGRAM_SOURCE_BYTES
              ? trimmed.slice(0, MAX_DIAGRAM_SOURCE_BYTES) +
                "\n%% [diagram source truncated for safety]"
              : trimmed;
          // PARSE FIRST: on invalid syntax, mermaid.render() can RESOLVE with
          // an SVG containing its own error bomb graphic ("Syntax error in
          // text") instead of throwing — which bypassed the fallback below.
          // parse() always throws, so bad sources land in the readable
          // source-code fallback.
          const parseError = await mermaid.parse(source).then(
            () => null,
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
          );
          if (parseError) throw new Error(parseError);
          if (cancelled) return;
          // mermaid.render returns { svg, bindFunctions }; we only need svg.
          const result = (await mermaid.render(id, source)) as RenderResult;
          if (cancelled) return;
          // Belt-and-braces: a resolved render that still embeds mermaid's
          // error graphic is a failure too.
          if (/class="error|Syntax error in text/i.test(result.svg)) {
            throw new Error("Syntax error in text");
          }
          // SECURITY: the source is untrusted model output and the result is
          // injected via dangerouslySetInnerHTML in the privileged app window.
          // Sanitize BEFORE normalizeSvg so no onerror/script survives.
          setSvg(normalizeSvg(sanitizeSvg(result.svg)));
          setError(null);
          setRenderedFrom(source);
        } catch (e) {
          if (cancelled) return;
          setSvg(null);
          setError(e instanceof Error ? e.message : String(e));
          setRenderedFrom(trimmed);
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);

  const loadingHint = topic
    ? `Creating the diagram of ${topic}…`
    : "Creating the diagram…";

  // SVG (or error fallback) is injected via dangerouslySetInnerHTML because
  // mermaid.render returns a pre-built SVG string. The SVG has already been
  // through sanitizeSvg (DOMPurify) at render time, so no scripts or event
  // handlers from model-authored labels can reach the app window.
  // Clicking a rendered diagram opens the full-screen zoom/pan lightbox.
  return (
    <div className="chat-mermaid-block">
      <div className="chat-mermaid-body" ref={containerRef}>
        {svg ? (
          <button
            type="button"
            className="chat-mermaid-open"
            title="Open full view (zoom & save)"
            aria-label="Open diagram in full view"
            onClick={() => setLightbox(true)}
          >
            <div
              className="chat-mermaid-svg"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </button>
        ) : error ? (
          <div className="chat-mermaid-fallback">
            <div className="chat-mermaid-error">Could not render diagram: {error}</div>
            <pre className="chat-mermaid-source">{renderedFrom}</pre>
          </div>
        ) : (
          <div className="chat-mermaid-loading">{loadingHint}</div>
        )}
      </div>
      {lightbox && svg && (
        <DiagramLightbox html={svg} filename={topic ? `${topic}.svg` : "diagram.svg"} onClose={() => setLightbox(false)} />
      )}
    </div>
  );
}

/** Memoized: parents re-render on every streaming token flush; the render
 *  effect is keyed on `code` alone, so an unchanged fence must not re-run. */
export const MermaidDiagram = memo(MermaidDiagramInner);
