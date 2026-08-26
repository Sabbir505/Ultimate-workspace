// Full-screen zoom/pan viewer for an inline chat diagram (click a diagram →
// "open it in the chat screen"): mouse-wheel zoom anchored at the cursor,
// left-drag pan, −/+/reset controls, Esc or backdrop click to close, and the
// top-right 3-dot menu reusing ArtifactExportMenu for Copy / PNG / SVG / JPG.
//
// The diagram renders sanitized in the MAIN document (no iframe): inline
// diagrams are static vector art, and DOM rendering lets html-to-image
// rasterize exactly what is on screen. Interactive visuals keep their live
// iframe in chat — the lightbox is for looking at pictures, big.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArtifactExportMenu } from "./ArtifactExportMenu";
import { sanitizeHtml } from "../../lib/sanitize";
import type { ArtifactPreview } from "../../lib/ipc";

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
  const contentRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  const wheelZoomed = useRef(false);
  const prevZoom = useRef(1);
  const panDrag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // Wheel zoom anchored at the cursor (same model as ArtifactPreviewPane's
  // canvas): the content point under the pointer stays put.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const clamp = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const z1 = zoomRef.current;
      const z2 = clamp(z1 * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
      wheelZoomed.current = true;
      setPan((p) => ({
        x: cx - (cx - p.x) * (z2 / z1),
        y: cy - (cy - p.y) * (z2 / z1),
      }));
      setZoom(z2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Button zooms re-anchor at the pane center.
  useEffect(() => {
    const el = contentRef.current;
    const z1 = prevZoom.current;
    prevZoom.current = zoom;
    if (!el || z1 === zoom) return;
    if (wheelZoomed.current) {
      wheelZoomed.current = false;
      return;
    }
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    setPan((p) => ({
      x: cx - (cx - p.x) * (zoom / z1),
      y: cy - (cy - p.y) * (zoom / z1),
    }));
  }, [zoom]);

  const onPanStart = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = contentRef.current;
    if (!el) return;
    panDrag.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y };
    el.setPointerCapture(e.pointerId);
    el.classList.add("panning");
  }, []);
  const onPanMove = useCallback((e: React.PointerEvent) => {
    const d = panDrag.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  }, []);
  const onPanEnd = useCallback((e: React.PointerEvent) => {
    panDrag.current = null;
    const el = contentRef.current;
    if (!el) return;
    el.classList.remove("panning");
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }, []);

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

  // Synthetic preview so the shared export menu treats this as a diagram
  // (Copy / PNG / SVG / JPG all rasterize `text`).
  const preview: ArtifactPreview = {
    path: filename,
    filename,
    ext: "html",
    kind: "diagram",
    text: html,
    dataUri: null,
    size: html.length,
    truncated: false,
  };

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
            onClick={() => setZoom(1)}
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
        <ArtifactExportMenu preview={preview} path={filename} filename={filename} variant="kebab" />
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
        className="diagram-lightbox-content"
        ref={contentRef}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
      >
        <div
          className="diagram-lightbox-canvas"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          {/* SECURITY: model-authored markup into the privileged document —
              sanitized first (scripts/event handlers stripped). */}
          <div
            className="diagram-lightbox-doc"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
          />
        </div>
      </div>
    </div>
  );
}
