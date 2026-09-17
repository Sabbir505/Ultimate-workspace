// Chat pane tree — the layout model behind split chat views.
//
// Up to MAX_CHAT_PANES chats can be open at once, arranged in a binary split
// tree (each pane can be split left/right or top/bottom, recursively — the
// same model as editor groups). The tree holds LAYOUT ONLY: the primary
// "main" leaf follows the global active session (like the unsplit view), and
// every pinned leaf names one concrete session. A session may appear in AT
// MOST ONE pane — enforcing that is what keeps each chat's live agent turn
// distinct to its own pane instead of mirroring into its neighbour.
//
// Everything here is PURE (tree in → tree out) so the layout rules are unit
// testable without a store; the store actions in slices/panesSlice.ts wrap
// these with buffer loads and toast surfacing.

/** Hard cap on simultaneously open chat panes (matches the terminal pane
 *  grid's MAX_PANES so the two split systems read consistently). */
export const MAX_CHAT_PANES = 6;

/** The primary pane: follows activeChatSessionId, owns the flat `messages`
 *  buffer. Never closable; always present in (or implied by) the tree. */
export const CHAT_MAIN_PANE_ID = "main";

/** One drop edge of a pane — where a dragged session lands relative to the
 *  pane it was dropped ON. */
export type ChatPaneEdge = "left" | "right" | "top" | "bottom";

export interface ChatPaneLeaf {
  kind: "leaf";
  paneId: string;
  /** null ONLY on the main leaf (follows the active session). Pinned panes
   *  always carry a concrete session id. */
  sessionId: string | null;
}

export interface ChatPaneSplit {
  kind: "split";
  /** Stable id so the resizer can write a ratio back into THIS node. */
  id: string;
  /** row = children side by side (left/right), col = stacked (top/bottom). */
  dir: "row" | "col";
  /** Share of this split's space given to child `a` (0..1, clamped). */
  ratio: number;
  a: ChatPaneNode;
  b: ChatPaneNode;
}

export type ChatPaneNode = ChatPaneLeaf | ChatPaneSplit;

let paneCounter = 1; // "main" is pane 1; pinned panes count from 2
let splitCounter = 0;

export function nextChatPaneId(): string {
  paneCounter += 1;
  return `pane-${paneCounter}`;
}

export function nextChatSplitId(): string {
  splitCounter += 1;
  return `split-${splitCounter}`;
}

export function countChatPanes(node: ChatPaneNode | null): number {
  if (!node) return 1; // tree-less state still renders the main pane
  if (node.kind === "leaf") return 1;
  return countChatPanes(node.a) + countChatPanes(node.b);
}

export function findChatLeaf(
  node: ChatPaneNode | null,
  paneId: string,
): ChatPaneLeaf | null {
  if (!node) return paneId === CHAT_MAIN_PANE_ID ? MAIN_LEAF : null;
  if (node.kind === "leaf") return node.paneId === paneId ? node : null;
  return findChatLeaf(node.a, paneId) ?? findChatLeaf(node.b, paneId);
}

const MAIN_LEAF: ChatPaneLeaf = { kind: "leaf", paneId: CHAT_MAIN_PANE_ID, sessionId: null };

/** Fresh main-pane leaf for callers rendering the tree-less layout through
 *  the same pane renderer (the main pane always follows the active session). */
export function mainPaneLeaf(): ChatPaneLeaf {
  return { ...MAIN_LEAF };
}

/** Which pane displays `sessionId` — pinned pane id, or CHAT_MAIN_PANE_ID
 *  when it's the main pane's (active) session. Null when displayed nowhere. */
export function findPaneForSession(
  node: ChatPaneNode | null,
  sessionId: string,
): string | null {
  if (!node) return null;
  if (node.kind === "leaf") return node.sessionId === sessionId ? node.paneId : null;
  return findPaneForSession(node.a, sessionId) ?? findPaneForSession(node.b, sessionId);
}

/** Every pinned leaf, in visual order (left→right / top→bottom). */
export function chatLeafSessions(
  node: ChatPaneNode | null,
): Array<{ paneId: string; sessionId: string }> {
  if (!node) return [];
  if (node.kind === "leaf") {
    return node.sessionId ? [{ paneId: node.paneId, sessionId: node.sessionId }] : [];
  }
  return [...chatLeafSessions(node.a), ...chatLeafSessions(node.b)];
}

/** Every leaf's pane id in visual order, main included (pet homes, focus
 *  bookkeeping, per-pane chrome). */
export function chatPaneIds(node: ChatPaneNode | null): string[] {
  if (!node) return [CHAT_MAIN_PANE_ID];
  if (node.kind === "leaf") return [node.paneId];
  return [...chatPaneIds(node.a), ...chatPaneIds(node.b)];
}

/** The first leaf in visual order — the promotion candidate when the main
 *  pane closes. */
export function firstChatLeaf(node: ChatPaneNode): ChatPaneLeaf {
  return node.kind === "leaf" ? node : firstChatLeaf(node.a);
}

/** Clear one leaf's pinned session (turning it into the follower/main leaf). */
export function clearLeafSession(node: ChatPaneNode, paneId: string): ChatPaneNode {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? { ...node, sessionId: null } : node;
  }
  const a = clearLeafSession(node.a, paneId);
  if (a !== node.a) return { ...node, a };
  const b = clearLeafSession(node.b, paneId);
  if (b !== node.b) return { ...node, b };
  return node;
}

/** Map an drop edge onto a split geometry: left/top insert BEFORE the target
 *  leaf, right/top... after — and left/right split along a row, top/bottom
 *  along a column. */
export function edgeToSplit(edge: ChatPaneEdge): {
  dir: "row" | "col";
  side: "before" | "after";
} {
  switch (edge) {
    case "left":
      return { dir: "row", side: "before" };
    case "right":
      return { dir: "row", side: "after" };
    case "top":
      return { dir: "col", side: "before" };
    case "bottom":
      return { dir: "col", side: "after" };
  }
}

/** Split the leaf `targetPaneId` in `edge` direction, inserting a new pinned
 *  leaf carrying `sessionId` on that side. Pass a null tree to create the
 *  first split against a virtual main leaf. Returns null when the target
 *  pane doesn't exist in the tree. */
export function insertChatPaneSplit(
  node: ChatPaneNode | null,
  opts: {
    targetPaneId: string;
    edge: ChatPaneEdge;
    newPaneId: string;
    sessionId: string;
    splitId: string;
  },
): ChatPaneNode | null {
  const { dir, side } = edgeToSplit(opts.edge);

  const build = (existing: ChatPaneLeaf, incoming: ChatPaneLeaf): ChatPaneSplit => ({
    kind: "split",
    id: opts.splitId,
    dir,
    ratio: 0.5,
    // "before" (left/top) puts the incoming pane FIRST; "after" second.
    a: side === "before" ? incoming : existing,
    b: side === "before" ? existing : incoming,
  });

  if (!node) {
    if (opts.targetPaneId !== CHAT_MAIN_PANE_ID) return null;
    return build(MAIN_LEAF, { kind: "leaf", paneId: opts.newPaneId, sessionId: opts.sessionId });
  }

  const walk = (cur: ChatPaneNode): ChatPaneNode | null => {
    if (cur.kind === "leaf") {
      if (cur.paneId !== opts.targetPaneId) return null;
      return build(cur, { kind: "leaf", paneId: opts.newPaneId, sessionId: opts.sessionId });
    }
    const a = walk(cur.a);
    if (a) return { ...cur, a };
    const b = walk(cur.b);
    if (b) return { ...cur, b };
    return null;
  };
  return walk(node);
}

/** Collapse the split that hosts `paneId`, promoting its sibling subtree.
 *  Returns the pruned tree, or null when the pane isn't found. The main pane
 *  can never be removed (callers guard). */
export function removeChatPane(
  node: ChatPaneNode,
  paneId: string,
): ChatPaneNode | null {
  if (node.kind !== "split") return null;
  if (node.a.kind === "leaf" && node.a.paneId === paneId) return node.b;
  if (node.b.kind === "leaf" && node.b.paneId === paneId) return node.a;
  const a = removeChatPaneSafe(node.a, paneId);
  if (a.removed) return { ...node, a: a.node };
  const b = removeChatPaneSafe(node.b, paneId);
  if (b.removed) return { ...node, b: b.node };
  return null;
}

function removeChatPaneSafe(
  node: ChatPaneNode,
  paneId: string,
): { node: ChatPaneNode; removed: boolean } {
  const next = removeChatPane(node, paneId);
  return next ? { node: next, removed: true } : { node, removed: false };
}

export interface RemoveChatPaneResult {
  /** The pruned tree. Null when only the (promoted) main leaf remains — the
   *  caller drops the tree and returns to the tree-less layout. */
  tree: ChatPaneNode | null;
  /** When the MAIN leaf was closed: the pinned pane promoted to follower
   *  (its session moves to activeChatSessionId, its buffer migrates to the
   *  main buffer). Null when a pinned pane was closed. */
  promotedPaneId: string | null;
  promotedSessionId: string | null;
}

/** Remove any pane — pinned OR the main one. Closing a pinned pane simply
 *  collapses its split; closing the MAIN leaf promotes the first remaining
 *  leaf to follower (sessionId → null) so there is always exactly one main. */
export function removeChatPanePromote(
  node: ChatPaneNode,
  paneId: string,
): RemoveChatPaneResult | null {
  const target = findChatLeaf(node, paneId);
  if (!target) return null;
  const closingMain = target.sessionId == null;
  const pruned = removeChatPane(node, paneId);
  if (!pruned) return null;

  if (!closingMain) {
    return {
      tree: pruned.kind === "leaf" && pruned.sessionId == null ? null : pruned,
      promotedPaneId: null,
      promotedSessionId: null,
    };
  }
  // Main closed. One leaf left → it IS the new tree-less main.
  if (pruned.kind === "leaf") {
    return { tree: null, promotedPaneId: pruned.paneId, promotedSessionId: pruned.sessionId };
  }
  const first = firstChatLeaf(pruned);
  return {
    tree: clearLeafSession(pruned, first.paneId),
    promotedPaneId: first.paneId,
    promotedSessionId: first.sessionId,
  };
}

/** Write a new ratio onto the split node with `splitId`. Returns the same
 *  tree reference when the node doesn't exist (no-op). */
export function setChatPaneRatio(
  node: ChatPaneNode,
  splitId: string,
  ratio: number,
): ChatPaneNode {
  if (node.kind === "leaf") return node;
  const clamped = Math.min(0.85, Math.max(0.15, ratio));
  if (node.id === splitId) return { ...node, ratio: clamped };
  const a = setChatPaneRatio(node.a, splitId, ratio);
  if (a !== node.a) return { ...node, a };
  const b = setChatPaneRatio(node.b, splitId, ratio);
  if (b !== node.b) return { ...node, b };
  return node;
}
