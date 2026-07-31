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
import { useEffect, useRef, useState } from "react";

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
  // Re-init only when the theme actually changes — cheap no-op otherwise.
  if (lastTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: "var(--font-sans)",
      themeVariables:
        theme === "dark"
          ? {
              // Transparent canvas so the diagram floats on the app surface.
              background: "transparent",
              mainBkg: "#34342f",
              secondBkg: "#3e3e3a",
              tertiaryBkg: "#3a3a37",
              // Warm off-white edges/text; terracotta primary accent.
              lineColor: "#a8a299",
              textColor: "#f5f1ea",
              edgeLabelBackground: "transparent",
              primaryColor: "#c15f3c",
              primaryTextColor: "#f5f1ea",
              primaryBorderColor: "#d97a55",
              secondaryColor: "#4a4a45",
              secondaryTextColor: "#f5f1ea",
              secondaryBorderColor: "#b9b3a8",
              tertiaryColor: "#403c36",
              tertiaryTextColor: "#f5f1ea",
              tertiaryBorderColor: "#9c958a",
              fontSize: "14px",
            }
          : {
              background: "transparent",
              lineColor: "#736b62",
              textColor: "#2b2622",
              edgeLabelBackground: "transparent",
              primaryColor: "#c15f3c",
              primaryTextColor: "#ffffff",
              primaryBorderColor: "#a84d2d",
              secondaryColor: "#f3efe8",
              secondaryTextColor: "#2b2622",
              secondaryBorderColor: "#9c958a",
              tertiaryColor: "#fdfbf7",
              tertiaryTextColor: "#2b2622",
              tertiaryBorderColor: "#b9b3a8",
              fontSize: "14px",
            },
    });
    lastTheme = theme;
  }
  return mermaid;
}

/// Normalize the rendered SVG so it displays cleanly in-app: strip the solid
/// background Mermaid bakes in (so the diagram floats on the app's glass
/// surface) and pin width/height to the viewBox's pixel size (so node boxes
/// keep their natural dimensions and node text is never clipped by a forced
/// shrink-to-fit).
///
/// SECURITY: the output of this function is fed to `dangerouslySetInnerHTML`
/// (see the JSX below). The mermaid renderer runs with `securityLevel:"loose"`
/// which can emit arbitrary HTML inside `<foreignObject>` for some diagram
/// types. We don't try to filter the output (that's the renderer's job) but
/// we cap the input source to bound the work Mermaid does on untrusted model
/// output, and we wrap the render in a try/catch so a malformed diagram
/// surfaces a clear error instead of a broken page.
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

  // Pin width/height to the viewBox's pixel size so diagrams that emit
  // width="100%" don't shrink-to-fit and clip node text.
  const viewBoxMatch = out.match(/viewBox="([^"]+)"/);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const [, , w, h] = parts;
      out = out.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
        const a = attrs
          .replace(/\swidth="[^"]*"/i, "")
          .replace(/\sheight="[^"]*"/i, "");
        return `<svg${a} width="${w}" height="${h}">`;
      });
    }
  }
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

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
          const id = `mermaid-${Date.now()}-${diagramSeq++}`;
          const source =
            trimmed.length > MAX_DIAGRAM_SOURCE_BYTES
              ? trimmed.slice(0, MAX_DIAGRAM_SOURCE_BYTES) +
                "\n%% [diagram source truncated for safety]"
              : trimmed;
          // mermaid.render returns { svg, bindFunctions }; we only need svg.
          const result = (await mermaid.render(id, source)) as RenderResult;
          if (cancelled) return;
          setSvg(normalizeSvg(result.svg));
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
  // mermaid.render returns a pre-built SVG string. securityLevel:"loose" is
  // required for some diagram features (click events, foreignObject); the
  // source comes from the model but is rendered in a sandboxed app context.
  return (
    <div className="chat-mermaid-block">
      <div className="chat-mermaid-body" ref={containerRef}>
        {svg ? (
          <div
            className="chat-mermaid-svg"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : error ? (
          <div className="chat-mermaid-fallback">
            <div className="chat-mermaid-error">Could not render diagram: {error}</div>
            <pre className="chat-mermaid-source">{renderedFrom}</pre>
          </div>
        ) : (
          <div className="chat-mermaid-loading">{loadingHint}</div>
        )}
      </div>
    </div>
  );
}
