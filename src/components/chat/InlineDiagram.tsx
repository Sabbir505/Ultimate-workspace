// Renders generated diagram/visual artifacts inline in the chat message.
//
// Static diagrams (authored by `generate_diagram` as inline <svg>, or plain
// SVG-only HTML) render in a sanitized, scripts-blocked iframe sized to the
// diagram's intrinsic height — identical rendering to the export pipeline.
//
// Interactive visuals (HTML with scripts/forms/buttons — Claude-style custom
// visuals) render LIVE: an allow-scripts sandboxed iframe (no same-origin, so
// no parent/Tauri access) whose height auto-fits the content via a postMessage
// handshake. A compact toolbar carries Download + "Open in tab" (full-size
// preview) for both paths.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readArtifactPreview, type ArtifactPreview } from "../../lib/ipc";
import type { ChatArtifact } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { sanitizeHtml } from "../../lib/sanitize";
import { isInteractiveHtml } from "../../lib/interactiveHtml";
import { DiagramLightbox } from "./DiagramLightbox";
import { ArtifactExportMenu } from "./ArtifactExportMenu";

/** Injected into the iframe document (display only) so the diagram scales down
 *  to the chat width instead of overflowing with a scrollbar. Export still uses
 *  the untouched `preview.text`, so downloads keep the original resolution. */
/** Horizontal padding (px per side) inside the iframe so the diagram never
 *  touches the frame edge. */
const FIT_PAD_X = 12;
const FIT_PAD_Y = 8;
const FIT_STYLE =
  `<style>html{margin:0;overflow:hidden}body{margin:0;padding:${FIT_PAD_Y}px ${FIT_PAD_X}px;` +
  // No flex — flex collapses the body to the iframe height and breaks
  // scrollHeight measurement. Let the SVG flow as a block element.
  "background:#fff}" +
  // Force the SVG to shrink-to-fit the container width, preserving aspect ratio.
  "svg{display:block;width:100%!important;height:auto!important;max-height:none!important}" +
  // Also constrain wrapper divs so nothing overflows the frame.
  "body > div{max-width:100%!important}" +
  "</style>";

function withFitStyle(html: string): string {
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + FIT_STYLE);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${FIT_STYLE}</head>`);
  }
  return FIT_STYLE + html;
}

// ---- Live inline visuals (interactive HTML) ----
// Height bounds for the live frame: content-sized via postMessage, clamped so
// a runaway page can't push the chat into an endless scroll.
const LIVE_VIZ_DEFAULT_H = 300;
const LIVE_VIZ_MIN_H = 120;
const LIVE_VIZ_MAX_H = 520;

/** Injected into a live visual's iframe document: reports the content height
 *  to the parent whenever it changes (load + any resize), driving the
 *  clamped auto-height. Appended before </body> (or prepended) so it runs
 *  after the page's own markup. */
function withLiveResizeScript(html: string): string {
  const script =
    '<script>(function(){function r(){parent.postMessage(' +
    "{__conduitInlineVizHeight:Math.ceil(document.documentElement.scrollHeight)},'*')}" +
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
  const [measuredH, setMeasuredH] = useState(0);
  const blockRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const openArtifactTab = useUiStore((s) => s.openArtifactTab);

  const openInTab = () => {
    openArtifactTab({ path: artifact.path, filename: artifact.filename });
  };

  // Live inline visuals: the sandboxed frame can't be measured (no
  // allow-same-origin), so the injected reporter posts its content height up.
  // Only messages carrying the marker key are trusted — the frame has no
  // access to this window beyond postMessage.
  const [liveH, setLiveH] = useState<number | null>(null);
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data as { __conduitInlineVizHeight?: unknown } | null;
      if (
        d &&
        typeof d === "object" &&
        typeof d.__conduitInlineVizHeight === "number" &&
        Number.isFinite(d.__conduitInlineVizHeight)
      ) {
        setLiveH(
          Math.min(LIVE_VIZ_MAX_H, Math.max(LIVE_VIZ_MIN_H, d.__conduitInlineVizHeight)),
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
    setMeasuredH(0);
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
    () => (preview?.text != null ? sanitizeHtml(withFitStyle(preview.text)) : ""),
    [preview],
  );
  // Live-frame document, memoized so a parent re-render (token flushes while
  // the rest of the message streams) never changes the srcDoc string identity
  // — a changed attribute RELOADS the iframe, which flashed every interactive
  // visual on each streaming update.
  const liveSrcDoc = useMemo(
    () => (preview?.text != null ? withLiveResizeScript(preview.text) : ""),
    [preview],
  );

  // Measure the actual rendered height of the iframe content after it loads.
  // Uses allow-same-origin sandbox (no allow-scripts) so we can read
  // contentDocument — same approach as ArtifactPreviewPane. We measure the
  // SVG element's bounding rect directly (more reliable than body.scrollHeight
  // which can be wrong when body has flex/overflow styles) and wait a frame
  // for layout to settle before reading dimensions.
  const measureFrame = useCallback(() => {
    const frame = blockRef.current?.querySelector<HTMLIFrameElement>(".chat-diagram-frame");
    const doc = frame?.contentDocument;
    if (!doc) return;
    // Prefer the SVG element's rendered height — this is the actual content.
    const svg = doc.querySelector("svg");
    if (svg) {
      const rect = svg.getBoundingClientRect();
      if (rect.height > 0) {
        setMeasuredH(Math.round(rect.height) + FIT_PAD_Y * 2);
        return;
      }
    }
    // Fallback: body scrollHeight (includes all content, not just SVG).
    const h = doc.body?.scrollHeight ?? doc.documentElement?.scrollHeight ?? 0;
    if (h > 0) setMeasuredH(h);
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
    if (measuredH === 0) return;
    // Defer to let the SVG re-layout at the new width.
    const t = setTimeout(measureFrame, 50);
    return () => clearTimeout(t);
  }, [containerW, measureFrame, measuredH]);

  // Fallback height from SVG dims while waiting for the load event.
  const height = useMemo(() => {
    if (measuredH > 0) return measuredH;
    if (!preview?.text) return 320;
    const d = svgDims(preview.text);
    if (!d || d.w <= 0) return 320;
    const avail = containerW - FIT_PAD_X * 2;
    const ratio = avail > 0 && d.w > avail ? avail / d.w : 1;
    return Math.max(Math.round(d.h * ratio) + FIT_PAD_Y * 2, 120);
  }, [preview, containerW, measuredH]);

  if (error) {
    return <div className="chat-diagram-error">Could not load diagram: {error}</div>;
  }
  if (!preview) {
    return <div className="chat-diagram-loading">Loading diagram…</div>;
  }
  // Render diagrams AND HTML files inline. The "diagram" kind (from
  // generate_diagram, carrying the conduit:diagram marker) is the primary
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

  // Static diagrams render in the sanitized measuring frame. A transparent
  // click-catcher sits above the iframe (same-origin frames swallow clicks,
  // and diagrams are non-interactive anyway) so clicking opens the full-screen
  // zoom/pan lightbox.
  return (
    <div className="chat-diagram-block" ref={blockRef}>
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
