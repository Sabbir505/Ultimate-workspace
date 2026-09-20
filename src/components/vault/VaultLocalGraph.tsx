// Local graph — the right-rail counterpart of the global graph view: the
// active note as the center node with its one-hop neighborhood, rendered by
// the SAME canvas force engine as the global graph (<VaultGraph compact />).
// That was a deliberate change from an earlier static SVG ring: the user
// asked for the local graph to behave like the global one, so every
// interaction — hover detail card, node drag with re-settling springs,
// space-drag pan, wheel zoom, click-to-open — comes from the shared
// component; only the data (a 1-hop subgraph) and the chrome (no legend)
// differ.
//
// Subgraph shape: outgoing + backlink mentions merge into one node per id
// (a node seen resolved anywhere wins over an unresolved sighting — a
// backlink source always exists, so it de-dashes a coincidental raw-name
// match). Node ids: an outgoing target resolves to a vault path when it
// exists and falls back to the raw link name when it doesn't — a src
// containing "/" or ending ".md" means "exists on disk", anything else is
// an unresolved link and drawn dashed (the global graph's own convention).

import { useMemo } from "react";
import type { VaultGraphEdge, VaultGraphNode, VaultNoteMeta } from "../../lib/ipc";
import { VaultGraph } from "./VaultGraph";

/** Path-like ids point at real files; bare names are links to notes that
 *  don't exist (the index keeps the raw target as the id in that case). */
const isResolvedId = (id: string) => id.includes("/") || /\.md$/i.test(id);

function labelOf(id: string): string {
  const base = id.split("/").pop() ?? id;
  return base.replace(/\.md$/i, "");
}

/** Deduped one-hop neighborhood as global-graph node/edge arrays, center
 *  excluded from the neighbors, degree computed within the subgraph (the
 *  center node renders larger, like Obsidian's local graph). */
export function localSubgraph(
  meta: VaultNoteMeta,
  activePath?: string,
): { center: string; nodes: VaultGraphNode[]; edges: VaultGraphEdge[] } {
  const center = activePath || meta.path;
  type Neighbor = { id: string; unresolved: boolean };
  const byId = new Map<string, Neighbor>();
  const add = (id: string, unresolved: boolean) => {
    if (!id || id === meta.path || id === center) return; // self-link → the center
    const existing = byId.get(id);
    if (existing) {
      if (!unresolved) existing.unresolved = false;
      return;
    }
    byId.set(id, { id, unresolved });
  };
  for (const m of meta.outgoing) add(m.src, !isResolvedId(m.src));
  for (const m of meta.backlinks) add(m.src, false);

  const nodes: VaultGraphNode[] = [
    { id: center, label: labelOf(center), unresolved: false, degree: byId.size },
    ...[...byId.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((n) => ({ id: n.id, label: labelOf(n.id), unresolved: n.unresolved, degree: 1 })),
  ];
  const edges: VaultGraphEdge[] = [...byId.values()].map((n) => ({ src: center, dst: n.id }));
  return { center, nodes, edges };
}

export function VaultLocalGraph({
  activePath,
  meta,
  onOpen,
  height = 220,
}: {
  activePath: string;
  meta: VaultNoteMeta;
  onOpen: (path: string) => void;
  height?: number;
}): JSX.Element {
  const { center, nodes, edges } = useMemo(() => localSubgraph(meta, activePath), [meta, activePath]);

  if (nodes.length <= 1) {
    return <div className="vault-rail-hint">No links yet — link this note to see its neighborhood.</div>;
  }

  // The wrapper is a flex column so .vault-graph (flex:1) fills the fixed
  // height the rail section allots; the canvas resizes with the rail.
  return (
    <div className="vault-local-graph" style={{ height }} aria-label={`Local graph of ${labelOf(center)}`}>
      <VaultGraph nodes={nodes} edges={edges} activePath={center} onOpenNode={onOpen} compact />
    </div>
  );
}
