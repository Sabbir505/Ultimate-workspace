// Full-screen zoom/pan viewer for an inline chat diagram (click a diagram →
// "open it in the chat screen"): mouse-wheel zoom anchored at the cursor,
// left-drag pan, −/+/reset controls, Esc or backdrop click to close.
//
// Rendered through a portal to document.body: an inline mount would let a
// transformed/filtered ancestor become the containing block for
// position:fixed, trapping the "fullscreen" overlay inside the chat column.
//
// The diagram renders sanitized in the MAIN document (no iframe): inline
// diagrams are static vector art. Bare <svg> content (mermaid) is placed on
// a white paper card sized to the SVG's own viewBox aspect (bounded to the
// viewport), and the svg's preserveAspectRatio fills it — the whole diagram
// is ALWAYS visible, never cut; zoom is for detail. Full HTML documents
// render in a bounded, scrollable card instead (their scripts do not run
// here). Pan is clamped so the card can never be dragged out of the
// lightbox. Export actions live on the INLINE diagram's kebab, not here.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { sanitizeHtml, sanitizeSvg } from "../../lib/sanitize";

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.15;

export function DiagramLightbox({
  html,
  filename,
  onClose,
  surface = "paper",
}: {
  /** Sanitized-ready diagram markup (full HTML document or bare <svg>). */
  html: string;
  filename: string;
  onClose: () => void;
  /** Which surface the diagram is themed for: mermaid renders dark-theme
   *  art on a TRANSPARENT canvas that floats on the chat background, so its
   *  lightbox paper must be the chat surface — not white. Static diagrams
   *  from generate_diagram render inline on a white iframe, so "paper"
   *  (white) matches those. */
  surface?: "paper" | "chat";
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Mirrors of zoom/pan for event handlers — pointermove/wheel fire faster
  // than React re-renders, and the anchor math needs the live values.
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const svgHostRef = useRef<HTMLDivElement>(null);
  // Wheel zoom anchored at the cursor: the content point under the pointer
  // stays put while zooming in or out.
  const panDrag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const dragging = useRef(false);
  // Bare <svg> uses the letterbox stage (aspect-fit, never cut); full HTML
  // documents use the bounded scroll card.
  const isBareSvg = useMemo(() => /^\s*<svg[\s>]/i.test(html), [html]);
  // Paper size for the bare-SVG stage, fit to the diagram's viewBox aspect
  // and capped to the usable viewport. null → fall back to the CSS sizing.
  const [paper, setPaper] = useState<{ w: number; h: number } | null>(null);

  const applyZoom = (z: number) => {
    zoomRef.current = z;
    setZoom(z);
  };
  const applyPan = (p: { x: number; y: number }) => {
    panRef.current = p;
    setPan(p);
  };

  // Keep the paper inside the lightbox: when it fits, it can move anywhere
  // while staying fully visible; when zoomed past fit, pan is bounded so an
  // edge can never be dragged past the opposite viewport edge. The clamp
  // recovers the stage's layout center by subtracting the current pan (the
  // transform scales around that center, so it is translation-invariant).
  const clampPan = (p: { x: number; y: number }, z: number): { x: number; y: number } => {
    const root = rootRef.current;
    const stage = stageRef.current;
    if (!root || !stage) return p;
    const vr = root.getBoundingClientRect();
    const chrome = toolbarRef.current?.offsetHeight ?? 0;
    const viewH = vr.height - chrome;
    if (vr.width < 2 || viewH < 2) return p; // not laid out (jsdom / hidden)
    const r = stage.getBoundingClientRect();
    const cx0 = r.left + r.width / 2 - p.x;
    const cy0 = r.top + r.height / 2 - p.y;
    const halfW = Math.min(stage.offsetWidth * z, vr.width) / 2;
    const halfH = Math.min(stage.offsetHeight * z, viewH) / 2;
    const minX = vr.left + halfW;
    const maxX = vr.right - halfW;
    const minY = vr.top + chrome + halfH;
    const maxY = vr.bottom - halfH;
    const cx = maxX < minX ? (minX + maxX) / 2 : Math.min(Math.max(cx0 + p.x, minX), maxX);
    const cy = maxY < minY ? (minY + maxY) / 2 : Math.min(Math.max(cy0 + p.y, minY), maxY);
    return { x: cx - cx0, y: cy - cy0 };
  };

  const zoomBy = (factor: number) => {
    const z1 = zoomRef.current;
    const z2 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z1 * factor));
    if (z2 === z1) return;
    applyPan(clampPan(panRef.current, z2));
    applyZoom(z2);
  };

  // Esc closes; reset the view when a different diagram is opened.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    applyZoom(1);
    applyPan({ x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  // Size the white paper to the diagram's own aspect so the letterbox card
  // hugs the drawing instead of being a fixed 92vw × 78vh slab.
  useLayoutEffect(() => {
    if (!isBareSvg) {
      setPaper(null);
      return;
    }
    const measure = () => {
      const svg = svgHostRef.current?.querySelector("svg");
      let aspect: number | null = null;
      const vb = svg?.getAttribute("viewBox") ?? "";
      const m = vb.trim().split(/[\s,]+/).map(Number);
      if (m.length === 4 && m[2] > 0 && m[3] > 0) aspect = m[2] / m[3];
      if (aspect == null && svg) {
        try {
          const b = (svg as SVGGraphicsElement).getBBox?.();
          if (b && b.width > 0 && b.height > 0) aspect = b.width / b.height;
        } catch {
          /* not rendered */
        }
      }
      if (aspect == null || !Number.isFinite(aspect) || aspect <= 0) {
        setPaper(null);
        return;
      }
      // Fit inside the lightbox area (window minus toolbar and margins).
      const availW = Math.max(240, window.innerWidth - 88);
      const availH = Math.max(240, window.innerHeight - 130);
      let w = availH * aspect;
      let h: number = availH;
      if (w > availW) {
        w = availW;
        h = w / aspect;
      }
      setPaper({ w: Math.round(w), h: Math.round(h) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [html, isBareSvg]);

  return createPortal(
    <div
      ref={rootRef}
      className="diagram-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Diagram full view: ${filename}`}
      onClick={onClose}
    >
      <div ref={toolbarRef} className="diagram-lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <span className="diagram-lightbox-title">{filename}</span>
        <div className="diagram-lightbox-zoom">
          <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
            −
          </button>
          <button
            type="button"
            className="diagram-lightbox-zoom-level"
            title="Reset zoom"
            onClick={() => {
              applyZoom(1);
              applyPan({ x: 0, y: 0 });
            }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
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
        ref={stageRef}
        className={
          isBareSvg
            ? `diagram-lightbox-stage${surface === "chat" ? " surface-chat" : ""}`
            : "diagram-lightbox-content"
        }
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;
          const z1 = zoomRef.current;
          const z2 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z1 * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
          if (z2 === z1) return;
          const raw = {
            x: cx - (cx - panRef.current.x) * (z2 / z1),
            y: cy - (cy - panRef.current.y) * (z2 / z1),
          };
          applyPan(clampPan(raw, z2));
          applyZoom(z2);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          panDrag.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y };
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = panDrag.current;
          if (!d || !dragging.current) return;
          applyPan(
            clampPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) }, zoomRef.current),
          );
        }}
        onPointerUp={() => {
          panDrag.current = null;
          dragging.current = false;
        }}
        onPointerCancel={() => {
          panDrag.current = null;
          dragging.current = false;
        }}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          ...(isBareSvg && paper ? { width: paper.w, height: paper.h } : null),
        }}
      >
        {/* SECURITY: model-authored markup into the privileged document —
            sanitized with the matching profile (SVG vs HTML). The svg fills
            the aspect-fit paper via preserveAspectRatio, so the WHOLE diagram
            is always visible; the HTML card scrolls internally instead. */}
        <div
          ref={svgHostRef}
          className={isBareSvg ? "diagram-lightbox-svgfill" : "diagram-lightbox-doc"}
          dangerouslySetInnerHTML={{
            __html: isBareSvg ? sanitizeSvg(html) : sanitizeHtml(html),
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
