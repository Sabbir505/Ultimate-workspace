// Panes slice: the split-chat pane tree actions — open/toggle panes from the
// session ⋮ menu, drag-and-drop moves onto pane edges, per-split resizing,
// pane close, and the shared-chrome focus pin. Pure layout rules live in
// ../paneTree.ts (unit tested); this slice wraps them with buffer loads,
// focus bookkeeping, and toast surfacing.
//
// INVARIANT: a session is displayed in at most ONE pane. The main pane
// follows activeChatSessionId; a pinned pane's session therefore never
// equals the active one. This is what keeps each chat's live agent turn
// distinct to its own pane (session-keyed `streaming` renders in exactly
// one view) — openChatSplit/moveChatSessionToPane both enforce it by
// falling the main pane back to another chat when the dragged/opened
// session IS the active one.
import { useUiStore } from "../../ui";
import {
  CHAT_MAIN_PANE_ID,
  MAX_CHAT_PANES,
  type ChatPaneEdge,
  countChatPanes,
  findChatLeaf,
  findPaneForSession,
  insertChatPaneSplit,
  nextChatPaneId,
  nextChatSplitId,
  removeChatPane,
  removeChatPanePromote,
  setChatPaneRatio as applyPaneRatio,
} from "../paneTree";
import { isDeletedSession, omitKey } from "../moduleState";
import type { ChatPaneNode } from "../paneTree";
import type { ChatStoreGet, ChatStoreSet } from "../types";

export function createPanesSlice(set: ChatStoreSet, get: ChatStoreGet) {
  // The pane a menu action splits from: the focused pane when it still
  // exists in the tree, else the main pane (the only pane when tree-less).
  const resolvePaneTarget = (): string => {
    const s = get();
    if (!s.focusedPaneId) return CHAT_MAIN_PANE_ID;
    if (s.chatPaneTree && findChatLeaf(s.chatPaneTree, s.focusedPaneId)) {
      return s.focusedPaneId;
    }
    return CHAT_MAIN_PANE_ID;
  };

  const toast = (message: string) => useUiStore.getState().pushToast("info", message);

  /** Shared engine behind openChatSplit (⋮ menu) and moveChatSessionToPane
   *  (drag-and-drop): put `chatSessionId` on one edge of `targetPaneId`,
   *  creating the first split when the tree doesn't exist yet. Returns
   *  whether the layout changed. */
  const openSessionOnPaneEdge = async (
    chatSessionId: string,
    targetPaneId: string,
    edge: ChatPaneEdge,
  ): Promise<boolean> => {
    const st = get();
    // Stale source (row deleted mid-drag, tombstoned id): silently no-op.
    if (isDeletedSession(chatSessionId) || !st.sessions.some((x) => x.id === chatSessionId)) {
      return false;
    }
    const tree = st.chatPaneTree;
    const shownInPinned = findPaneForSession(tree, chatSessionId);
    const isActive = st.activeChatSessionId === chatSessionId;
    if (shownInPinned && shownInPinned === targetPaneId) return false; // dropped on its own pane

    // Capacity: a MOVE frees its old pane first, so it doesn't consume a slot.
    if (tree && countChatPanes(tree) >= MAX_CHAT_PANES && !shownInPinned && !isActive) {
      toast(`Up to ${MAX_CHAT_PANES} chats can be open at once`);
      return false;
    }

    let workTree: ChatPaneNode | null = tree;
    let removedPaneId: string | null = null;
    if (shownInPinned && workTree) {
      // MOVE semantics: collapse the pane currently holding the session, then
      // re-insert it at the drop edge (VSCode editor-group behavior).
      const pruned = removeChatPane(workTree, shownInPinned);
      if (pruned) {
        workTree = pruned.kind === "leaf" && pruned.paneId === CHAT_MAIN_PANE_ID ? null : pruned;
        removedPaneId = shownInPinned;
      }
    }

    if (isActive) {
      // Buffer-ownership shape (audit H1): the active chat counts as empty
      // only when the main buffer genuinely holds ITS rows. An empty active
      // chat must NOT be pinned — selectSession's fallback below would sweep
      // it (empty chats are deleted on switch) and the new pane would hold a
      // tombstoned session whose sends silently no-op.
      const activeEmpty =
        st.messagesSessionId === chatSessionId && st.messages.length === 0;
      if (activeEmpty) {
        toast("Send a message in this chat before opening it in a second pane");
        return false;
      }
      // The session lives in the MAIN pane. Pinning it elsewhere would mirror
      // the active chat into two views — pin the new pane to it and let main
      // fall back to the next most recent OTHER chat that is NOT already
      // pinned in a pane (a pinned fallback would get eaten by selectSession's
      // focus-redirect, leaving active unchanged — and the mirror back).
      const fallback = st.sessions.find(
        (x) =>
          x.id !== chatSessionId &&
          !findPaneForSession(workTree, x.id) &&
          !isDeletedSession(x.id),
      );
      if (!fallback) {
        toast("Open a second chat to split the view");
        return false;
      }
      // selectSession's first set() is synchronous, so `active` has moved off
      // the session before the tree patch below commits.
      void get().selectSession(fallback.id, { recordNav: false });
    }

    if (workTree && countChatPanes(workTree) >= MAX_CHAT_PANES) {
      toast(`Up to ${MAX_CHAT_PANES} chats can be open at once`);
      return false;
    }

    // Allocate a pane id no existing leaf carries (guards against any manual
    // id ever entering the tree — a collision would alias two panes' buffers).
    let newPaneId = nextChatPaneId();
    while (workTree && findChatLeaf(workTree, newPaneId)) newPaneId = nextChatPaneId();
    const next = insertChatPaneSplit(workTree, {
      targetPaneId,
      edge,
      newPaneId,
      sessionId: chatSessionId,
      splitId: nextChatSplitId(),
    });
    if (!next) return false;

    set((s) => {
      let paneBuffers = s.paneBuffers;
      if (removedPaneId) paneBuffers = omitKey(paneBuffers, removedPaneId);
      return {
        chatPaneTree: next,
        paneBuffers: {
          ...paneBuffers,
          [newPaneId]: { sessionId: chatSessionId, messages: [], hasMoreHistory: false },
        },
        // A NEW arrangement begins — any remembered layout is stale now.
        rememberedChatPaneState: null,
        // Focus follows the pane the user just placed.
        focusedPaneId: newPaneId,
        focusedChatSessionId: chatSessionId,
      };
    });
    void get().loadPaneMessages(newPaneId, chatSessionId);
    return true;
  };

  return {
    // Bring back a remembered pane layout because the user clicked one of
    // its chats. The main leaf re-selects the chat it showed at collapse
    // time (a live session distinct from the clicked one), then the tree
    // mounts and the clicked chat's pane takes the focus.
    restoreChatPaneState: async (chatSessionId: string) => {
      const remembered = get().rememberedChatPaneState;
      if (!remembered) return;
      const paneId = findPaneForSession(remembered.tree, chatSessionId);
      if (!paneId) return;
      const live = (sid: string | null): sid is string =>
        !!sid && !isDeletedSession(sid) && get().sessions.some((x) => x.id === sid);
      let mainSession = remembered.activeSessionId;
      if (!live(mainSession) || mainSession === chatSessionId) {
        const fallback = get().sessions.find(
          (x) => x.id !== chatSessionId && !isDeletedSession(x.id),
        );
        mainSession = fallback?.id ?? null;
      }
      if (!mainSession) return; // nothing live for the main leaf — stay single
      // Select the main-leaf chat FIRST, while the tree is still null (this
      // select takes the plain path — no collapse/restore re-entry).
      await get().selectSession(mainSession, { recordNav: false });
      set({
        chatPaneTree: remembered.tree,
        rememberedChatPaneState: null,
        focusedPaneId: paneId,
        focusedChatSessionId: chatSessionId,
      });
    },

    // Session-row ⋮ action: open the chat in a NEW pane beside the focused
    // one; if it's already pinned in a pane, close that pane (toggle).
    openChatSplit: async (chatSessionId: string) => {
      const st = get();
      const pinned = findPaneForSession(st.chatPaneTree, chatSessionId);
      if (pinned) {
        get().closeChatPane(pinned);
        return;
      }
      await openSessionOnPaneEdge(chatSessionId, resolvePaneTarget(), "right");
    },

    closeChatPane: (paneId: string) => {
      const tree = get().chatPaneTree;
      if (!tree) return;
      // Works for ANY pane — including the main one. Closing main promotes
      // the first remaining pane to follower: its session becomes the active
      // one and its buffer migrates to the main buffer (fresh-loaded below).
      const res = removeChatPanePromote(tree, paneId);
      if (!res) return;
      set((s) => {
        let paneBuffers = omitKey(s.paneBuffers, paneId);
        if (res.promotedPaneId) paneBuffers = omitKey(paneBuffers, res.promotedPaneId);
        const focusReset =
          s.focusedPaneId === paneId ||
          (res.promotedPaneId != null && s.focusedPaneId === res.promotedPaneId);
        return {
          chatPaneTree: res.tree,
          paneBuffers,
          activeChatSessionId: res.promotedSessionId ?? s.activeChatSessionId,
          focusedPaneId: focusReset ? null : s.focusedPaneId,
          focusedChatSessionId: focusReset ? null : s.focusedChatSessionId,
        };
      });
      if (res.promotedSessionId) void get().loadMessages(res.promotedSessionId);
    },

    closeAllChatPanes: () =>
      set({
        chatPaneTree: null,
        paneBuffers: {},
        // Deliberate close — the remembered layout is discarded too.
        rememberedChatPaneState: null,
        focusedPaneId: null,
        focusedChatSessionId: null,
      }),

    setChatPaneRatio: (splitId: string, ratio: number) =>
      set((s) => ({
        chatPaneTree: s.chatPaneTree ? applyPaneRatio(s.chatPaneTree, splitId, ratio) : s.chatPaneTree,
      })),

    setFocusedPane: (paneId: string | null) =>
      set((s) => ({
        focusedPaneId: paneId,
        focusedChatSessionId: paneId ? (s.paneBuffers[paneId]?.sessionId ?? null) : null,
      })),

    moveChatSessionToPane: async (
      chatSessionId: string,
      targetPaneId: string,
      edge: ChatPaneEdge,
    ) => {
      await openSessionOnPaneEdge(chatSessionId, targetPaneId, edge);
    },
  };
}
