// Renders generated diagram/visual artifacts inline in the chat message.
//
// Static diagrams (authored by `generate_diagram` as inline <svg>, or plain
// SVG-only HTML) render in a sanitized, scripts-blocked iframe sized to the
// diagram's aspect at the chat width — identical rendering to the export
// pipeline, except the frame is capped at INLINE_DIAGRAM_MAX_H so a very tall
// artifact is scaled down into a fixed-height card instead of taking over the
// conversation.
//
// Interactive visuals (HTML with scripts/forms/buttons — Claude-style custom
// visuals) render LIVE: an allow-scripts sandboxed iframe (no same-origin, so
// no parent/Tauri access) whose height auto-fits the content via a postMessage
// handshake, clamped to the same bound. A compact toolbar carries Download +
// "Open in tab" (full-size preview) for both paths.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { readArtifactPreview, type ArtifactPreview } from "../../lib/ipc";
import type { ChatArtifact } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { sanitizeHtml } from "../../lib/sanitize";
import { isInteractiveHtml } from "../../lib/interactiveHtml";
import { DiagramLightbox } from "./DiagramLightbox";
import { ArtifactExportMenu } from "./ArtifactExportMenu";

/** Injected into the iframe document (display only) so the diagram scales down
 *  to the chat width — and down to the frame height when the artifact is too
 *  tall to show inline at full size. Export still uses the untouched
 *  `preview.text`, so downloads keep the original resolution. */
/** Horizontal padding (px per side) inside the iframe so the diagram never
 *  touches the frame edge. */
const FIT_PAD_X = 12;
const FIT_PAD_Y = 8;
/** Hard cap on an inline static artifact's height. Past this the frame holds
 *  this height and the diagram scales down into it (the SVG keeps its
 *  aspect ratio, so the drawing shrinks rather than clipping) — a 3000px
 *  flowchart must not swallow the conversation. Sized to match the live-visual
 *  clamp below so both inline artifact kinds occupy the same slot. */
const INLINE_DIAGRAM_MAX_H = 520;
const FIT_STYLE =
  `<style>html{margin:0;overflow:hidden;height:100%}` +
  // box-sizing keeps the padding inside the 100% height, and overflow:hidden
  // means an over-tall artifact is clipped by the frame rather than pushing
  // the chat into an endless scroll.
  `body{margin:0;padding:${FIT_PAD_Y}px ${FIT_PAD_X}px;box-sizing:border-box;height:100%;overflow:hidden;` +
  // No flex — flex collapses the body to the iframe height and breaks
  // scrollHeight measurement. Let the SVG flow as a block element.
  "background:#fff}" +
  // Force the SVG to shrink-to-fit the container width, preserving aspect ratio.
  // max-height:100% is the tall-artifact half of the fit: a short diagram
  // still sizes to its width, a tall one is scaled down to the frame height
  // and centered by the SVG's own preserveAspectRatio.
  "svg{display:block;width:100%!important;height:auto!important;max-height:100%!important}" +
  // Also constrain wrapper divs so nothing overflows the frame.
  "body > div{max-width:100%!important}" +
  "</style>";

/** Compose the frame document: the fit stylesheet FIRST, then the sanitized
 *  artifact markup.
 *
 *  The order matters. The style is prepended AFTER sanitization because
 *  DOMPurify runs in body-only mode: a `<style>` element sitting in the
 *  parsed document's `<head>` is dropped with the rest of the head, so
 *  injecting this stylesheet into the source markup (as an earlier version
 *  did) silently threw it away for exactly the artifacts that need it most —
 *  a bare `<svg>` diagram, whose markup has no `<head>` at all and whose
 *  leading `<style>` the parser hoists into one. Prepending it to the
 *  sanitized body content puts it back in front of the markup, where the
 *  frame's parser hoists it into `<head>` where it belongs. FIT_STYLE is a
 *  literal with no interpolated artifact content, so it needs no sanitizing. */
function withFitStyle(html: string): string {
  return FIT_STYLE + sanitizeHtml(html);
}

// ---- Live inline visuals (interactive HTML) ----
// Height bounds for the live frame: content-sized via postMessage, clamped so
// a runaway page can't push the chat into an endless scroll.
const LIVE_VIZ_DEFAULT_H = 300;
const LIVE_VIZ_MIN_H = 120;
const LIVE_VIZ_MAX_H = 520;

/** Per-instance handshake token: injected into the frame's reporter script and
 *  verified on every inbound message, so a sibling InlineDiagram's frame (or
 *  any other same-window poster) can't resize this frame. */
let liveVizSeq = 0;

/** Injected into a live visual's iframe document: reports the content height
 *  to the parent whenever it changes (load + any resize), driving the
 *  clamped auto-height. Appended before </body> (or prepended) so it runs
 *  after the page's own markup. The report carries this instance's token so
 *  the parent can tell the message came from THIS frame's script. */
function withLiveResizeScript(html: string, token: string): string {
  const script =
    '<script>(function(){function r(){parent.postMessage(' +
    "{__relayInlineVizHeight:Math.ceil(document.documentElement.scrollHeight)," +
    "__relayInlineVizToken:" +
    JSON.stringify(token) +
    "},'*')}" +
    "window.addEventListener('load',r);" +
    "try{new ResizeObserver(r).observe(document.documentElement)}catch(e){}" +
    "r()})()</script>";
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, (m) => script + m);
  }
  return html + script;
}

/** Intrinsic pixel size of the diagram's root <svg>, from width/height or the
 *  viewBox. Used to fit the inline frame to the diagram's real dimensions. */
function svgDims(html: string): { w: number; h: number } | null {
  const tag = html.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const w = tag.match(/\bwidth="([\d.]+)"/i);
  const h = tag.match(/\bheight="([\d.]+)"/i);
  if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  const vb = tag.match(/viewBox="([^"]+)"/i);
  if (vb) {
    const p = vb[1].split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(Number.isFinite)) return { w: p[2], h: p[3] };
  }
  return null;
}

export function InlineDiagram({
  artifact,
  onFallback,
}: {
  artifact: ChatArtifact;
  /** Rendered when the artifact turns out not to be a diagram/html file. */
  onFallback: () => JSX.Element;
}) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Rendered size of the diagram's root <svg> inside the measuring frame,
   *  or null until the first measure lands. */
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const openArtifactTab = useUiStore((s) => s.openArtifactTab);

  const openInTab = () => {
    openArtifactTab({ path: artifact.path, filename: artifact.filename });
  };

  // Live inline visuals: the sandboxed frame can't be measured (no
  // allow-same-origin), so the injected reporter posts its content height up.
  // Only messages from THIS frame's contentWindow AND carrying this
  // instance's handshake token are trusted — the frame has no access to this
  // window beyond postMessage, and a foreign window (or a sibling diagram's
  // frame) must never be able to resize it.
  const [liveH, setLiveH] = useState<number | null>(null);
  const liveFrameRef = useRef<HTMLIFrameElement>(null);
  const liveVizTokenRef = useRef(`viz-${++liveVizSeq}`);
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      // Source check first: the report must come from THIS instance's frame.
      if (e.source !== liveFrameRef.current?.contentWindow) return;
      const d = e.data as {
        __relayInlineVizHeight?: unknown;
        __relayInlineVizToken?: unknown;
      } | null;
      if (
        d &&
        typeof d === "object" &&
        d.__relayInlineVizToken === liveVizTokenRef.current &&
        typeof d.__relayInlineVizHeight === "number" &&
        Number.isFinite(d.__relayInlineVizHeight)
      ) {
        setLiveH(
          Math.min(LIVE_VIZ_MAX_H, Math.max(LIVE_VIZ_MIN_H, d.__relayInlineVizHeight)),
        );
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // The kebab lives ON the inline diagram (hover-revealed): export actions
  // via the shared menu + "Open in tab". Live visuals add "Open full view"
  // (the lightbox shows static markup only, so interactive pages go to tab).
  const isInteractive = preview?.text != null && isInteractiveHtml(preview.text);
  const kebab = preview ? (
    <div className="chat-diagram-actions">
      <ArtifactExportMenu
        preview={{
          path: artifact.path,
          filename: artifact.filename,
          ext: "html",
          kind: preview.kind === "diagram" || preview.kind === "html" ? preview.kind : "html",
          text: preview.text ?? "",
          speechText: null,
          dataUri: null,
          size: (preview.text ?? "").length,
          truncated: false,
        }}
        path={artifact.path}
        filename={artifact.filename}
        variant="kebab"
        extraItems={(closeMenu) => (
          <>
            <button
              type="button"
              role="menuitem"
              className="artifact-kebab-item"
              onClick={() => {
                closeMenu();
                openInTab();
              }}
            >
              Open in tab
            </button>
            {!isInteractive && (
              <button
                type="button"
                role="menuitem"
                className="artifact-kebab-item"
                onClick={() => {
                  closeMenu();
                  setLightboxOpen(true);
                }}
              >
                Open full view
              </button>
            )}
          </>
        )}
      />
    </div>
  ) : null;

  useEffect(() => {
    let stale = false;
    setPreview(null);
    setError(null);
    setMeasured(null);
    void readArtifactPreview(artifact.path)
      .then((p) => {
        if (!stale) setPreview(p);
      })
      .catch((e: unknown) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [artifact.path]);

  // Track the rendered width so we can size the frame to the diagram's height
  // AFTER it's been scaled down to fit (max-width:100%) — no inner scroller.
  useEffect(() => {
    const el = blockRef.current;
    if (!el) return;
    const update = () => setContainerW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [preview]);

  const srcDoc = useMemo(
    () => (preview?.text != null ? withFitStyle(preview.text) : ""),
    [preview],
  );
  // Live-frame document, memoized so a parent re-render (token flushes while
  // the rest of the message streams) never changes the srcDoc string identity
  // — a changed attribute RELOADS the iframe, which flashed every interactive
  // visual on each streaming update.
  const liveSrcDoc = useMemo(
    () => (preview?.text != null ? withLiveResizeScript(preview.text, liveVizTokenRef.current) : ""),
    [preview],
  );

  // Measure the actual rendered size of the iframe content after it loads.
  // Uses allow-same-origin sandbox (no allow-scripts) so we can read
  // contentDocument — same approach as ArtifactPreviewPane. We measure the
  // SVG element's bounding rect directly (more reliable than body.scrollHeight
  // which can be wrong when body has flex/overflow styles) and wait a frame
  // for layout to settle before reading dimensions.
  const measureFrame = useCallback(() => {
    const frame = blockRef.current?.querySelector<HTMLIFrameElement>(".chat-diagram-frame");
    const doc = frame?.contentDocument;
    if (!doc) return;
    // Prefer the SVG element's rendered box — this is the actual content.
    const svg = doc.querySelector("svg");
    if (svg) {
      const rect = svg.getBoundingClientRect();
      if (rect.height > 0) {
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        // Keep the previous object identity when nothing moved, so the
        // re-measure effect below doesn't retrigger itself forever.
        setMeasured((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
        return;
      }
    }
    // Fallback: body scrollHeight (includes all content, not just SVG).
    const h = doc.body?.scrollHeight ?? doc.documentElement?.scrollHeight ?? 0;
    if (h > 0) {
      setMeasured((prev) => {
        const next = { w: prev?.w ?? 0, h };
        return prev && prev.h === next.h && prev.w === next.w ? prev : next;
      });
    }
  }, []);

  const onFrameLoad = useCallback(() => {
    // Wait one animation frame for the SVG to finish layout before measuring.
    requestAnimationFrame(() => {
      measureFrame();
      // Some diagrams (complex CSS, external font loading) need a second pass.
      setTimeout(measureFrame, 150);
    });
  }, [measureFrame]);

  // Re-measure when the container width changes (responsive resize).
  useEffect(() => {
    if (!measured) return;
    // Defer to let the SVG re-layout at the new width.
    const t = setTimeout(measureFrame, 50);
    return () => clearTimeout(t);
  }, [containerW, measureFrame, measured]);

  // The diagram's INTRINSIC pixel size (width/height attrs or viewBox).
  const intrinsic = useMemo(
    () => (preview?.text ? svgDims(preview.text) : null),
    [preview],
  );

  // Frame sizing. This is deliberately a PURE function of the artifact's
  // intrinsic size and the available width — never of a height measured from
  // inside a frame that is itself already capped. A measurement taken from a
  // capped frame reads back the cap, which would flip the cap decision on the
  // next pass and oscillate the card between full-width and fitted.
  const { height, fitWidth } = useMemo(() => {
    // Content width the SVG gets inside the frame.
    const availW = Math.max(containerW - FIT_PAD_X * 2, 1);
    if (intrinsic && intrinsic.w > 0 && intrinsic.h > 0) {
      const aspect = intrinsic.w / intrinsic.h;
      // The fit style pins the SVG to width:100%, so the rendered height is
      // always availW/aspect — a small diagram scales UP to the chat column
      // (node text stays legible) exactly as it did before the height cap.
      const naturalH = Math.round(availW / aspect) + FIT_PAD_Y * 2;
      if (naturalH > INLINE_DIAGRAM_MAX_H) {
        // Too tall at full chat width: hold a fixed height and narrow the card
        // to the diagram's own aspect (minus the frame's padding) so the
        // drawing fills the card instead of floating in white space. A
        // max-width only ever NARROWS this block-level card, so a wide aspect
        // in a narrow column simply keeps the column's width.
        const fitted = Math.round((INLINE_DIAGRAM_MAX_H - FIT_PAD_Y * 2) * aspect) + FIT_PAD_X * 2;
        return { height: INLINE_DIAGRAM_MAX_H, fitWidth: fitted };
      }
      return { height: Math.max(naturalH, 120), fitWidth: 0 };
    }
    // No intrinsic size (an HTML wrapper whose root <svg> has no
    // width/height/viewBox): fall back to the measured box. A measurement
    // sitting at the frame ceiling means the content is taller than the cap.
    if (measured && measured.h > 0) {
      const naturalH = measured.h + FIT_PAD_Y * 2;
      // Pinned at the ceiling: the content is taller than the cap. Its
      // measured aspect is distorted by the clamp, so the card keeps its
      // natural width and the diagram centers itself inside the fixed frame.
      if (measured.h >= INLINE_DIAGRAM_MAX_H - FIT_PAD_Y * 2) {
        return { height: INLINE_DIAGRAM_MAX_H, fitWidth: 0 };
      }
      return { height: Math.max(naturalH, 120), fitWidth: 0 };
    }
    return { height: 320, fitWidth: 0 };
  }, [intrinsic, containerW, measured]);

  // Left-aligned at its natural size, centered once it's been fitted to the cap.
  const blockStyle: CSSProperties | undefined = fitWidth
    ? { maxWidth: `${fitWidth}px`, marginLeft: "auto", marginRight: "auto" }
    : undefined;

  if (error) {
    return <div className="chat-diagram-error">Could not load diagram: {error}</div>;
  }
  if (!preview) {
    return <div className="chat-diagram-loading">Loading diagram…</div>;
  }
  // Render diagrams AND HTML files inline. The "diagram" kind (from
  // generate_diagram, carrying the relay:diagram marker) is the primary
  // case. But API/local models often create HTML diagrams via write_file or
  // generate_file — those come through as kind "html" and should also render
  // inline instead of falling back to a download chip.
  // Interactive HTML webapps (scripts/forms/buttons) render LIVE inline —
  // Claude's custom-visuals model: the allow-scripts sandbox keeps the frame
  // isolated from the parent (no same-origin → no Tauri access) while a
  // postMessage handshake sizes the frame to its content. The kebab still
  // offers the full-size tab.
  if (preview.text == null || (preview.kind !== "diagram" && preview.kind !== "html")) {
    return onFallback();
  }
  if (isInteractive) {
    return (
      <div className="chat-diagram-block chat-live-viz" ref={blockRef}>
        <iframe
          ref={liveFrameRef}
          className="chat-diagram-frame chat-live-viz-frame"
          title={artifact.filename}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          srcDoc={liveSrcDoc}
          style={{ height: liveH ?? LIVE_VIZ_DEFAULT_H }}
        />
        {kebab}
      </div>
    );
  }

  // Static diagrams render in the sanitized measuring frame, capped at
  // INLINE_DIAGRAM_MAX_H with the diagram scaled to fit (see FIT_STYLE). A
  // transparent click-catcher sits above the iframe (same-origin frames
  // swallow clicks, and diagrams are non-interactive anyway) so clicking opens
  // the full-screen zoom/pan lightbox.
  return (
    <div className="chat-diagram-block" ref={blockRef} style={blockStyle}>
      <iframe
        className="chat-diagram-frame"
        title={artifact.filename}
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        scrolling="no"
        onLoad={onFrameLoad}
        style={{ height }}
      />
      <button
        type="button"
        className="chat-diagram-click-catch"
        title="Open full view"
        aria-label={`Open ${artifact.filename} in full view`}
        onClick={() => setLightboxOpen(true)}
      />
      {kebab}
      {lightboxOpen && (
        <DiagramLightbox
          html={preview.text}
          filename={artifact.filename}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </div>
  );
}
