// Full-screen zoom/pan viewer for an inline chat diagram (click a diagram →
// "open it in the chat screen"): mouse-wheel zoom anchored at the cursor
// (native non-passive listener), left-drag pan with a feedback-free clamp,
// −/+/reset controls, Esc or backdrop click to close.
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { sanitizeHtml, sanitizeSvg } from "../../lib/sanitize";

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.15;

/** Layout geometry the pan clamp needs. Every value is transform-
 *  independent (layout rects + offset* metrics), so clamping mid-drag or
 *  mid-wheel-burst never reads back the transform it just wrote. */
export interface StageGeometry {
  /** Untransformed layout center of the stage, in screen coordinates. */
  cx: number;
  cy: number;
  /** Visible area (root minus toolbar chrome), in screen coordinates. */
  view: { left: number; right: number; top: number; bottom: number };
  /** Unscaled layout size of the stage. */
  w: number;
  h: number;
}

/** Pure pan clamp. Below fit: the stage stays fully visible. At or past
 *  fit ("cover"): the stage keeps covering the view while the center slides
 *  across the slack (scaled size − view size) — that slack IS the pan range
 *  that lets you drag around a screen-filling diagram. An earlier version
 *  collapsed the cover interval to a point (`min(scaled, view)` half-size),
 *  which locked dragging entirely once the diagram filled the screen; and a
 *  version before that recovered the layout center from the live transform
 *  (violently unstable). Pure math on layout values cannot do either. */
export function clampPanToView(
  p: { x: number; y: number },
  z: number,
  g: StageGeometry,
): { x: number; y: number } {
  const halfW = (g.w * z) / 2;
  const halfH = (g.h * z) / 2;
  let minX = g.view.left + halfW;
  let maxX = g.view.right - halfW;
  let minY = g.view.top + halfH;
  let maxY = g.view.bottom - halfH;
  // Past fit the "fully visible" interval inverts into the "cover"
  // interval — swap the ends rather than collapsing them, so the clamp
  // keeps the free-pan slack instead of pinning the diagram to the center.
  if (maxX < minX) {
    const t = minX;
    minX = maxX;
    maxX = t;
  }
  if (maxY < minY) {
    const t = minY;
    minY = maxY;
    maxY = t;
  }
  const cx = Math.min(Math.max(g.cx + p.x, minX), maxX);
  const cy = Math.min(Math.max(g.cy + p.y, minY), maxY);
  return { x: cx - g.cx, y: cy - g.cy };
}

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

  const applyZoom = useCallback((z: number) => {
    zoomRef.current = z;
    setZoom(z);
  }, []);
  const applyPan = useCallback((p: { x: number; y: number }) => {
    panRef.current = p;
    setPan(p);
  }, []);

  // Measure the clamp geometry from LAYOUT values only: offsetLeft/Top/Width/
  // Height ignore transforms, and the stage's offsetParent (the lightbox
  // root — its only positioned ancestor) is itself untransformed. Nothing
  // here feeds back from the live transform, so the clamp is a pure
  // function of the pan being applied.
  const stageGeometry = useCallback((): StageGeometry | null => {
    const stage = stageRef.current;
    const root = rootRef.current;
    if (!stage || !root) return null;
    const vr = root.getBoundingClientRect();
    const chrome = toolbarRef.current?.offsetHeight ?? 0;
    if (vr.width < 2 || vr.height - chrome < 2) return null; // not laid out (jsdom / hidden)
    const parent = (stage.offsetParent as HTMLElement | null) ?? root;
    const pr = parent.getBoundingClientRect();
    return {
      cx: pr.left + stage.offsetLeft + stage.offsetWidth / 2,
      cy: pr.top + stage.offsetTop + stage.offsetHeight / 2,
      view: { left: vr.left, right: vr.right, top: vr.top + chrome, bottom: vr.bottom },
      w: stage.offsetWidth,
      h: stage.offsetHeight,
    };
  }, []);

  const clampPan = useCallback(
    (p: { x: number; y: number }, z: number): { x: number; y: number } => {
      const g = stageGeometry();
      return g ? clampPanToView(p, z, g) : p;
    },
    [stageGeometry],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const z1 = zoomRef.current;
      const z2 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z1 * factor));
      if (z2 === z1) return;
      applyPan(clampPan(panRef.current, z2));
      applyZoom(z2);
    },
    [applyPan, applyZoom, clampPan],
  );

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
  }, [html, applyZoom, applyPan]);

  // Wheel zoom, cursor-anchored — as a NATIVE non-passive listener: React
  // registers onWheel as passive at the root, so preventDefault() inside the
  // JSX prop is ignored (console warning + the page behind still scrolls).
  // Anchor math: with transform translate(p) scale(z) around the element's
  // CENTER, a layout point l renders at lc + p + (l − lc)·z; keeping the
  // point under the cursor fixed gives p2 = D − (D − p1)·(z2/z1) where
  // D = cursor − layout center. (The previous rect-left-based formula
  // assumed a different origin and slid the content away from the cursor.)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = stageGeometry();
      if (!g) return;
      const z1 = zoomRef.current;
      const z2 = Math.min(
        ZOOM_MAX,
        Math.max(ZOOM_MIN, z1 * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)),
      );
      if (z2 === z1) return;
      const k = z2 / z1;
      const dx = e.clientX - g.cx;
      const dy = e.clientY - g.cy;
      applyPan(
        clampPan(
          { x: dx - (dx - panRef.current.x) * k, y: dy - (dy - panRef.current.y) * k },
          z2,
        ),
      );
      applyZoom(z2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyPan, applyZoom, clampPan, stageGeometry]);

  // Size the white paper to the diagram's own aspect so the letterbox card
  // hugs the drawing instead of being a fixed 92vw × 78vh slab.
  useLayoutEffect(() => {
    if (!isBareSvg) {
      setPaper(null);
      return;
    }
    const measure = () => {
      const svg = svgHostRef.current?.querySelector("svg");
      // A root svg WITHOUT a viewBox crops its drawing to the svg viewport
      // (default overflow hidden) — and the viewport here is the paper, so
      // only the top-left slice of the diagram would ever render: panning
      // and zooming could never reach the rest (the "can't drag to the end
      // of the diagram" report). Mermaid's own renders always carry a
      // viewBox, but agent- or tool-written .svg files don't necessarily.
      // Derive one from the explicit size, else from the drawing's bbox, so
      // the browser letterboxes the FULL drawing into the paper instead.
      if (svg && !svg.getAttribute("viewBox")) {
        const dim = (name: string): number | null => {
          const raw = svg.getAttribute(name) ?? "";
          if (raw.trim().endsWith("%")) return null;
          const n = parseFloat(raw);
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        const w = dim("width");
        const h = dim("height");
        let bw = w;
        let bh = h;
        if (bw == null || bh == null) {
          try {
            const b = (svg as SVGGraphicsElement).getBBox?.();
            if (b && b.width > 0 && b.height > 0) {
              bw ??= b.width;
              bh ??= b.height;
            }
          } catch {
            /* not rendered */
          }
        }
        if (bw != null && bh != null) {
          svg.setAttribute("viewBox", `0 0 ${bw} ${bh}`);
        }
      }
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
