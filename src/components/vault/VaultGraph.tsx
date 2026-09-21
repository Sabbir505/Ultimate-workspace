// Vault graph — a force-directed map of the link index (the Obsidian graph
// view's role). Rendering is 2D canvas with a hand-rolled d3-force-class
// simulation (repulsion + spring links + centering), which is testable as a
// pure function and dependency-free.
//
// Interaction contract: the layout is FROZEN once the seed settles. Hover,
// pan and zoom only repaint — they must never step the simulation, or nodes
// drift under a stationary cursor and hover lands on the wrong node. Only
// dragging a node perturbs the layout, and the sim re-runs just long enough
// to resettle after release. Hover shows a detail card anchored to the node
// (plus a highlight ring), the wheel zooms around the cursor, empty-space
// drag pans, and the legend picks colors and toggles kinds.

import { useEffect, useMemo, useRef, useState } from "react";
import type { VaultGraphEdge, VaultGraphNode } from "../../lib/ipc";

export interface LayoutNode {
  id: string;
  label: string;
  unresolved: boolean;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  iterations: number;
  /** Force strengths (exposed for tuning + tests). */
  repulsion?: number;
  spring?: number;
  center?: number;
  /** Node id held immobile (velocity zeroed, position untouched) — the
   *  just-dragged node during a post-drag settle, so it stays where it was
   *  dropped instead of being pulled back by its springs. */
  fixedId?: string;
  /** Soft-clamp box (world coordinates). Default: the viewport inset by 16px
   *  — the graph component passes a larger pannable world. */
  minX?: number;
  minY?: number;
  maxX?: number;
  maxY?: number;
}

const DEFAULT_FORCES = { repulsion: 2600, spring: 0.015, center: 0.02 };

/** One deterministic simulation step (Fruchterman-Reingold-style). Pure:
 *  mutates and returns `nodes` — tests assert convergence properties. */
export function simulateStep(
  nodes: LayoutNode[],
  edges: VaultGraphEdge[],
  opts: {
    width: number;
    height: number;
    repulsion?: number;
    spring?: number;
    center?: number;
    fixedId?: string;
    minX?: number;
    minY?: number;
    maxX?: number;
    maxY?: number;
  },
): LayoutNode[] {
  const { width, height, repulsion, spring, center, fixedId } = { ...DEFAULT_FORCES, ...opts };
  const cx = width / 2;
  const cy = height / 2;
  const minX = opts.minX ?? 16;
  const minY = opts.minY ?? 16;
  const maxX = opts.maxX ?? width - 16;
  const maxY = opts.maxY ?? height - 16;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Pairwise repulsion, capped: layout quality saturates well below 400
  // nodes and O(n²) keeps v1 honest about that (the WebGL upgrade path is
  // documented in the research doc).
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1e-6) {
        dx = (Math.random() - 0.5) * 2;
        dy = (Math.random() - 0.5) * 2;
        d2 = dx * dx + dy * dy;
      }
      const d = Math.sqrt(d2);
      const f = repulsion / d2;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }
  // Springs along edges toward an ideal length.
  const ideal = Math.max(60, Math.sqrt((width * height) / Math.max(1, nodes.length)) * 1.4);
  for (const e of edges) {
    const a = byId.get(e.src);
    const b = byId.get(e.dst);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - ideal) * spring;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }
  // Centering + integrate with velocity damping.
  for (const n of nodes) {
    if (n.id === fixedId) {
      // Pinned: the dropped node holds its position while the rest of the
      // layout resettles around it.
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx += (cx - n.x) * center;
    n.vy += (cy - n.y) * center;
    n.vx *= 0.85;
    n.vy *= 0.85;
    n.x += Math.max(-12, Math.min(12, n.vx));
    n.y += Math.max(-12, Math.min(12, n.vy));
    // Keep inside the world box (soft clamp).
    n.x = Math.max(minX, Math.min(maxX, n.x));
    n.y = Math.max(minY, Math.min(maxY, n.y));
  }
  return nodes;
}

/** Pre-run the simulation so the graph opens already laid out. */
export function seedLayout(
  nodes: VaultGraphNode[],
  edges: VaultGraphEdge[],
  opts: { width: number; height: number; iterations?: number },
): LayoutNode[] {
  const layout: LayoutNode[] = nodes.map((n, i) => ({
    id: n.id,
    label: n.label,
    unresolved: n.unresolved,
    degree: n.degree,
    // Deterministic ring start (no Math.random — tests stay reproducible).
    x: opts.width / 2 + Math.cos((i / Math.max(1, nodes.length)) * Math.PI * 2) * (opts.width / 3),
    y: opts.height / 2 + Math.sin((i / Math.max(1, nodes.length)) * Math.PI * 2) * (opts.height / 3),
    vx: 0,
    vy: 0,
  }));
  const iters = opts.iterations ?? 220;
  for (let i = 0; i < iters; i += 1) {
    simulateStep(layout, edges, { width: opts.width, height: opts.height });
  }
  return layout;
}

/** Node kind for coloring/filtering. Unresolved = linked but missing on
 *  disk (id is `unresolved:<raw>`); attachments are indexed non-md files. */
export type GraphKind = "note" | "attachment" | "unresolved";
export function kindOf(n: { id: string; unresolved: boolean }): GraphKind {
  if (n.unresolved) return "unresolved";
  return n.id.toLowerCase().endsWith(".md") ? "note" : "attachment";
}
export const KIND_ORDER: GraphKind[] = ["note", "attachment", "unresolved"];
export const KIND_LABEL: Record<GraphKind, string> = {
  note: "Notes",
  attachment: "Attachments",
  unresolved: "Unresolved links",
};

function nodeRadius(n: LayoutNode): number {
  return 3.5 + Math.min(9, Math.sqrt(Math.max(0, n.degree)) * 1.7);
}

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;
const COLOR_KEY = "relay.vault.graphColors";
const DEFAULT_COLORS: Record<GraphKind, string> = {
  note: "#a8b3c7",
  attachment: "#e0b05e",
  unresolved: "#d97e6a",
};

/** Per-kind custom colors survive restarts; guarded like the layout blob. */
function loadColors(): Record<GraphKind, string> {
  try {
    const raw = localStorage.getItem(COLOR_KEY);
    if (!raw) return { ...DEFAULT_COLORS };
    const p = JSON.parse(raw) as Partial<Record<GraphKind, string>>;
    const ok = (c: unknown) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
    return {
      note: ok(p.note) ? p.note! : DEFAULT_COLORS.note,
      attachment: ok(p.attachment) ? p.attachment! : DEFAULT_COLORS.attachment,
      unresolved: ok(p.unresolved) ? p.unresolved! : DEFAULT_COLORS.unresolved,
    };
  } catch {
    return { ...DEFAULT_COLORS };
  }
}

function saveColors(c: Record<GraphKind, string>) {
  try {
    localStorage.setItem(COLOR_KEY, JSON.stringify(c));
  } catch {
    // storage unavailable — colors just won't persist
  }
}

export function VaultGraph({
  nodes,
  edges,
  activePath,
  onOpenNode,
  compact = false,
}: {
  nodes: VaultGraphNode[];
  edges: VaultGraphEdge[];
  activePath: string | null;
  onOpenNode: (path: string) => void;
  /** Rail-sized variant (local graph): identical engine and interactions,
   *  minus the legend/model chrome that only fits the full overlay. */
  compact?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<LayoutNode[]>([]);
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const nodeDragRef = useRef<{ id: string; offsetX: number; offsetY: number; moved: boolean } | null>(null);
  // Node pinned for the CURRENT settle — the one just dropped, so it stays
  // where the user left it (a low-degree node otherwise gets dragged straight
  // back to spring equilibrium: the "subnodes won't move" report).
  const pinnedNodeRef = useRef<string | null>(null);
  const panRef = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);
  const hoverRef = useRef<string | null>(null);
  const sizeRef = useRef({ width: 800, height: 600 });
  const hiddenKindsRef = useRef<Set<GraphKind>>(new Set());
  const colorsRef = useRef<Record<GraphKind, string>>(loadColors());
  // The hovered node's screen position drives the detail card (React state —
  // the canvas render itself stays ref-driven). Anchored to the NODE, not
  // the cursor, so it never chases the mouse.
  const [hoverCard, setHoverCard] = useState<{ id: string; x: number; y: number } | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<Set<GraphKind>>(new Set());
  const [colors, setColors] = useState<Record<GraphKind, string>>(() => colorsRef.current);
  const [zoomLabel, setZoomLabel] = useState(100);
  // Last seen cursor (canvas-local CSS px) — lets us re-evaluate hover after
  // the layout moved under a stationary cursor.
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const pickRef = useRef<((cssX: number, cssY: number) => LayoutNode | null) | null>(null);
  /** visual/layout scale of the canvas box (CSS zoom, transforms) — keeps
   *  the backing store sharp and pointer math honest. */
  const visualScaleRef = useRef(1);

  const kindCounts = useMemo(() => {
    const counts: Record<GraphKind, number> = { note: 0, attachment: 0, unresolved: 0 };
    for (const n of nodes) counts[kindOf(n)] += 1;
    return counts;
  }, [nodes]);

  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      if (!adj.has(a)) adj.set(a, new Set());
      adj.get(a)!.add(b);
    };
    for (const e of edges) {
      add(e.src, e.dst);
      add(e.dst, e.src);
    }
    return adj;
  }, [edges]);

  // Canvas render effect. `render` paints one frame; the simulation loop is
  // ONLY started by settleLayout() (after seed / node-drag release). Hover,
  // pan and zoom call `repaint` — layout stays frozen, so a stationary
  // cursor always keeps hovering the same node.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let simRaf = 0;
    let paintRaf = 0;
    let simulating = false;

    const resize = () => {
      // Layout px (clientWidth/Height) are CSS-zoom independent — the app's
      // Ctrl+/- html zoom must not inflate the canvas's layout box. The
      // visual/layout ratio only sharpens the backing store.
      const layoutW = wrap.clientWidth;
      const layoutH = wrap.clientHeight;
      const rect = wrap.getBoundingClientRect();
      const vscale = layoutW ? rect.width / layoutW : 1;
      visualScaleRef.current = vscale;
      sizeRef.current = { width: layoutW, height: layoutH };
      const dpr = (window.devicePixelRatio || 1) * vscale;
      canvas.width = Math.max(1, Math.floor(layoutW * dpr));
      canvas.height = Math.max(1, Math.floor(layoutH * dpr));
      canvas.style.width = `${layoutW}px`;
      canvas.style.height = `${layoutH}px`;
      repaint();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const render = () => {
      paintRaf = 0;
      const { width, height } = sizeRef.current;
      const dpr = (window.devicePixelRatio || 1) * visualScaleRef.current;
      const ctx = canvas.getContext("2d");
      // Canvas can't resolve CSS variables — read the theme tokens once per
      // frame off the wrapper (cheap; matches the app's theme switching).
      const styles = getComputedStyle(wrap);
      const colActive = styles.getPropertyValue("--vault-graph-active").trim() || "#5b8def";
      const colLabel = styles.getPropertyValue("--vault-graph-label").trim() || "#9aa3b2";
      const colorsNow = colorsRef.current;
      const view = viewRef.current;
      const hidden = hiddenKindsRef.current;
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.translate(view.x, view.y);
      ctx.scale(view.k, view.k);
      const hover = hoverRef.current;
      const neighbors = hover ? adjacency.get(hover) : null;
      const visible = (n: LayoutNode) => !hidden.has(kindOf(n));
      // Edges.
      const byId = new Map(layoutRef.current.map((n) => [n.id, n]));
      for (const e of edges) {
        const a = byId.get(e.src);
        const b = byId.get(e.dst);
        if (!a || !b || !visible(a) || !visible(b)) continue;
        const dim = hover && e.src !== hover && e.dst !== hover;
        ctx.strokeStyle = dim ? "rgba(128,128,128,0.08)" : "rgba(128,140,160,0.35)";
        ctx.lineWidth = 1 / view.k;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // Nodes.
      for (const n of layoutRef.current) {
        if (!visible(n)) continue;
        const kind = kindOf(n);
        const dim = hover && n.id !== hover && !neighbors?.has(n.id);
        const r = nodeRadius(n);
        ctx.globalAlpha = dim ? 0.12 : 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        if (kind === "unresolved") {
          ctx.strokeStyle = colorsNow[kind];
          ctx.lineWidth = 1.2 / view.k;
          ctx.stroke();
        } else {
          ctx.fillStyle = n.id === activePath ? colActive : colorsNow[kind];
          ctx.fill();
        }
        // The hovered node gets a ring — unambiguous "this is hovered".
        if (n.id === hover) {
          ctx.strokeStyle = colActive;
          ctx.lineWidth = 1.6 / view.k;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 3 / view.k, 0, Math.PI * 2);
          ctx.stroke();
        }
        // Label at larger radii / hover (cull when zoomed far out).
        if (!dim && (r * view.k > 5 || n.id === hover || n.id === activePath)) {
          ctx.font = `${10 / view.k}px sans-serif`;
          ctx.fillStyle = colLabel;
          ctx.fillText(n.label.slice(0, 28), n.x + r + 3 / view.k, n.y + 3 / view.k);
        }
        ctx.globalAlpha = 1;
      }
    };

    const simFrame = () => {
      simRaf = 0;
      const { width, height } = sizeRef.current;
      // A pannable world 1.6× the viewport. Clamp box (0..world) matches the
      // centering force's target (worldW/2, worldH/2) — a centered-but-
      // offset world made the layout slide below the viewport on open.
      const worldW = width * 1.6;
      const worldH = height * 1.6;
      for (let i = 0; i < 2; i += 1) {
        simulateStep(layoutRef.current, edges, {
          width: worldW,
          height: worldH,
          minX: 0,
          minY: 0,
          maxX: worldW,
          maxY: worldH,
          fixedId: pinnedNodeRef.current ?? undefined,
        });
      }
      render();
      let motion = 0;
      for (const n of layoutRef.current) motion += Math.abs(n.vx) + Math.abs(n.vy);
      if (motion < 1) {
        simulating = false; // settled — the layout freezes again
        pinnedNodeRef.current = null; // the dropped node keeps its spot
        // Settling moved nodes under a possibly-stationary cursor:
        // re-evaluate hover at the last known position.
        const lc = lastCursorRef.current;
        if (lc && pickRef.current) {
          const n = pickRef.current(lc.x, lc.y);
          hoverRef.current = n?.id ?? null;
          if (n) {
            const v = viewRef.current;
            setHoverCard({ id: n.id, x: n.x * v.k + v.x + 14, y: n.y * v.k + v.y + 10 });
          } else {
            setHoverCard(null);
          }
        }
        return;
      }
      simRaf = requestAnimationFrame(simFrame);
    };

    const resumeSim = () => {
      if (!simulating) {
        simulating = true;
        if (!simRaf) simRaf = requestAnimationFrame(simFrame);
      }
    };
    function repaint() {
      if (!simulating && !paintRaf) paintRaf = requestAnimationFrame(render);
    }
    settleRef.current = resumeSim;
    repaintRef.current = repaint;

    resize();
    return () => {
      cancelAnimationFrame(simRaf);
      cancelAnimationFrame(paintRaf);
      simRaf = 0;
      paintRaf = 0;
      settleRef.current = () => {};
      repaintRef.current = () => {};
      ro.disconnect();
    };
  }, [edges, adjacency, activePath]);

  // Extra refs so the pointer effect (which mounts once per onOpenNode)
  // reaches the current loop without re-binding listeners.
  const repaintRef = useRef<() => void>(() => {});
  const settleRef = useRef<() => void>(() => {});

  // Seed the layout when the DATA changes, then fit the view to it. The
  // seed is fully converged — NO live settling on open (that drift is what
  // used to leave the graph below the screen and break hover accuracy).
  // The sim only re-runs after a node drag (settleRef).
  //
  // Identity churn guard: the store reloads the graph (new arrays, same
  // content) on every vault:changed — re-seeding then teleports every node
  // and breaks hover under a stationary cursor. Compare content signatures
  // and keep the frozen layout unless something actually changed.
  // Cheap incremental fingerprint instead of a full JSON.stringify of every
  // node+edge: counts + per-item id/degree appended to a string — the same
  // invalidation semantics without serializing the whole graph on every
  // store reload.
  const dataSignature = useMemo(() => {
    let sig = `n${nodes.length}:e${edges.length}`;
    for (const n of nodes) sig += `|${n.id},${n.unresolved ? 1 : 0},${n.degree}`;
    for (const e of edges) sig += `;${e.src}>${e.dst}`;
    return sig;
  }, [nodes, edges]);
  const signatureRef = useRef<string>(dataSignature);
  useEffect(() => {
    if (signatureRef.current === dataSignature && layoutRef.current.length > 0) {
      return; // same graph — keep positions, hover, everything
    }
    signatureRef.current = dataSignature;
    const { width, height } = sizeRef.current;
    const worldW = width * 1.6;
    const worldH = height * 1.6;
    layoutRef.current = seedLayout(nodes, edges, { width: worldW, height: worldH });
    fitView();
    // The layout moved under the cursor — re-evaluate hover at the last
    // known position (or clear it when we never saw the cursor).
    const lc = lastCursorRef.current;
    if (lc && pickRef.current) {
      const n = pickRef.current(lc.x, lc.y);
      hoverRef.current = n?.id ?? null;
      if (n) {
        const v = viewRef.current;
        setHoverCard({ id: n.id, x: n.x * v.k + v.x + 14, y: n.y * v.k + v.y + 10 });
      } else {
        setHoverCard(null);
      }
    } else {
      hoverRef.current = null;
      setHoverCard(null);
    }
    repaintRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSignature]);

  const fitView = () => {
    const { width, height } = sizeRef.current;
    const layout = layoutRef.current;
    if (layout.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of layout) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    const pad = 40;
    const k = Math.min(
      ZOOM_MAX,
      Math.max(ZOOM_MIN, Math.min((width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY))),
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    viewRef.current = { x: width / 2 - cx * k, y: height / 2 - cy * k, k };
    setZoomLabel(Math.round(k * 100));
    repaintRef.current();
  };

  // Pointer + wheel interactions. Hit-testing is radius-aware and converts
  // screen → world through the pan/zoom transform.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const toWorld = (sx: number, sy: number) => {
      const v = viewRef.current;
      return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k };
    };
    const pick = (cssX: number, cssY: number): LayoutNode | null => {
      const w = toWorld(cssX, cssY);
      const k = viewRef.current.k;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.font = `${10 / k}px sans-serif`;
      // TWO PASSES: a node's circle always beats another node's label. A
      // single-pass version let a long label rect from a NEIGHBORING node
      // steal the pick from the dot actually under the cursor — the classic
      // "I hover one node, the ring shows another" report.
      let circleBest: LayoutNode | null = null;
      let circleD = Infinity;
      let labelBest: LayoutNode | null = null;
      let labelD = Infinity;
      for (const n of layoutRef.current) {
        if (hiddenKindsRef.current.has(kindOf(n))) continue;
        const r = nodeRadius(n);
        const d = (n.x - w.x) ** 2 + (n.y - w.y) ** 2;
        if (d < (r + 4 / k) ** 2 && d < circleD) {
          circleD = d;
          circleBest = n;
          continue;
        }
        // The label is drawn next to the circle — hovering the TEXT must
        // hit the node too (long labels dwarf the 3.5px dot). Measured in
        // world units so the test is zoom-independent.
        const labelDrawn = r * k > 5 || n.id === hoverRef.current;
        if (labelDrawn && ctx) {
          const lw = ctx.measureText(n.label.slice(0, 28)).width;
          const x0 = n.x + r;
          const x1 = x0 + lw + 3 / k;
          const yPad = 7 / k;
          if (w.x > x0 && w.x < x1 && Math.abs(w.y - n.y) < yPad) {
            const dl = (w.x - x0) ** 2 + (w.y - n.y) ** 2;
            if (dl < labelD) {
              labelD = dl;
              labelBest = n;
            }
          }
        }
      }
      return circleBest ?? labelBest;
    };
    pickRef.current = pick;
    // Zoom-aware cursor conversion. The app's Ctrl+/- feature sets CSS zoom
    // on <html>, which VISUALLY scales the canvas: clientX/Y arrive in
    // visual px while the graph math runs in layout px. Without dividing by
    // the visual/layout ratio, every pick lands ~zoom% off toward the
    // canvas's far edge — the "hover is on another node" bug.
    const canvasPoint = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width / (canvas.clientWidth || rect.width) || 1;
      const sy = rect.height / (canvas.clientHeight || rect.height) || 1;
      return { x: (e.clientX - rect.left) / sx, y: (e.clientY - rect.top) / sy, scale: sx };
    };
    const onDown = (e: PointerEvent) => {
      const p = canvasPoint(e);
      lastCursorRef.current = { x: p.x, y: p.y };
      const n = pick(p.x, p.y);
      if (n) {
        const w = toWorld(p.x, p.y);
        nodeDragRef.current = { id: n.id, offsetX: n.x - w.x, offsetY: n.y - w.y, moved: false };
      } else {
        const v = viewRef.current;
        panRef.current = { sx: e.clientX, sy: e.clientY, x: v.x, y: v.y };
      }
      canvas.style.cursor = "grabbing";
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // A synthetic pointer or one already implicitly released — capture
        // is an optimization; letting the throw escape would kill the click.
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = canvasPoint(e);
      lastCursorRef.current = { x: p.x, y: p.y };
      if (nodeDragRef.current) {
        const drag = nodeDragRef.current;
        const w = toWorld(p.x, p.y);
        const node = layoutRef.current.find((x) => x.id === drag.id);
        if (node) {
          const nx = w.x + drag.offsetX;
          const ny = w.y + drag.offsetY;
          if (Math.hypot(nx - node.x, ny - node.y) * viewRef.current.k > 3) drag.moved = true;
          node.x = nx;
          node.y = ny;
          node.vx = 0;
          node.vy = 0;
          repaintRef.current();
        }
        return;
      }
      if (panRef.current) {
        const pan = panRef.current;
        viewRef.current = { ...viewRef.current, x: pan.x + (e.clientX - pan.sx), y: pan.y + (e.clientY - pan.sy) };
        setHoverCard(null);
        repaintRef.current();
        return;
      }
      const n = pick(p.x, p.y);
      const prev = hoverRef.current;
      hoverRef.current = n?.id ?? null;
      if (n) {
        const v = viewRef.current;
        // Anchor the card to the NODE's screen position — it stays glued to
        // the circle instead of trailing the mouse.
        setHoverCard({
          id: n.id,
          x: n.x * v.k + v.x + 14,
          y: n.y * v.k + v.y + 10,
        });
      } else if (prev) {
        setHoverCard(null);
      }
      if (hoverRef.current !== prev) {
        // Diagnostics (dev builds): everything needed to audit a wrong pick —
        // cursor in corrected layout px, the world point it maps to, the
        // active view transform, the canvas box, DPR + the CSS-zoom scale,
        // and what was picked where.
        const wpt = toWorld(p.x, p.y);
        console.debug("[vault-graph] hover", {
          cursorCss: { x: +p.x.toFixed(1), y: +p.y.toFixed(1) },
          world: { x: +wpt.x.toFixed(1), y: +wpt.y.toFixed(1) },
          view: { x: +viewRef.current.x.toFixed(1), y: +viewRef.current.y.toFixed(1), k: +viewRef.current.k.toFixed(3) },
          canvasScale: +p.scale.toFixed(3),
          dpr: window.devicePixelRatio,
          picked: n
            ? { id: n.id, world: { x: +n.x.toFixed(1), y: +n.y.toFixed(1) }, r: +nodeRadius(n).toFixed(1) }
            : null,
          prev,
        });
      }
      if (hoverRef.current !== prev) repaintRef.current();
    };
    const onUp = (e: PointerEvent) => {
      const drag = nodeDragRef.current;
      nodeDragRef.current = null;
      panRef.current = null;
      canvas.style.cursor = "default";
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Already implicitly released (fast clicks): the throw used to abort
        // this handler BEFORE the click-to-open logic ever ran.
      }
      // Only a real node DRAG perturbs the layout — resettle the springs
      // around its new position, with the dropped node pinned so it stays
      // exactly where released while everything else rebalances.
      if (drag?.moved) {
        pinnedNodeRef.current = drag.id;
        settleRef.current();
      }
      // A click (no drag) opens the node — notes open in the editor, assets
      // in the asset pane (the parent routes by extension).
      if (drag && !drag.moved) {
        const node = layoutRef.current.find((x) => x.id === drag.id);
        if (node && kindOf(node) !== "unresolved") {
          if (import.meta.env.DEV) {
            console.debug("[vault-graph] click → open", { id: node.id, kind: kindOf(node) });
          }
          onOpenNode(node.id);
        }
      }
    };
    const onCancel = () => {
      // Pointercancel (alt-tab, touch arbitration): drop transient state so
      // a stale drag/pan doesn't swallow the next click.
      nodeDragRef.current = null;
      panRef.current = null;
      canvas.style.cursor = "default";
    };
    const onLeave = () => {
      hoverRef.current = null;
      setHoverCard(null);
      repaintRef.current();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const v = viewRef.current;
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * Math.exp(-e.deltaY * 0.0012)));
      // Keep the point under the cursor fixed while zooming.
      viewRef.current = {
        k,
        x: sx - ((sx - v.x) * k) / v.k,
        y: sy - ((sy - v.y) * k) / v.k,
      };
      setZoomLabel(Math.round(k * 100));
      setHoverCard(null);
      repaintRef.current();
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [onOpenNode]);

  // Devtools handle: `__vaultGraph.view` / `.layout` / `.fit()` for live
  // inspection of a wrong-hover report (log above prints the same numbers).
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__vaultGraph = {
      layout: layoutRef,
      view: viewRef,
      size: sizeRef,
      fit: () => fitView(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleKind = (kind: GraphKind) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      hiddenKindsRef.current = next;
      return next;
    });
    repaintRef.current();
  };

  const changeColor = (kind: GraphKind, color: string) => {
    setColors((prev) => {
      const next = { ...prev, [kind]: color };
      colorsRef.current = next;
      saveColors(next);
      return next;
    });
    repaintRef.current();
  };

  const hoverNode = hoverCard ? layoutRef.current.find((n) => n.id === hoverCard.id) : null;

  return (
    <div className="vault-graph" ref={wrapRef}>
      <canvas ref={canvasRef} className="vault-graph-canvas" />
      {/* Node detail card (hover) */}
      {hoverNode && hoverCard ? (
        <div
          className="vault-graph-card"
          style={{ left: Math.min(hoverCard.x, (sizeRef.current.width ?? 300) - 200), top: hoverCard.y }}
        >
          <div className="vault-graph-card-title">{hoverNode.label.slice(0, 40)}</div>
          <div className="vault-graph-card-kind">{KIND_LABEL[kindOf(hoverNode)]}</div>
          <div className="vault-graph-card-meta">
            {hoverNode.degree} link{hoverNode.degree === 1 ? "" : "s"}
            {kindOf(hoverNode) !== "unresolved" ? " · click to open" : ""}
          </div>
        </div>
      ) : null}
      {/* Legend / model — top right; swatch recolors, click text toggles.
          Compact (rail) graphs drop it: with a handful of nodes the kinds
          are obvious and the panel would fill the rail. */}
      {!compact && (
      <div className="vault-graph-model">
        <div className="vault-graph-model-title">Graph model</div>
        {KIND_ORDER.map((kind) => (
          <div key={kind} className={`vault-graph-model-row${hiddenKinds.has(kind) ? " off" : ""}`}>
            <label
              className="vault-graph-swatch"
              title={`Color for ${KIND_LABEL[kind]}`}
              style={{ background: kind === "unresolved" ? "transparent" : colors[kind], borderColor: colors[kind] }}
            >
              <input
                type="color"
                value={colors[kind]}
                onChange={(e) => changeColor(kind, e.target.value)}
              />
            </label>
            <button className="vault-graph-model-toggle" onClick={() => toggleKind(kind)} title={hiddenKinds.has(kind) ? "Show" : "Hide"}>
              {KIND_LABEL[kind]}
            </button>
            <span className="vault-graph-count">{kindCounts[kind]}</span>
          </div>
        ))}
        <button className="vault-graph-model-row fit" onClick={fitView} title="Fit the whole graph">
          Fit view · {zoomLabel}%
        </button>
      </div>
      )}
      {!compact && (
        <div className="vault-graph-legend">
          <span>Click: open · Drag node: arrange · Drag space: pan · Wheel: zoom</span>
        </div>
      )}
    </div>
  );
}
