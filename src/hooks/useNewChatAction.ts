// Shared "start a new chat" action for every entry point (expanded sidebar
// header "+", collapsed rail "+", …) so they all behave identically: create
// via the chat store seeded from the last committed composer pick (falling
// back to the persisted provider/model defaults), then flip the main view to
// chat. Project/folder inheritance is decided inside the store's newChat —
// the new session adopts the previously active session's project binding, or
// stays independent when that chat has none.
import { useCallback } from "react";
import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";
import { seedSelectionFrom } from "../lib/lastSelection";

export function useNewChatAction() {
  const newChat = useChatStore((s) => s.newChat);
  const chatConfig = useChatStore((s) => s.config);
  const lastSelection = useChatStore((s) => s.lastSelection);
  const setActiveView = useUiStore((s) => s.setActiveView);

  return useCallback(() => {
    const seed = seedSelectionFrom(lastSelection, chatConfig);
    void newChat(seed.provider, seed.model, undefined, seed.agent).then((session) => {
      if (session) setActiveView("chat");
    });
  }, [newChat, lastSelection, chatConfig, setActiveView]);
}
