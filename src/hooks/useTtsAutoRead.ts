// Auto-read: voice the answer that just finished, when the user asked for it.
//
// Scoped deliberately to the session the user is *looking at*. Background chats
// completing should stay quiet — they already have the sidebar unread badge and
// (unfocused) the completion chime, and reading a chat nobody is watching would
// talk over whatever is on screen with no visible control to stop it (the
// player bar lives in the chat grid of the visible view).
import { useEffect } from "react";
import { parseSegments } from "../lib/segments";
import { toggleReadAloud } from "../lib/tts";
import { ttsStatus } from "../lib/ipc";
import { useChatStore } from "../state/chat";
import { useTtsStore } from "../state/tts";

/** Load the persisted setting once per app run. Without this, a turn finishing
 *  before Settings was ever opened would ignore auto-read — the store starts
 *  from the default rather than from the DB. */
export function useTtsAutoRead(): void {
  useEffect(() => {
    let stale = false;
    void ttsStatus()
      .then((status) => {
        if (!stale && status) useTtsStore.getState().set({ autoRead: status.autoRead });
      })
      .catch(() => {
        /* no backend (tests / browser dev) — auto-read stays off */
      });
    return () => {
      stale = true;
    };
  }, []);
}

/** Called after a turn is persisted. No-ops unless auto-read is enabled, the
 *  turn belongs to the visible session, and nothing is already being read. */
export function autoReadFinishedTurn(chatSessionId: string): void {
  const tts = useTtsStore.getState();
  if (!tts.autoRead) return;
  // A read the user started by hand always wins over the automatic one.
  if (tts.phase !== "idle") return;

  const chat = useChatStore.getState();
  const focusedId = chat.focusedChatSessionId ?? chat.activeChatSessionId;
  if (chatSessionId !== focusedId) return;

  const messages = chat.messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.chatSessionId !== chatSessionId) continue;
    if (message.role !== "assistant") continue;
    // Same text the Copy button yields — `parseSegments` drops the think blocks
    // and tool markup, which must never be voiced.
    const text = parseSegments(message.content)
      .filter((segment): segment is Extract<typeof segment, { type: "text" }> => segment.type === "text")
      .map((segment) => segment.text)
      .join("")
      .trim();
    if (!text) return;
    // Key matches the bubble's own play button so the button flips to Stop.
    toggleReadAloud({ key: `msg:${chatSessionId}:${message.id}`, label: "Answer", text });
    return;
  }
}
