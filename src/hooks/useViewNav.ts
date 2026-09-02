// Browser-style Back/Forward over the view+chat nav timeline (ui store).
//
// Both arrow clusters (expanded sidebar header, collapsed toolbar rail) use
// this so they behave identically. A history entry can name a chat session;
// when Back/Forward lands on one, that chat is re-selected (WITHOUT
// recording a new step) so navigation returns to the chat the user was
// reading — not just the view it lived in.
import { useCallback } from "react";
import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";

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

export function useViewNav() {
  const viewIndex = useUiStore((s) => s.viewIndex);
  const historyLength = useUiStore((s) => s.viewHistory.length);

  const back = useCallback(() => {
    const entry = useUiStore.getState().navBack();
    if (entry?.chatSessionId) restoreChat(entry.chatSessionId);
  }, []);

  const forward = useCallback(() => {
    const entry = useUiStore.getState().navForward();
    if (entry?.chatSessionId) restoreChat(entry.chatSessionId);
  }, []);

  return {
    back,
    forward,
    canBack: viewIndex > 0,
    canForward: viewIndex < historyLength - 1,
  };
}
