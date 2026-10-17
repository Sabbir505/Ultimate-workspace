// Chat-list grouping (Needs input / Working / Completed) plus spawn-tree
// nesting (SESSION_MESH_DESIGN_ARCHITECTURE.md §6). Pure logic shared by the
// main Sidebar's Chat History inbox and the Projects panel's per-project chat
// list, so both surfaces section + nest identically.
//
// Rules:
//  - A session is placed by its OWN state: needs input > working > completed.
//  - A session an agent spawned (`origin` = `spawned_by:<parentId>`) is NOT a
//    top-level row: it is nested under its parent, wherever the parent lands.
//    A sidechat (`origin` = `side_of:<id>`) nests the same way — an
//    independent sub-thread of the chat it was opened from. Forks
//    (`fork_of:<id>`) are independent conversations and stay top-level.
//  - A parent section reflects its whole subtree: a child that needs input or
//    is still working lifts the parent's group accordingly.
//  - A row whose ENTIRE subtree is done reads as "completed" (rendered bold),
//    even when it stays nested in a working parent's group instead of moving
//    down to the Completed section.

export type ChatGroupKey = "needsInput" | "working" | "completed";

export interface ChatGroupSectionDef {
  key: ChatGroupKey;
  label: string;
}

/** Section order + labels, shared by both sidebars. */
export const CHAT_GROUP_SECTIONS: readonly ChatGroupSectionDef[] = [
  { key: "needsInput", label: "Needs input" },
  { key: "working", label: "Working" },
  { key: "completed", label: "Completed" },
];

/** The minimum a session must expose to be grouped. */
export interface SessionGroupInput {
  id: string;
  /** List parent resolved from `origin` (`spawned_by:`/`side_of:`);
   *  null/undefined = top level. */
  parentId?: string | null;
  starred?: boolean;
  lastActiveAt: number;
}

export interface ChatGroupRow<T> {
  session: T;
  /** Rendered indented under its parent (spawn-tree child). */
  nested: boolean;
  /** True for a nested row that is the LAST child of its parent — its
   *  connector spine stops at its own elbow instead of running on to a
   *  following sibling. */
  lastChild: boolean;
  /** 0 for a top-level row, 1 for a direct child, deeper for grandchildren. */
  depth: number;
  /** This row's OWN state. */
  needsInput: boolean;
  working: boolean;
  /** The row's whole subtree is done — rendered bold. */
  completed: boolean;
  /** Id of the top-level ancestor this row hangs from. */
  rootId: string;
}

export interface ChatGroupSection<T> {
  key: ChatGroupKey;
  label: string;
  /** Flat, pre-order: each root immediately followed by its descendants. */
  rows: ChatGroupRow<T>[];
}

export interface ChatGroups<T> {
  /** Non-empty sections in Needs input → Working → Completed order. */
  sections: ChatGroupSection<T>[];
  /** Total top-level rows across all sections (before any paging cap). */
  totalRoots: number;
  /** How many top-level rows are actually shown. */
  shownRoots: number;
  /** True when `maxRoots` hid some roots — drives "Show more". */
  hasMore: boolean;
}

/** Parent id encoded in a session's `origin` column, or null.
 *  `spawned_by:<chatId>` = an agent spawned the session (the mesh depth walk
 *  reads this same spelling). `side_of:<chatId>` = a manual sidechat of that
 *  chat — an independent sub-thread that nests under its source in the list.
 *  `fork_of:<id>` is deliberately ignored — a fork is an independent chat,
 *  not a child of its source. */
export function nestedParentId(origin: string | null | undefined): string | null {
  if (!origin) return null;
  for (const prefix of ["spawned_by:", "side_of:"]) {
    if (origin.startsWith(prefix)) {
      const id = origin.slice(prefix.length).trim();
      return id.length > 0 ? id : null;
    }
  }
  return null;
}

/** Source chat id when `origin` marks a manual sidechat (`side_of:<chatId>`),
 *  null for everything else (spawns, forks, human chats). Unlike
 *  `nestedParentId` this never match a spawn: the sidechat pane uses it to
 *  explain the hidden context handoff — the source chat's recent history
 *  rides as model context but its rows are not shown in the sidechat. */
export function sidechatSourceId(origin: string | null | undefined): string | null {
  if (!origin || !origin.startsWith("side_of:")) return null;
  const id = origin.slice("side_of:".length).trim();
  return id.length > 0 ? id : null;
}

const RANK: Record<ChatGroupKey, number> = {
  needsInput: 2,
  working: 1,
  completed: 0,
};

export function groupChatSessions<T extends SessionGroupInput>(
  sessions: readonly T[],
  opts: {
    isWorking: (session: T) => boolean;
    needsInput: (session: T) => boolean;
    /** Keep only the first N top-level rows (in section order). Descendants
     *  always travel with their root. Undefined = show everything. */
    maxRoots?: number;
  },
): ChatGroups<T> {
  const byId = new Map<string, T>();
  for (const s of sessions) byId.set(s.id, s);

  // parentId -> children, in the incoming list order (already sorted by the
  // caller). A parent that isn't present in this list can't nest its child,
  // so such a child stays top-level.
  const childrenByParent = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of sessions) {
    const pid = s.parentId ?? null;
    if (pid && pid !== s.id && byId.has(pid)) {
      const list = childrenByParent.get(pid);
      if (list) list.push(s);
      else childrenByParent.set(pid, [s]);
    } else {
      roots.push(s);
    }
  }

  // Safety net for a parent cycle (a spawns b spawns a): neither is reachable
  // from a real root, so both would vanish. Promote any unreachable session to
  // a root so it still shows.
  const reachable = new Set<string>();
  const markReachable = (node: T) => {
    if (reachable.has(node.id)) return;
    reachable.add(node.id);
    for (const child of childrenByParent.get(node.id) ?? []) markReachable(child);
  };
  for (const r of roots) markReachable(r);
  for (const s of sessions) {
    if (!reachable.has(s.id)) roots.push(s);
  }

  const ownStatusCache = new Map<string, ChatGroupKey>();
  const ownStatus = (s: T): ChatGroupKey => {
    const cached = ownStatusCache.get(s.id);
    if (cached) return cached;
    const status: ChatGroupKey = opts.needsInput(s)
      ? "needsInput"
      : opts.isWorking(s)
        ? "working"
        : "completed";
    ownStatusCache.set(s.id, status);
    return status;
  };

  // Effective status = the strongest status anywhere in the row's subtree.
  const effectiveCache = new Map<string, ChatGroupKey>();
  const effectiveGuard = new Set<string>();
  const effective = (s: T): ChatGroupKey => {
    const cached = effectiveCache.get(s.id);
    if (cached) return cached;
    if (effectiveGuard.has(s.id)) return ownStatus(s); // cycle — stop descending
    effectiveGuard.add(s.id);
    let best = ownStatus(s);
    for (const child of childrenByParent.get(s.id) ?? []) {
      const childStatus = effective(child);
      if (RANK[childStatus] > RANK[best]) best = childStatus;
    }
    effectiveGuard.delete(s.id);
    effectiveCache.set(s.id, best);
    return best;
  };

  const rootsBySection: Record<ChatGroupKey, T[]> = {
    needsInput: [],
    working: [],
    completed: [],
  };
  for (const root of roots) rootsBySection[effective(root)].push(root);
  for (const def of CHAT_GROUP_SECTIONS) {
    rootsBySection[def.key].sort(
      (a, b) =>
        Number(b.starred ?? false) - Number(a.starred ?? false) ||
        b.lastActiveAt - a.lastActiveAt,
    );
  }

  const orderedRoots = CHAT_GROUP_SECTIONS.flatMap((def) => rootsBySection[def.key]);
  const totalRoots = orderedRoots.length;
  const shownRoots =
    opts.maxRoots == null
      ? totalRoots
      : Math.min(totalRoots, Math.max(0, opts.maxRoots));
  const shown = new Set(orderedRoots.slice(0, shownRoots).map((r) => r.id));

  const walked = new Set<string>();
  const visit = (
    node: T,
    depth: number,
    rootId: string,
    rows: ChatGroupRow<T>[],
    isLastChild: boolean,
  ) => {
    if (walked.has(node.id)) return;
    walked.add(node.id);
    const own = ownStatus(node);
    rows.push({
      session: node,
      nested: depth > 0,
      lastChild: depth > 0 && isLastChild,
      depth,
      needsInput: own === "needsInput",
      working: own === "working",
      completed: effective(node) === "completed",
      rootId,
    });
    const children = childrenByParent.get(node.id) ?? [];
    children.forEach((child, i) => {
      visit(child, depth + 1, rootId, rows, i === children.length - 1);
    });
  };

  const sections: ChatGroupSection<T>[] = [];
  for (const def of CHAT_GROUP_SECTIONS) {
    const rows: ChatGroupRow<T>[] = [];
    for (const root of rootsBySection[def.key]) {
      if (shown.has(root.id)) visit(root, 0, root.id, rows, true);
    }
    if (rows.length > 0) sections.push({ key: def.key, label: def.label, rows });
  }

  return { sections, totalRoots, shownRoots, hasMore: totalRoots > shownRoots };
}
