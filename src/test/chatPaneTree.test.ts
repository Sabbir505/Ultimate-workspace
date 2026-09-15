// Split-chat pane tree: pure layout rules + the store actions that wrap them
// (open/toggle from the ⋮ menu, drag-and-drop moves, pane close, delete
// cleanup, and the one-session-one-pane uniqueness invariant that keeps each
// chat's live agent turn distinct to its own pane).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  loopSessionStart: vi.fn().mockResolvedValue(null),
  loopSessionAdvance: vi.fn().mockResolvedValue(undefined),
  loopSessionFinish: vi.fn().mockResolvedValue(undefined),
  finishArtifactRuns: vi.fn().mockResolvedValue(0),
  sendChatMessage: vi.fn().mockResolvedValue(undefined),
  sendAgentChatMessage: vi.fn(),
  cancelChatMessage: vi.fn().mockResolvedValue(undefined),
  cancelAgentChatMessage: vi.fn().mockResolvedValue(undefined),
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatSessions: vi.fn().mockResolvedValue([]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  listChatCheckpoints: vi.fn().mockResolvedValue([]),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn(),
  generateChatTitle: vi.fn().mockResolvedValue(null),
  getChatConfig: vi.fn(),
  getChatSessionMetrics: vi.fn().mockResolvedValue(null),
  setChatSessionUnread: vi.fn().mockResolvedValue(undefined),
  setChatSessionStarred: vi.fn(),
  setChatSessionProject: vi.fn(),
  updateChatSessionTitle: vi.fn(),
  updateChatSessionModel: vi.fn(),
  updateChatSessionProvider: vi.fn(),
  updateChatSessionAgent: vi.fn(),
  updateChatSessionWatchMode: vi.fn(),
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  deleteAllChatSessions: vi.fn().mockResolvedValue(0),
  deleteChatMessage: vi.fn(),
  persistPartialChatMessage: vi.fn().mockResolvedValue(undefined),
  setChatApiKey: vi.fn(),
  deleteChatApiKey: vi.fn(),
  readArtifactPreview: vi.fn(),
}));

import {
  MAX_CHAT_PANES,
  chatLeafSessions,
  countChatPanes,
  findPaneForSession,
  insertChatPaneSplit,
  removeChatPane,
  setChatPaneRatio,
} from "../state/chat/paneTree";
import { useChatStore } from "../state/chat";

function session(id: string) {
  return { id, title: id, provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 };
}

const mainLeaf = { kind: "leaf" as const, paneId: "main", sessionId: null };

function seedSessions(...ids: string[]) {
  useChatStore.setState((s) => ({
    sessions: ids.map(session),
    activeChatSessionId: ids[0] ?? null,
    // The active chat holds one message — an empty active chat is guarded
    // against splitting (selectSession would sweep it mid-pin).
    messages: ids.length
      ? [{ id: 1, chatSessionId: ids[0], role: "user", content: "hi" } as never]
      : [],
    messagesSessionId: ids[0] ?? null,
    chatPaneTree: null,
    paneBuffers: {},
    rememberedChatPaneState: null,
    focusedPaneId: null,
    focusedChatSessionId: null,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  seedSessions("s1", "s2", "s3");
});

describe("paneTree pure ops", () => {
  it("inserts the first split against a virtual main leaf, honoring the edge", () => {
    const right = insertChatPaneSplit(null, {
      targetPaneId: "main",
      edge: "right",
      newPaneId: "pane-2",
      sessionId: "s2",
      splitId: "split-1",
    });
    expect(right).not.toBeNull();
    expect(right!.kind).toBe("split");
    // right edge → main leaf first, new pane second, along a row.
    expect((right as any).a).toEqual(mainLeaf);
    expect((right as any).b).toEqual({ kind: "leaf", paneId: "pane-2", sessionId: "s2" });
    expect((right as any).dir).toBe("row");

    const left = insertChatPaneSplit(null, {
      targetPaneId: "main",
      edge: "left",
      newPaneId: "pane-2",
      sessionId: "s2",
      splitId: "split-1",
    });
    expect((left as any).a).toEqual({ kind: "leaf", paneId: "pane-2", sessionId: "s2" });

    const top = insertChatPaneSplit(null, {
      targetPaneId: "main",
      edge: "top",
      newPaneId: "pane-2",
      sessionId: "s2",
      splitId: "split-1",
    });
    expect((top as any).dir).toBe("col");
  });

  it("finds the pane showing a session and counts panes", () => {
    const tree = insertChatPaneSplit(null, {
      targetPaneId: "main",
      edge: "right",
      newPaneId: "pane-2",
      sessionId: "s2",
      splitId: "split-1",
    })!;
    expect(countChatPanes(tree)).toBe(2);
    expect(findPaneForSession(tree, "s2")).toBe("pane-2");
    // The main leaf pins null — the active session resolves through
    // activeChatSessionId, not the tree.
    expect(findPaneForSession(tree, "s1")).toBeNull();
  });

  it("removes a pane by collapsing its parent split", () => {
    let tree = insertChatPaneSplit(null, {
      targetPaneId: "main",
      edge: "right",
      newPaneId: "pane-2",
      sessionId: "s2",
      splitId: "split-1",
    })!;
    tree = insertChatPaneSplit(tree, {
      targetPaneId: "pane-2",
      edge: "bottom",
      newPaneId: "pane-3",
      sessionId: "s3",
      splitId: "split-2",
    })!;
    expect(countChatPanes(tree)).toBe(3);
    const pruned = removeChatPane(tree, "pane-3")!;
    expect(countChatPanes(pruned)).toBe(2);
    // Removing the last pinned pane leaves only main → caller collapses to null.
    const last = removeChatPane(pruned, "pane-2")!;
    expect(last).toEqual(mainLeaf);
  });

  it("clamps ratios when resizing", () => {
    const tree = insertChatPaneSplit(null, {
      targetPaneId: "main",
      edge: "right",
      newPaneId: "pane-2",
      sessionId: "s2",
      splitId: "split-1",
    })!;
    const squeezed = setChatPaneRatio(tree, "split-1", 0.01);
    expect((squeezed as any).ratio).toBe(0.15);
    const blown = setChatPaneRatio(tree, "split-1", 2);
    expect((blown as any).ratio).toBe(0.85);
  });
});

describe("pane store actions", () => {
  it("openChatSplit pins the new pane and falls the main pane back when splitting the ACTIVE chat", async () => {
    // s1 is active; opening s1 in a split must NOT mirror it into two panes.
    await useChatStore.getState().openChatSplit("s1");
    const s = useChatStore.getState();
    expect(s.chatPaneTree).not.toBeNull();
    // The new pane carries the requested session...
    expect(findPaneForSession(s.chatPaneTree, "s1")).not.toBeNull();
    // ...and the main pane moved OFF it (uniqueness invariant).
    expect(s.activeChatSessionId).toBe("s2");
    expect(findPaneForSession(s.chatPaneTree, "s2")).toBeNull();
  });

  it("openChatSplit toggles closed when the session is already pinned", async () => {
    await useChatStore.getState().openChatSplit("s2");
    expect(useChatStore.getState().chatPaneTree).not.toBeNull();
    await useChatStore.getState().openChatSplit("s2");
    expect(useChatStore.getState().chatPaneTree).toBeNull();
    expect(useChatStore.getState().paneBuffers).toEqual({});
  });

  it("refuses to split when only one chat exists", async () => {
    seedSessions("s1");
    await useChatStore.getState().openChatSplit("s1");
    expect(useChatStore.getState().chatPaneTree).toBeNull();
  });

  it("caps the layout at MAX_CHAT_PANES panes", async () => {
    // Build a full tree of 6 panes directly (5 pinned + main).
    const sessions = Array.from({ length: MAX_CHAT_PANES }, (_, i) => `s${i + 1}`);
    useChatStore.setState((s) => ({
      sessions: [...s.sessions, ...sessions.map(session)],
    }));
    let tree = null as null | ReturnType<typeof insertChatPaneSplit>;
    for (let i = 2; i <= MAX_CHAT_PANES; i++) {
      tree = insertChatPaneSplit(tree, {
        targetPaneId: "main",
        edge: "right",
        newPaneId: `pane-${i}`,
        sessionId: `s${i}`,
        splitId: `split-${i}`,
      });
      useChatStore.setState((s) => ({
        chatPaneTree: tree,
        paneBuffers: { ...s.paneBuffers, [`pane-${i}`]: { sessionId: `s${i}`, messages: [], hasMoreHistory: false } },
      }));
    }
    expect(countChatPanes(useChatStore.getState().chatPaneTree)).toBe(MAX_CHAT_PANES);
    // A 7th pane (a NEW session, not a move) is refused.
    useChatStore.setState((s) => ({
      sessions: [...s.sessions, session("s7")],
    }));
    const before = useChatStore.getState().chatPaneTree;
    await useChatStore.getState().openChatSplit("s7");
    expect(useChatStore.getState().chatPaneTree).toBe(before);
  });

  it("moveChatSessionToPane relocates a pinned session and collapses its old pane", async () => {
    // pane-A: s2 on the right; pane-3: s3 under pane-A. Pane ids are handed
    // out by a module counter, so derive them from the tree instead of
    // hardcoding.
    await useChatStore.getState().openChatSplit("s2");
    const paneA = findPaneForSession(useChatStore.getState().chatPaneTree, "s2")!;
    // Manual id (never handed out by the module counter) for the third pane.
    useChatStore.setState((s) => ({
      chatPaneTree: insertChatPaneSplit(s.chatPaneTree, {
        targetPaneId: paneA,
        edge: "bottom",
        newPaneId: "pane-manual-3",
        sessionId: "s3",
        splitId: "split-2",
      }),
      paneBuffers: {
        ...s.paneBuffers,
        "pane-manual-3": { sessionId: "s3", messages: [], hasMoreHistory: false },
      },
    }));
    expect(useChatStore.getState().paneBuffers[paneA]).toBeDefined();
    expect(useChatStore.getState().paneBuffers["pane-manual-3"]).toBeDefined();

    // Drag s3 onto the LEFT edge of the main pane: it leaves pane-manual-3
    // (which collapses) and reappears left of main.
    await useChatStore.getState().moveChatSessionToPane("s3", "main", "left");
    const s = useChatStore.getState();
    expect(findPaneForSession(s.chatPaneTree, "s3")).not.toBe("pane-manual-3");
    expect(s.paneBuffers["pane-manual-3"]).toBeUndefined();
    expect(s.paneBuffers[paneA]).toBeDefined();
    // 3 panes still: main + pane-A (s2) + the relocated pane (s3).
    expect(countChatPanes(s.chatPaneTree)).toBe(3);
    // And s3 now sits BEFORE (left of) the main pane in visual order.
    const visualOrder: string[] = [];
    const walk = (n: NonNullable<typeof s.chatPaneTree> | null) => {
      if (!n) return;
      if (n.kind === "leaf") {
        visualOrder.push(n.paneId);
        return;
      }
      walk(n.a);
      walk(n.b);
    };
    walk(s.chatPaneTree);
    const s3Pane = findPaneForSession(s.chatPaneTree, "s3")!;
    expect(visualOrder.indexOf(s3Pane)).toBeLessThan(visualOrder.indexOf("main"));
    expect(visualOrder.indexOf("main")).toBeLessThan(visualOrder.indexOf(paneA));
  });

  it("selectSession focuses the pinned pane instead of duplicating the session into main", async () => {
    await useChatStore.getState().openChatSplit("s2");
    const paneId = findPaneForSession(useChatStore.getState().chatPaneTree, "s2");
    expect(paneId).not.toBeNull();
    await useChatStore.getState().selectSession("s2");
    const s = useChatStore.getState();
    // Active didn't move (main keeps its chat)...
    expect(s.activeChatSessionId).not.toBe("s2");
    // ...and the shared chrome pin follows the pane's chat.
    expect(s.focusedPaneId).toBe(paneId);
    expect(s.focusedChatSessionId).toBe("s2");
  });

  it("closeChatPane returns to the tree-less layout when the last pinned pane closes", async () => {
    await useChatStore.getState().openChatSplit("s2");
    const paneId = findPaneForSession(useChatStore.getState().chatPaneTree, "s2")!;
    useChatStore.getState().closeChatPane(paneId);
    const s = useChatStore.getState();
    expect(s.chatPaneTree).toBeNull();
    expect(s.paneBuffers).toEqual({});
    expect(s.focusedPaneId).toBeNull();
  });

  it("closing the MAIN pane promotes the first remaining pane to follower", async () => {
    await useChatStore.getState().openChatSplit("s2");
    // tree: [main | pane-A(s2)]. Close MAIN via its own header ✕.
    useChatStore.getState().closeChatPane("main");
    const s = useChatStore.getState();
    // Back to the tree-less single view, whose active chat is the promoted
    // pane's session; its pane buffer migrated off.
    expect(s.chatPaneTree).toBeNull();
    expect(s.activeChatSessionId).toBe("s2");
    expect(s.paneBuffers).toEqual({});
  });

  it("closing main in a deeper tree promotes only the FIRST leaf", async () => {
    await useChatStore.getState().openChatSplit("s2");
    const paneA = findPaneForSession(useChatStore.getState().chatPaneTree, "s2")!;
    useChatStore.setState((s) => ({
      chatPaneTree: insertChatPaneSplit(s.chatPaneTree, {
        targetPaneId: paneA,
        edge: "bottom",
        newPaneId: "pane-manual-3",
        sessionId: "s3",
        splitId: "split-manual-2",
      }),
      paneBuffers: {
        ...s.paneBuffers,
        "pane-manual-3": { sessionId: "s3", messages: [], hasMoreHistory: false },
      },
    }));
    useChatStore.getState().closeChatPane("main");
    const s = useChatStore.getState();
    // pane-A (visual first) becomes the follower; pane-manual-3 stays pinned.
    expect(s.chatPaneTree).not.toBeNull();
    expect(s.activeChatSessionId).toBe("s2");
    // The promoted leaf carries NO pinned session (it's the new main)…
    const first = chatLeafSessions(s.chatPaneTree);
    expect(first.map((l) => l.sessionId)).toEqual(["s3"]);
    // …and its buffer migrated to the main fields (dropped from paneBuffers).
    expect(s.paneBuffers[paneA]).toBeUndefined();
    expect(s.paneBuffers["pane-manual-3"]).toBeDefined();
  });

  it("clicking a non-pane chat collapses the panes and remembers the layout", async () => {
    await useChatStore.getState().openChatSplit("s2");
    const layout = useChatStore.getState().chatPaneTree;
    await useChatStore.getState().selectSession("s3");
    const s = useChatStore.getState();
    // Single view on the clicked chat; the pane layout is parked in memory.
    expect(s.chatPaneTree).toBeNull();
    expect(s.activeChatSessionId).toBe("s3");
    expect(s.rememberedChatPaneState).not.toBeNull();
    expect(s.rememberedChatPaneState!.tree).toBe(layout);
    expect(s.rememberedChatPaneState!.activeSessionId).toBe("s1");
  });

  it("clicking a pane chat restores the remembered layout and focuses its pane", async () => {
    await useChatStore.getState().openChatSplit("s2");
    const layout = useChatStore.getState().chatPaneTree;
    await useChatStore.getState().selectSession("s3"); // collapse + remember
    await useChatStore.getState().selectSession("s2"); // restore
    const s = useChatStore.getState();
    expect(s.chatPaneTree).toBe(layout);
    expect(findPaneForSession(s.chatPaneTree, "s2")).not.toBeNull();
    // The main pane went back to the chat it showed before the collapse…
    expect(s.activeChatSessionId).toBe("s1");
    // …the memory is consumed, and the clicked chat's pane has focus.
    expect(s.rememberedChatPaneState).toBeNull();
    expect(s.focusedChatSessionId).toBe("s2");
  });

  it("explicitly closing all panes discards the memory (no accidental restore)", async () => {
    await useChatStore.getState().openChatSplit("s2");
    await useChatStore.getState().selectSession("s3"); // collapse + remember
    useChatStore.getState().closeAllChatPanes();
    expect(useChatStore.getState().rememberedChatPaneState).toBeNull();
    await useChatStore.getState().selectSession("s2");
    const s = useChatStore.getState();
    // Plain select — no pane layout came back.
    expect(s.chatPaneTree).toBeNull();
    expect(s.activeChatSessionId).toBe("s2");
  });

  it("splitting the active chat with other panes open ignores pinned fallbacks", async () => {
    // Layout: [main(s1) | pane-A(s2)]. Opening the ACTIVE chat (s1) again
    // must not fall back to the pinned s2 — that redirect would leave s1
    // active and mirror it into the new pane.
    await useChatStore.getState().openChatSplit("s2");
    const before = useChatStore.getState().chatPaneTree;
    await useChatStore.getState().openChatSplit("s1");
    const s = useChatStore.getState();
    // No candidate exists (s2 is pinned, no other chats) → refused, layout
    // unchanged, and crucially s1 is NOT duplicated into a new pane.
    expect(s.chatPaneTree).toBe(before);
    expect(s.activeChatSessionId).toBe("s1");
  });

  // LAST: deleteChat tombstones the session id for the whole app run (the
  // deletedSessions Map has no test reset), so any test touching "s2" after
  // this one would silently no-op.
  it("deleteChat closes the pane showing the deleted session", async () => {
    await useChatStore.getState().openChatSplit("s2");
    const paneId = findPaneForSession(useChatStore.getState().chatPaneTree, "s2");
    await useChatStore.getState().deleteChat("s2");
    const s = useChatStore.getState();
    expect(s.chatPaneTree).toBeNull();
    expect(s.paneBuffers[paneId!]).toBeUndefined();
  });
});
