// Vault graph — a force-directed map of the link index (the Obsidian graph
// view's role). Rendering is 2D canvas with a hand-rolled d3-force-class
// simulation (repulsion + spring links + centering), which is testable as a
// pure function and dependency-free. Hover highlights a node's direct
// neighbors and fades the rest, exactly like the local-graph hover.

import { useEffect, useMemo, useRef } from "react";
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
}

const DEFAULT_FORCES = { repulsion: 2600, spring: 0.015, center: 0.02 };

/** One deterministic simulation step (Fruchterman-Reingold-style). Pure:
 *  mutates and returns `nodes` — tests assert convergence properties. */
export function simulateStep(
  nodes: LayoutNode[],
  edges: VaultGraphEdge[],
  opts: { width: number; height: number; repulsion?: number; spring?: number; center?: number },
): LayoutNode[] {
  const { width, height, repulsion, spring, center } = { ...DEFAULT_FORCES, ...opts };
  const cx = width / 2;
  const cy = height / 2;
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
    n.vx += (cx - n.x) * center;
    n.vy += (cy - n.y) * center;
    n.vx *= 0.85;
    n.vy *= 0.85;
    n.x += Math.max(-12, Math.min(12, n.vx));
    n.y += Math.max(-12, Math.min(12, n.vy));
    // Keep inside the viewport (soft clamp).
    n.x = Math.max(16, Math.min(width - 16, n.x));
    n.y = Math.max(16, Math.min(height - 16, n.y));
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

export function VaultGraph({
  nodes,
  edges,
  activePath,
  onOpenNode,
}: {
  nodes: VaultGraphNode[];
  edges: VaultGraphEdge[];
  activePath: string | null;
  onOpenNode: (path: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<LayoutNode[]>([]);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const hoverRef = useRef<string | null>(null);
  const sizeRef = useRef({ width: 800, height: 600 });

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

  // Seed the layout when the data or size changes.
  useEffect(() => {
    const { width, height } = sizeRef.current;
    layoutRef.current = seedLayout(nodes, edges, { width, height });
  }, [nodes, edges]);

  // Canvas render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let raf = 0;
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      sizeRef.current = { width: rect.width, height: rect.height };
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const draw = () => {
      const { width, height } = sizeRef.current;
      // Gentle live relaxation (few iterations per frame keeps it calm).
      for (let i = 0; i < 2; i += 1) {
        simulateStep(layoutRef.current, edges, { width, height });
      }
      const ctx = canvas.getContext("2d");
      // Canvas can't resolve CSS variables — read the theme tokens once per
      // frame off the wrapper (cheap; matches the app's theme switching).
      const styles = wrap ? getComputedStyle(wrap) : null;
      const colNode = styles?.getPropertyValue("--vault-graph-node").trim() || "#8a94a6";
      const colActive = styles?.getPropertyValue("--vault-graph-active").trim() || "#5b8def";
      const colLabel = styles?.getPropertyValue("--vault-graph-label").trim() || "#9aa3b2";
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const hover = hoverRef.current;
        const neighbors = hover ? adjacency.get(hover) : null;
        // Edges.
        const byId = new Map(layoutRef.current.map((n) => [n.id, n]));
        for (const e of edges) {
          const a = byId.get(e.src);
          const b = byId.get(e.dst);
          if (!a || !b) continue;
          const dim = hover && e.src !== hover && e.dst !== hover;
          ctx.strokeStyle = dim ? "rgba(128,128,128,0.08)" : "rgba(128,140,160,0.35)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        // Nodes.
        for (const n of layoutRef.current) {
          const dim = hover && n.id !== hover && !neighbors?.has(n.id);
          const r = 3.5 + Math.min(9, Math.sqrt(Math.max(0, n.degree)) * 1.7);
          const isUnresolved = n.unresolved;
          ctx.globalAlpha = dim ? 0.12 : 1;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          ctx.fillStyle = n.id === activePath ? colActive : isUnresolved ? "transparent" : colNode;
          if (isUnresolved) {
            ctx.strokeStyle = colNode;
            ctx.lineWidth = 1.2;
            ctx.stroke();
          } else {
            ctx.fill();
          }
          // Label at larger radii / hover.
          if (!dim && (r > 5 || n.id === hover || n.id === activePath)) {
            ctx.font = "10px sans-serif";
            ctx.fillStyle = colLabel;
            ctx.fillText(n.label.slice(0, 28), n.x + r + 3, n.y + 3);
          }
          ctx.globalAlpha = 1;
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [edges, adjacency, activePath]);

  // Pointer interactions: drag nodes, hover highlight, click to open.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pick = (e: PointerEvent): LayoutNode | null => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      let best: LayoutNode | null = null;
      let bestD = 100;
      for (const n of layoutRef.current) {
        const d = (n.x - x) ** 2 + (n.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      return best;
    };
    const onDown = (e: PointerEvent) => {
      const n = pick(e);
      if (n) {
        const rect = canvas.getBoundingClientRect();
        dragRef.current = { id: n.id, offsetX: n.x - (e.clientX - rect.left), offsetY: n.y - (e.clientY - rect.top) };
        canvas.setPointerCapture(e.pointerId);
      }
    };
    const onMove = (e: PointerEvent) => {
      const n = pick(e);
      hoverRef.current = n?.id ?? null;
      const drag = dragRef.current;
      if (drag) {
        const node = layoutRef.current.find((x) => x.id === drag.id);
        const rect = canvas.getBoundingClientRect();
        if (node) {
          node.x = e.clientX - rect.left + drag.offsetX;
          node.y = e.clientY - rect.top + drag.offsetY;
          node.vx = 0;
          node.vy = 0;
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      canvas.releasePointerCapture?.(e.pointerId);
      // A click (no real drag) opens the node if it's a real note.
      if (drag) {
        const rect = canvas.getBoundingClientRect();
        const node = layoutRef.current.find((x) => x.id === drag.id);
        if (node && !node.unresolved) {
          const moved = Math.abs(node.x - (e.clientX - rect.left + drag.offsetX)) < 3;
          if (moved) onOpenNode(node.id);
        }
      }
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", () => {
      hoverRef.current = null;
    });
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
    };
  }, [onOpenNode]);

  return (
    <div className="vault-graph" ref={wrapRef}>
      <canvas ref={canvasRef} className="vault-graph-canvas" />
      <div className="vault-graph-legend">
        <span>Click: open · Drag: arrange · Hover: focus neighborhood</span>
      </div>
    </div>
  );
}
