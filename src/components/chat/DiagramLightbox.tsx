// Full-screen zoom/pan viewer for an inline chat diagram (click a diagram →
// "open it in the chat screen"): mouse-wheel zoom anchored at the cursor,
// left-drag pan, −/+/reset controls, Esc or backdrop click to close.
//
// The diagram renders sanitized in the MAIN document (no iframe): inline
// diagrams are static vector art. Bare <svg> content (mermaid) is placed in
// a letterbox stage where the SVG's own preserveAspectRatio fits it — the
// whole diagram is ALWAYS visible, never cut; zoom is for detail. Full HTML
// documents render in a bounded, scrollable card instead (their scripts do
// not run here). Export actions live on the INLINE diagram's kebab, not here.
import { useEffect, useMemo, useRef, useState } from "react";
import { sanitizeHtml, sanitizeSvg } from "../../lib/sanitize";

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.15;

export function DiagramLightbox({
  html,
  filename,
  onClose,
}: {
  /** Sanitized-ready diagram markup (full HTML document or bare <svg>). */
  html: string;
  filename: string;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Wheel zoom anchored at the cursor: the content point under the pointer
  // stays put while zooming in or out.
  const zoomAnchor = useRef({ cx: 0, cy: 0 });
  const panDrag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const dragging = useRef(false);
  // Bare <svg> uses the letterbox stage (aspect-fit, never cut); full HTML
  // documents use the bounded scroll card.
  const isBareSvg = useMemo(() => /^\s*<svg[\s>]/i.test(html), [html]);

  // Esc closes; reset the view when a different diagram is opened.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [html]);

  return (
    <div
      className="diagram-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Diagram full view: ${filename}`}
      onClick={onClose}
    >
      <div className="diagram-lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <span className="diagram-lightbox-title">{filename}</span>
        <div className="diagram-lightbox-zoom">
          <button
            type="button"
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z / ZOOM_STEP))}
          >
            −
          </button>
          <button
            type="button"
            className="diagram-lightbox-zoom-level"
            title="Reset zoom"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP))}
          >
            +
          </button>
        </div>
        <button
          type="button"
          className="diagram-lightbox-close"
          title="Close (Esc)"
          aria-label="Close full view"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div
        className={isBareSvg ? "diagram-lightbox-stage" : "diagram-lightbox-content"}
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;
          zoomAnchor.current = { cx, cy };
          setZoom((z1) => {
            const z2 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z1 * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
            setPan((p) => ({
              x: cx - (cx - p.x) * (z2 / z1),
              y: cy - (cy - p.y) * (z2 / z1),
            }));
            return z2;
          });
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          panDrag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = panDrag.current;
          if (!d || !dragging.current) return;
          setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
        }}
        onPointerUp={() => {
          panDrag.current = null;
          dragging.current = false;
        }}
        onPointerCancel={() => {
          panDrag.current = null;
          dragging.current = false;
        }}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        {/* SECURITY: model-authored markup into the privileged document —
            sanitized with the matching profile (SVG vs HTML). The svg fills
            the letterbox stage via preserveAspectRatio, so the WHOLE diagram
            is always visible; the HTML card scrolls internally instead. */}
        <div
          className={isBareSvg ? "diagram-lightbox-svgfill" : "diagram-lightbox-doc"}
          dangerouslySetInnerHTML={{
            __html: isBareSvg ? sanitizeSvg(html) : sanitizeHtml(html),
          }}
        />
      </div>
    </div>
  );
}
