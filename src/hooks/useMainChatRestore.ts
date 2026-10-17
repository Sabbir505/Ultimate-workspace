// The Bots view renders the REAL ChatView on a bot session, and ChatView is
// driven by the ONE shared `activeChatSessionId`. So opening a bot swapped the
// main chat's active session to the bot's — and toggling back to Chat (the
// BottomBar bots button calls `setActiveView("chat")`, which selects no chat)
// left the main Chat view rendering that bot session.
//
// This hook remembers the last MAIN (non-bot) chat and, the moment the Bots
// view stops being the base view, hands the main chat its session back —
// falling back to a fresh, composer-seeded chat when there is none to restore.
import { useEffect, useRef } from "react";
import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";
import { seedSelectionFrom } from "../lib/lastSelection";

/** A session that belongs to a bot (a conversation or a run) rather than the
 *  user's own chat. */
function isBotSession(
  s: { botId?: string | null; botRole?: string | null } | undefined,
): boolean {
  return Boolean(s && (s.botId != null || s.botRole === "run"));
}

export function useMainChatRestore(): void {
  const lastMain = useRef<string | null>(null);
  const baseView = useUiStore((s) => s.baseView);
  const activeId = useChatStore((s) => s.activeChatSessionId);
  const sessions = useChatStore((s) => s.sessions);

  // Continuously remember the last main chat the user was actually on. A bot
  // session never overwrites it, so it survives the whole Bots visit.
  useEffect(() => {
    if (!activeId) return;
    const sess = sessions.find((s) => s.id === activeId);
    if (sess && !isBotSession(sess)) lastMain.current = activeId;
  }, [activeId, sessions]);

  // Leaving Bots → if the shared active session is a bot's, restore the main
  // chat (or start a fresh one).
  const prev = useRef(baseView);
  useEffect(() => {
    if (prev.current === "bots" && baseView !== "bots") {
      const chat = useChatStore.getState();
      const cur = chat.activeChatSessionId;
      const sess = cur ? chat.sessions.find((s) => s.id === cur) : undefined;
      if (isBotSession(sess)) {
        const restore = lastMain.current;
        const canRestore =
          restore != null && chat.sessions.some((s) => s.id === restore && !isBotSession(s));
        if (canRestore) {
          void chat.selectSession(restore as string, { recordNav: false }).catch(() => {});
        } else {
          const seed = seedSelectionFrom(chat.lastSelection, chat.config);
          void chat
            .newChat(seed.provider, seed.model, undefined, seed.agent)
            .catch(() => {});
        }
      }
    }
    prev.current = baseView;
  }, [baseView]);
}
