// Browser-style Back/Forward over the view+chat+vault nav timeline (ui store).
//
// Both arrow clusters (expanded sidebar header, collapsed toolbar rail) use
// this so they behave identically. A history entry can name a chat session;
// when Back/Forward lands on one, that chat is re-selected (WITHOUT
// recording a new step) so navigation returns to the chat the user was
// reading — not just the view it lived in. Vault entries carry the same
// idea further: the note/asset/graph trio is restored, so Back from a graph
// returns to the pdf you were reading, Forward returns to the graph.
import { useCallback } from "react";
import { useChatStore } from "../state/chat";
import { useUiStore, type VaultNavSnapshot } from "../state/ui";
import { useVaultStore } from "../state/vault";

function restoreChat(chatSessionId: string) {
  const chat = useChatStore.getState();
  // Already open (common: the entry just mirrors the current session) —
  // skip the heavy message reload entirely.
  if (chat.activeChatSessionId === chatSessionId) return;
  void chat
    .selectSession(chatSessionId, { recordNav: false })
    .catch(() => {
      /* stale entry (chat deleted since) — stay on the current chat */
    });
}

function restoreVault(snap: VaultNavSnapshot) {
  void useVaultStore.getState().restoreSnapshot(snap).catch(() => {
    /* stale entry — stay on the current state */
  });
}

export function useViewNav() {
  const viewIndex = useUiStore((s) => s.viewIndex);
  const historyLength = useUiStore((s) => s.viewHistory.length);

  const back = useCallback(() => {
    const entry = useUiStore.getState().navBack();
    if (entry?.chatSessionId) restoreChat(entry.chatSessionId);
    if (entry?.view === "vault" && entry.vault) restoreVault(entry.vault);
  }, []);

  // "Back to chat" (full-page views' left arrow): skip over any intermediate
  // full-page views and land on the chat the user was last reading.
  const backToChat = useCallback(() => {
    const entry = useUiStore.getState().navBackToChat();
    if (entry?.chatSessionId) restoreChat(entry.chatSessionId);
    return entry;
  }, []);

  const forward = useCallback(() => {
    const entry = useUiStore.getState().navForward();
    if (entry?.chatSessionId) restoreChat(entry.chatSessionId);
    if (entry?.view === "vault" && entry.vault) restoreVault(entry.vault);
  }, []);

  return {
    back,
    backToChat,
    forward,
    canBack: viewIndex > 0,
    canForward: viewIndex < historyLength - 1,
  };
}
