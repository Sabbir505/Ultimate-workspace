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
import { ArtifactExportMenu } from "./ArtifactExportMenu";
import { useUiStore } from "../../state/ui";

export interface MermaidDiagramProps {
  /** The raw mermaid source (the text inside the ```mermaid fence). */
  code: string;
  /** Optional repair hook: invoked with (source, error) when the user asks
   *  the agent to fix a diagram that failed to parse/render. The chat mounts
   *  it to send a fix request into the conversation; surfaces without an
   *  agent (artifact tabs) omit it and the button never shows. */
  onFix?: (source: string, error: string) => void;
}

type MermaidModule = typeof import("mermaid").default;
type RenderResult = { svg: string };

// Mermaid is only imported client-side, inside an effect, so the heavy
// bundle stays out of the initial page path and never runs under SSR/tests.
//
// Initialization is keyed on the light/dark mode PLUS the live values of
// every token the diagram palette consumes. Custom gallery themes override
// tokens inline on <html>, so two dark-based themes with different accents
// must not share one initialized mermaid instance (the old key was just
// "dark"/"light", which left stale palette colors after a theme swap).
const DIAGRAM_THEME_TOKENS = [
  "--font-ui",
  "--text",
  "--surface",
  "--surface-2",
  "--surface-glass",
  "--surface-glass-2",
  "--editor-bg",
  "--border",
  "--border-strong",
  "--diagram-accent",
  "--diagram-accent-contrast",
  "--diagram-node-fill",
  "--diagram-node-border",
  "--diagram-line",
  "--diagram-cluster-fill",
  "--diagram-cluster-border",
] as const;

function themeMode(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function diagramInitKey(theme: string, cs: CSSStyleDeclaration | null): string {
  if (!cs) return theme;
  const sig = DIAGRAM_THEME_TOKENS.map((t) => cs.getPropertyValue(t).trim()).join("|");
  return `${theme}::${sig}`;
}

let lastInitKey: string | null = null;
// ELK registers once per app run; it must be registered before initialize().
let layoutsRegistered = false;

async function loadMermaid(theme: string): Promise<MermaidModule> {
  const mod = await import("mermaid");
  const mermaid = mod.default;
  if (!layoutsRegistered) {
    // ELK layout engine: orthogonal, tidier connector routing on complex
    // graphs than the dagre default (draw.io / Mermaid Chart default to it
    // for flowcharts). It is ~2MB, so it rides the same lazy import path as
    // mermaid itself. Per-diagram frontmatter (`config: layout: dagre`)
    // can still opt out.
    const elk = await import("@mermaid-js/layout-elk");
    mermaid.registerLayoutLoaders(elk.default);
    layoutsRegistered = true;
  }
  // Read token values from CSS custom properties so diagrams track the
  // app's data-theme (and any inline custom-theme overrides) instead of
  // being pinned to one palette.
  const cs = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const tok = (name: string, fallback: string) =>
    cs ? cs.getPropertyValue(name).trim() || fallback : fallback;
  // Re-init only when the theme actually changes — cheap no-op otherwise.
  const initKey = diagramInitKey(theme, cs);
  if (lastInitKey !== initKey) {
    const isDark = theme === "dark";
    mermaid.initialize({
      startOnLoad: false,
      // "antiscript" (not "loose") strips <script> from labels while keeping
      // htmlLabels/foreignObject working. It is only the FIRST layer: label
      // HTML still reaches the DOM with inline event handlers intact, so the
      // rendered SVG is ALSO run through sanitizeSvg() before injection.
      securityLevel: "antiscript",
      theme: isDark ? "dark" : "default",
      // ELK by default: significantly cleaner edge routing on dense
      // flowcharts. Diagram types without a graph layout (sequence, gantt,
      // pie…) ignore this and keep their dedicated renderers.
      layout: "elk",
      // Resolve the UI font stack to a literal string: mermaid bakes it into
      // the SVG's <style>, and a downloaded .svg file resolves no app CSS —
      // a var() reference would dangle there. (The previous value,
      // "var(--font-sans)", named a token that never existed, so diagram
      // text silently fell back to the webview default font.)
      fontFamily: tok(
        "--font-ui",
        '"Space Grotesk", -apple-system, "Segoe UI", system-ui, sans-serif',
      ),
      flowchart: {
        // The dagre defaults cram nodes together and draw wobbly spline
        // edges ("basis"), which reads as a sketch. Deliberate air plus
        // crisp angular edges read as an engineering diagram.
        nodeSpacing: 55,
        rankSpacing: 62,
        padding: 14,
        curve: "linear",
        useMaxWidth: true,
      },
      sequence: {
        actorMargin: 60,
        messageMargin: 40,
        boxMargin: 12,
        useMaxWidth: true,
      },
      themeVariables: isDark
        ? {
            // Transparent canvas so the diagram floats on the app surface.
            background: "transparent",
            // Regular nodes: faint blue-tinted slate fills with readable
            // borders. An all-grey palette reads as a washed-out wireframe.
            mainBkg: tok("--diagram-node-fill", "#232a31"),
            nodeBorder: tok("--diagram-node-border", "#3f4c56"),
            // Subgraph containers sit one step below the nodes so grouping
            // reads as structure, not noise.
            clusterBkg: tok("--diagram-cluster-fill", "#1d2226"),
            clusterBorder: tok("--diagram-cluster-border", "#333c44"),
            secondBkg: tok("--surface-glass-2", "#252525"),
            tertiaryBkg: tok("--surface-glass", "#1e1e1e"),
            // Edges + arrowheads: cool slate — visible structure, less glare
            // than near-white lines.
            lineColor: tok("--diagram-line", "#9aa8b2"),
            arrowheadColor: tok("--diagram-line", "#9aa8b2"),
            textColor: tok("--text", "#e4e4e4"),
            nodeTextColor: tok("--text", "#e4e4e4"),
            titleColor: tok("--text", "#e4e4e4"),
            // Mermaid derives node/label text from stateLabelColor
            // (stateLabelColor || stateBkg || primaryTextColor) — without an
            // explicit value it falls back to primaryTextColor. Pin it to
            // the readable text colour (see the primary note below).
            stateLabelColor: tok("--text", "#e4e4e4"),
            edgeLabelBackground: "transparent",
            // Emphasis shapes (start/end, highlighted) carry the theme
            // accent; their label text uses the contrast colour so it stays
            // readable on the accent fill.
            primaryColor: tok("--diagram-accent", "#88C0D0"),
            primaryTextColor: tok("--diagram-accent-contrast", "#10222b"),
            primaryBorderColor: tok("--diagram-accent", "#88C0D0"),
            secondaryColor: tok("--surface-glass-2", "#252525"),
            secondaryTextColor: tok("--text", "#e4e4e4"),
            secondaryBorderColor: tok("--border-strong", "#3a3a3a"),
            tertiaryColor: tok("--surface-2", "#1f1f1f"),
            tertiaryTextColor: tok("--text", "#e4e4e4"),
            tertiaryBorderColor: tok("--border", "#2a2a2a"),
            // Sequence diagrams: actors share the node surface, signals the
            // edge colour — otherwise they keep the built-in lavender cast
            // that clashes with the rest of the palette.
            actorBkg: tok("--diagram-node-fill", "#232a31"),
            actorBorder: tok("--diagram-node-border", "#3f4c56"),
            actorTextColor: tok("--text", "#e4e4e4"),
            actorLineColor: tok("--diagram-line", "#9aa8b2"),
            signalColor: tok("--diagram-line", "#9aa8b2"),
            signalTextColor: tok("--text", "#e4e4e4"),
            activationBkgColor: tok("--diagram-accent", "#88C0D0"),
            activationBorderColor: tok("--diagram-accent", "#88C0D0"),
            sequenceNumberColor: tok("--diagram-accent-contrast", "#10222b"),
            // State diagrams: state nodes + transitions join the palette
            // (their defaults carry the same lavender cast). The node/label
            // text colour itself is pinned by stateLabelColor above.
            stateBkg: tok("--diagram-node-fill", "#232a31"),
            specialStateColor: tok("--diagram-line", "#9aa8b2"),
            transitionColor: tok("--diagram-line", "#9aa8b2"),
            transitionLabelColor: tok("--text", "#e4e4e4"),
            compositeBackground: tok("--diagram-cluster-fill", "#1d2226"),
            compositeBorder: tok("--diagram-cluster-border", "#333c44"),
            // Shared: edge-label chips, notes, generic links, ER relations.
            labelBackgroundColor: tok("--diagram-node-fill", "#232a31"),
            noteBkgColor: tok("--diagram-cluster-fill", "#1d2226"),
            noteBorderColor: tok("--diagram-cluster-border", "#333c44"),
            noteTextColor: tok("--text", "#e4e4e4"),
            loopTextColor: tok("--text", "#e4e4e4"),
            defaultLinkColor: tok("--diagram-line", "#9aa8b2"),
            nodeBkg: tok("--diagram-node-fill", "#232a31"),
            relationColor: tok("--diagram-line", "#9aa8b2"),
            relationLabelBackground: tok("--diagram-node-fill", "#232a31"),
            relationLabelColor: tok("--text", "#e4e4e4"),
            fontSize: "14px",
          }
        : {
            background: "transparent",
            mainBkg: tok("--diagram-node-fill", "#f7fafc"),
            nodeBorder: tok("--diagram-node-border", "#8fa1ad"),
            clusterBkg: tok("--diagram-cluster-fill", "#f0f3f6"),
            clusterBorder: tok("--diagram-cluster-border", "#d5dde3"),
            lineColor: tok("--diagram-line", "#44525c"),
            arrowheadColor: tok("--diagram-line", "#44525c"),
            textColor: tok("--text", "#1a1a1a"),
            nodeTextColor: tok("--text", "#1a1a1a"),
            titleColor: tok("--text", "#1a1a1a"),
            // See the dark-theme note: without this, state/flow node labels
            // fall back to primaryTextColor (white here — unreadable on the
            // near-white node fill).
            stateLabelColor: tok("--text", "#1a1a1a"),
            edgeLabelBackground: "transparent",
            primaryColor: tok("--diagram-accent", "#0078a8"),
            primaryTextColor: tok("--diagram-accent-contrast", "#ffffff"),
            primaryBorderColor: tok("--diagram-accent", "#0078a8"),
            secondaryColor: tok("--surface-2", "#f3f3f3"),
            secondaryTextColor: tok("--text", "#1a1a1a"),
            secondaryBorderColor: tok("--border", "#e0e0e0"),
            tertiaryColor: tok("--surface", "#ffffff"),
            tertiaryTextColor: tok("--text", "#1a1a1a"),
            tertiaryBorderColor: tok("--border", "#e0e0e0"),
            // Sequence diagrams (see the dark-theme note above).
            actorBkg: tok("--diagram-node-fill", "#f7fafc"),
            actorBorder: tok("--diagram-node-border", "#8fa1ad"),
            actorTextColor: tok("--text", "#1a1a1a"),
            actorLineColor: tok("--diagram-line", "#44525c"),
            signalColor: tok("--diagram-line", "#44525c"),
            signalTextColor: tok("--text", "#1a1a1a"),
            activationBkgColor: tok("--diagram-accent", "#0078a8"),
            activationBorderColor: tok("--diagram-accent", "#0078a8"),
            sequenceNumberColor: tok("--diagram-accent-contrast", "#ffffff"),
            // State diagrams (see the dark-theme note above).
            stateBkg: tok("--diagram-node-fill", "#f7fafc"),
            specialStateColor: tok("--diagram-line", "#44525c"),
            transitionColor: tok("--diagram-line", "#44525c"),
            transitionLabelColor: tok("--text", "#1a1a1a"),
            compositeBackground: tok("--diagram-cluster-fill", "#f0f3f6"),
            compositeBorder: tok("--diagram-cluster-border", "#d5dde3"),
            // Shared: edge-label chips, notes, generic links, ER relations.
            labelBackgroundColor: tok("--diagram-node-fill", "#f7fafc"),
            noteBkgColor: tok("--diagram-cluster-fill", "#f0f3f6"),
            noteBorderColor: tok("--diagram-cluster-border", "#d5dde3"),
            noteTextColor: tok("--text", "#1a1a1a"),
            loopTextColor: tok("--text", "#1a1a1a"),
            defaultLinkColor: tok("--diagram-line", "#44525c"),
            nodeBkg: tok("--diagram-node-fill", "#f7fafc"),
            relationColor: tok("--diagram-line", "#44525c"),
            relationLabelBackground: tok("--diagram-node-fill", "#f7fafc"),
            relationLabelColor: tok("--text", "#1a1a1a"),
            fontSize: "14px",
          },
    });
    lastInitKey = initKey;
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

/** Resolve the chat surface colour from the theme tokens — the canvas
 *  mermaid art floats on. Used as the export background so downloaded
 *  PNG/SVG/JPG match the inline render (dark theme exports dark, not white). */
function chatSurfaceColor(): string {
  if (typeof document === "undefined") return "#ffffff";
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg-tint")
    .trim();
  return v || "#ffffff";
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

/** Cache of finished (sanitized + normalized) SVG renders, keyed by
 *  `theme:source`. The message list is virtualized: rows remount on every
 *  scroll, and without this each remount re-ran mermaid.parse + render for
 *  the same diagram (hundreds of ms for large graphs — the biggest
 *  scroll-back stall in diagram-heavy chats). Bounded like the other
 *  render caches. */
const MERMAID_CACHE_MAX = 32;
const mermaidSvgCache = new Map<string, string>();

export function MermaidDiagramInner({ code, onFix }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const trimmedCode = code.trim();
  // Cache key includes the token signature, not just light/dark: a custom
  // gallery theme with a different diagram palette must not reuse another
  // theme's cached SVG.
  const cacheKey = `${diagramInitKey(
    themeMode(),
    typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null,
  )}:${trimmedCode}`;
  // Seed synchronously from the cache so a remount paints the diagram
  // immediately instead of flashing the "Creating the diagram…" hint for the
  // debounce window.
  const [svg, setSvg] = useState<string | null>(() => mermaidSvgCache.get(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);
  // The raw source as of the last successful render — shown as a fallback.
  const [renderedFrom, setRenderedFrom] = useState<string>(
    () => (mermaidSvgCache.has(cacheKey) ? trimmedCode : ""),
  );
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

    const themeKey = diagramInitKey(
      themeMode(),
      getComputedStyle(document.documentElement),
    );
    const key = `${themeKey}:${trimmed}`;
    const cached = mermaidSvgCache.get(key);
    if (cached !== undefined) {
      // Already rendered this exact source under this theme — skip the
      // debounce + parse + render entirely (virtualized remount path).
      setSvg(cached);
      setError(null);
      setRenderedFrom(trimmed);
      return;
    }

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
          const mermaid = await loadMermaid(themeMode());
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
          const out = normalizeSvg(sanitizeSvg(result.svg));
          mermaidSvgCache.delete(key);
          mermaidSvgCache.set(key, out);
          if (mermaidSvgCache.size > MERMAID_CACHE_MAX) {
            const oldest = mermaidSvgCache.keys().next().value;
            if (oldest !== undefined) mermaidSvgCache.delete(oldest);
          }
          setSvg(out);
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

  const openArtifactTab = useUiStore((s) => s.openArtifactTab);
  // The kebab lives ON the inline diagram (hover-revealed): save as
  // PNG/JPG/SVG or copy; "Open in tab" jumps to the full-size preview.
  const syntheticPreview = svg
    ? {
        path: topic ? `${topic}.svg` : "diagram.svg",
        filename: topic ? `${topic}.svg` : "diagram.svg",
        ext: "svg",
        kind: "diagram" as const,
        text: svg,
        dataUri: null,
        size: svg.length,
        truncated: false,
      }
    : null;

  // SVG (or error fallback) is injected via dangerouslySetInnerHTML because
  // mermaid.render returns a pre-built SVG string. The SVG has already been
  // through sanitizeSvg (DOMPurify) at render time, so no scripts or event
  // handlers from model-authored labels can reach the app window.
  // Clicking a rendered diagram opens the full-screen zoom/pan lightbox;
  // the hover kebab carries the export + open-in-tab actions.
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
            {onFix && (
              <div className="chat-mermaid-fallback-actions">
                <button
                  type="button"
                  className="chat-mermaid-fix-btn"
                  title="Ask the agent to fix this diagram"
                  onClick={() => onFix(renderedFrom || trimmedCode, error)}
                >
                  Fix with AI
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="chat-mermaid-loading">{loadingHint}</div>
        )}
      </div>
      {syntheticPreview && (
        <div className="chat-diagram-actions">
          <ArtifactExportMenu
            preview={syntheticPreview}
            path={syntheticPreview.path}
            filename={syntheticPreview.filename}
            variant="kebab"
            // Mermaid art floats on the chat surface (transparent canvas) —
            // exports must bake THAT in, not white.
            exportBg={chatSurfaceColor()}
            extraItems={(closeMenu) => (
              <button
                type="button"
                role="menuitem"
                className="artifact-kebab-item"
                onClick={() => {
                  if (!svg) return;
                  closeMenu();
                  openArtifactTab({
                    path: syntheticPreview.path,
                    filename: syntheticPreview.filename,
                    // A ```mermaid fence has no file on disk — the svg exists
                    // only in memory. Carry it inline so the tab renders the
                    // real diagram instead of stat-failing a synthetic path.
                    inline: { kind: "svg", code: svg },
                  });
                }}
              >
                Open in tab
              </button>
            )}
          />
        </div>
      )}
      {lightbox && svg && (
        <DiagramLightbox
          html={svg}
          filename={topic ? `${topic}.svg` : "diagram.svg"}
          onClose={() => setLightbox(false)}
          // Mermaid renders dark-theme art on a transparent canvas that floats
          // on the chat surface — the lightbox paper must match, not white.
          surface="chat"
        />
      )}
    </div>
  );
}

/** Memoized: parents re-render on every streaming token flush; the render
 *  effect is keyed on `code` alone, so an unchanged fence must not re-run. */
export const MermaidDiagram = memo(MermaidDiagramInner);
