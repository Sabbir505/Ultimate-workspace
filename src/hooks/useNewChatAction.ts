// Shared "start a new chat" action for every entry point (expanded sidebar
// header "+", collapsed rail "+", …) so they all behave identically: create
// via the chat store with the persisted provider/model defaults, then flip
// the main view to chat. Project/folder inheritance is decided inside the
// store's newChat — the new session adopts the previously active session's
// project binding, or stays independent when that chat has none.
import { useCallback } from "react";
import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";

export function useNewChatAction() {
  const newChat = useChatStore((s) => s.newChat);
  const chatConfig = useChatStore((s) => s.config);
  const setActiveView = useUiStore((s) => s.setActiveView);

  return useCallback(() => {
    const provider = chatConfig?.provider ?? "openai_compatible";
    void newChat(provider, chatConfig?.model ?? "").then((session) => {
      if (session) setActiveView("chat");
    });
  }, [newChat, chatConfig, setActiveView]);
}
