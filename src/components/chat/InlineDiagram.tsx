// Renders a generated vector diagram artifact inline in the chat message.
//
// The diagram is a self-contained HTML file (authored by `generate_diagram`
// as inline <svg>). We render it in a sandboxed iframe — identical to the
// preview pane, so it matches the PNG/SVG export exactly — but size the frame
// to the diagram's intrinsic height so it takes only the vertical space it
// truly needs (tall diagrams are capped and scroll). A compact toolbar carries
// the same Copy / PNG / SVG export controls the pane offered.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readArtifactPreview, downloadArtifact, type ArtifactPreview } from "../../lib/ipc";
import type { ChatArtifact } from "../../state/chat";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { sanitizeHtml } from "../../lib/sanitize";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [measuredH, setMeasuredH] = useState(0);
  const blockRef = useRef<HTMLDivElement>(null);
  const kebabRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);

  const setPreviewArtifact = useChatStore((s) => s.setPreviewArtifact);
  const setToolPanelTab = useUiStore((s) => s.setToolPanelTab);
  const setToolPanelCollapsed = useUiStore((s) => s.setToolPanelCollapsed);

  // Close kebab on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const openInCanvas = () => {
    setMenuOpen(false);
    setPreviewArtifact(artifact);
    setToolPanelTab("canvas");
    setToolPanelCollapsed(false);
  };

  const downloadFile = () => {
    setMenuOpen(false);
    void downloadArtifact(artifact.path, artifact.filename);
  };

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
  // Only true diagrams (authored via generate_diagram, carrying the
  // conduit:diagram marker) render inline in the chat. A plain .html file the
  // model produced via generate_file — a webpage, landing page, etc. — is NOT a
  // diagram and would be cramped/broken inline, so fall back to the download
  // chip and let the user open it in the preview pane instead. (An .svg file
  // comes back as kind "image" and also falls back here.)
  if (preview.kind !== "diagram" || preview.text == null) {
    return onFallback();
  }

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
      <div className="chat-diagram-actions" ref={kebabRef}>
        <div className="artifact-kebab">
          <button
            type="button"
            className="artifact-kebab-btn"
            title="Diagram actions"
            aria-label="Diagram actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="5" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="12" cy="19" r="1.8" />
            </svg>
          </button>
          {menuOpen && (
            <div className="artifact-kebab-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="artifact-kebab-item"
                onClick={downloadFile}
              >
                Download
              </button>
              <button
                type="button"
                role="menuitem"
                className="artifact-kebab-item"
                onClick={openInCanvas}
              >
                Open in Canvas
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
