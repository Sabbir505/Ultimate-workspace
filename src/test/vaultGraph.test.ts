// Vault graph layout — deterministic force simulation properties:
// ring-seeded starts reproduce exactly, repulsion spreads nodes apart,
// springs pull linked pairs toward a bounded distance, and the soft clamp
// keeps every node inside the viewport.
import { describe, expect, it } from "vitest";
import { seedLayout, simulateStep, type LayoutNode } from "../components/vault/VaultGraph";
import type { VaultGraphEdge, VaultGraphNode } from "../lib/ipc";

const W = 800;
const H = 600;

function ringGraph(n: number): { nodes: VaultGraphNode[]; edges: VaultGraphEdge[] } {
  const nodes: VaultGraphNode[] = Array.from({ length: n }, (_, i) => ({
    id: `n${i}.md`,
    label: `n${i}`,
    unresolved: false,
    degree: 2,
  }));
  const edges: VaultGraphEdge[] = [];
  for (let i = 0; i < n; i += 1) {
    edges.push({ src: `n${i}.md`, dst: `n${(i + 1) % n}.md` });
  }
  return { nodes, edges };
}

describe("seedLayout", () => {
  it("is deterministic for the same input", () => {
    const { nodes, edges } = ringGraph(12);
    const a = seedLayout(nodes, edges, { width: W, height: H, iterations: 100 });
    const b = seedLayout(nodes, edges, { width: W, height: H, iterations: 100 });
    expect(a.map((n) => [n.x, n.y])).toEqual(b.map((n) => [n.x, n.y]));
  });

  it("spreads nodes apart (no overlaps) after seeding", () => {
    const { nodes, edges } = ringGraph(20);
    const layout = seedLayout(nodes, edges, { width: W, height: H, iterations: 240 });
    let minDist = Infinity;
    for (let i = 0; i < layout.length; i += 1) {
      for (let j = i + 1; j < layout.length; j += 1) {
        const d = Math.hypot(layout[i].x - layout[j].x, layout[i].y - layout[j].y);
        if (d < minDist) minDist = d;
      }
    }
    expect(minDist).toBeGreaterThan(20);
  });

  it("keeps every node inside the viewport", () => {
    const { nodes, edges } = ringGraph(30);
    const layout = seedLayout(nodes, edges, { width: W, height: H, iterations: 100 });
    for (const n of layout) {
      expect(n.x).toBeGreaterThanOrEqual(16);
      expect(n.x).toBeLessThanOrEqual(W - 16);
      expect(n.y).toBeGreaterThanOrEqual(16);
      expect(n.y).toBeLessThanOrEqual(H - 16);
    }
  });
});

describe("simulateStep", () => {
  it("shortens edge lengths over iterations (spring force)", () => {
    const a: LayoutNode = { id: "a", label: "a", unresolved: false, degree: 1, x: 100, y: 300, vx: 0, vy: 0 };
    const b: LayoutNode = { id: "b", label: "b", unresolved: false, degree: 1, x: 700, y: 300, vx: 0, vy: 0 };
    const edges = [{ src: "a", dst: "b" }];
    const before = Math.hypot(b.x - a.x, b.y - a.y);
    for (let i = 0; i < 60; i += 1) {
      simulateStep([a, b], edges, { width: W, height: H });
    }
    const after = Math.hypot(b.x - a.x, b.y - a.y);
    expect(after).toBeLessThan(before);
    // And it settles near the ideal length, not collapsed to 0.
    expect(after).toBeGreaterThan(20);
  });

  it("damps velocities so the layout converges", () => {
    const { nodes, edges } = ringGraph(10);
    const layout = seedLayout(nodes, edges, { width: W, height: H, iterations: 400 });
    // After a full seed the kinetic energy is low: per-step movement is a
    // small fraction of the viewport (damped, clamped integration).
    let energy = 0;
    for (const n of layout) {
      energy += Math.abs(n.vx) + Math.abs(n.vy);
    }
    expect(energy).toBeLessThan(10);
  });
});
