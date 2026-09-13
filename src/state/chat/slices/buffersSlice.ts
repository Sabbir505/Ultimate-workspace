// Buffers slice: the two message buffers (main + split pane), their page
// loaders, and the message-level operations (regenerate / edit-to-fork /
// delete) that act on whichever buffer displays the target session.
import {
  deleteChatMessage,
  getChatMessages,
  supersedeChatTail,
  toastError,
} from "../../../lib/ipc";
import {
  loadBufferOlder,
  loadBufferPage,
  mergeOptimistic,
} from "../moduleState";
import type { ChatMessageRecord } from "../../../lib/ipc";
import type { ChatStoreGet, ChatStoreSet } from "../types";

export function createBuffersSlice(set: ChatStoreSet, get: ChatStoreGet) {
  return {
    loadMessages: async (chatSessionId: string) => {
      await loadBufferPage(get, set, "main", chatSessionId);
    },

    loadOlderMessages: async (chatSessionId: string) => loadBufferOlder(get, set, "main", chatSessionId),

    // --- Split chat view (session-row ⋮ → "Open in split view") ---
    openChatSplit: (chatSessionId: string) => {
      set((s) => ({
        splitChatSessionId: chatSessionId,
        // Reopening on the SAME session keeps the loaded buffer (scroll pos
        // resets anyway); a different session starts a fresh buffer.
        splitMessages:
          s.splitMessagesSessionId === chatSessionId ? s.splitMessages : [],
        splitMessagesSessionId:
          s.splitMessagesSessionId === chatSessionId ? s.splitMessagesSessionId : null,
        splitHasMoreHistory:
          s.splitMessagesSessionId === chatSessionId ? s.splitHasMoreHistory : false,
      }));
    },

    closeChatSplit: () => {
      set({ splitChatSessionId: null, splitMessages: [], splitMessagesSessionId: null, splitHasMoreHistory: false, focusedChatSessionId: null });
    },

    setFocusedChatSession: (chatSessionId: string | null) => set({ focusedChatSessionId: chatSessionId }),

    loadSplitMessages: async (chatSessionId: string) => {
      // Mirrors loadMessages but fills the SPLIT pane's buffer; guarded so a
      // slow fetch for a pane the user already re-targeted can't clobber it.
      await loadBufferPage(get, set, "split", chatSessionId);
    },

    loadOlderSplitMessages: async (chatSessionId: string) =>
      loadBufferOlder(get, set, "split", chatSessionId),

    reloadFor: async (chatSessionId: string) => {
      const s = get();
      if (s.activeChatSessionId === chatSessionId) await get().loadMessages(chatSessionId);
      else if (s.splitChatSessionId === chatSessionId) await get().loadSplitMessages(chatSessionId);
    },

    // Regenerate resends the most recent user message. The backend appends a
    // new assistant turn (history is rebuilt from the DB each send).
    //
    // IMPORTANT: the bubble's `content` may contain "[Attached image: …]" /
    // "[Attached file: …]" markers that the UI injected for display purposes
    // only. Re-sending those markers would let the model misinterpret them as
    // fresh attachments and try to process nonexistent files. Strip them so
    // the regenerated turn mirrors what the BACKEND actually persisted.
    // Re-run the last user message to get a fresh assistant response. This is
    // branch-aware (roadmap #9): it retires the current tail first, so the model
    // doesn't keep seeing the stale answer being regenerated.
    regenerate: async (sessionIdOverride?: string) => {
      const activeChatSessionId = sessionIdOverride ?? get().activeChatSessionId;
      const list =
        activeChatSessionId === get().splitChatSessionId && activeChatSessionId !== get().activeChatSessionId
          ? get().splitMessages
          : get().messages;
      // Don't regenerate mid-stream — per-session check (the legacy scalar can
      // name a different concurrently-streaming chat, which used to block
      // regenerate in an idle chat or allow it mid-stream in this one).
      if (activeChatSessionId && activeChatSessionId in get().streaming) return;
      const active = list.filter((m) => !m.supersededBy);
      const lastUser = [...active].reverse().find((m) => m.role === "user");
      if (!lastUser) return;
      const clean = lastUser.content.replace(/\n\n\[Attached (?:image|file):[^\n]*\]/g, "");
      try {
        await supersedeChatTail(lastUser.id);
        if (activeChatSessionId) await get().reloadFor(activeChatSessionId);
        // No override → call without the extra args (keeps the plain
        // active-session send path byte-identical for tests and logging).
        if (sessionIdOverride) await get().sendMessage(clean, undefined, undefined, sessionIdOverride);
        else await get().sendMessage(clean);
      } catch (err) {
        toastError("Regenerate failed", err);
      }
    },

    // Edit-to-fork (roadmap #9): retire the branch at `messageId`, reload the
    // active message list, then send the edited text as a fresh turn. The old
    // branch stays in the timeline (dimmed) but no longer feeds the model.
    editMessage: async (messageId: number, newContent: string, sessionIdOverride?: string) => {
      const activeChatSessionId = sessionIdOverride ?? get().activeChatSessionId;
      // Per-session streaming guard (same reasoning as regenerate above).
      if (!activeChatSessionId || activeChatSessionId in get().streaming) return;
      try {
        await supersedeChatTail(messageId);
        if (activeChatSessionId) await get().reloadFor(activeChatSessionId);
        // Send the edited text as a new turn (override only when present —
        // keeps the plain active-session call shape for the branch tests).
        if (sessionIdOverride) await get().sendMessage(newContent, undefined, undefined, sessionIdOverride);
        else await get().sendMessage(newContent);
      } catch (err) {
        toastError("Failed to edit message", err);
      }
    },

    // Delete a single chat message by id. Optimistically removes the bubble
    // from the active session's message list, then asks the backend to
    // confirm. Persisted artifacts attributed to the message are detached
    // server-side (not deleted) so a user wiping a turn doesn't lose their
    // generated files — the artifact library still lists them.
    deleteMessage: async (messageId: number, sessionIdOverride?: string) => {
      const activeChatSessionId = sessionIdOverride ?? get().activeChatSessionId;
      const inSplit =
        activeChatSessionId === get().splitChatSessionId && activeChatSessionId !== get().activeChatSessionId;
      set((s) => {
        // Drop the bubble from the list that shows it. Negative ids are
        // optimistic just-sent bubbles that never round-tripped to the DB, so
        // a missing match here is fine — the local filter simply doesn't
        // remove anything.
        const drop = (list: ChatMessageRecord[]) => list.filter((m) => m.id !== messageId);
        if (inSplit) {
          const nextSplit = drop(s.splitMessages);
          if (nextSplit.length !== s.splitMessages.length) {
            const nextByMessage = { ...s.artifactsByMessage };
            delete nextByMessage[messageId];
            return { splitMessages: nextSplit, artifactsByMessage: nextByMessage };
          }
          return {};
        }
        const nextMessages = drop(s.messages);
        // If the deleted message had attributed artifacts, clear the local
        // attribution map. The artifact rows/files stay (the backend detaches
        // them, not deletes) but the per-message chip row is gone.
        if (nextMessages.length !== s.messages.length) {
          const nextByMessage = { ...s.artifactsByMessage };
          delete nextByMessage[messageId];
          return { messages: nextMessages, artifactsByMessage: nextByMessage };
        }
        return {};
      });
      try {
        await deleteChatMessage(messageId);
      } catch (err) {
        // Rollback: the backend rejected the delete (e.g. DB error, or the row
        // was already gone via another path). Re-fetch so the local list
        // matches persisted state instead of staying out of sync.
        toastError("Couldn't delete the message", err);
        if (activeChatSessionId) {
          try {
            // Same 200-row page cap as loadMessages (M10 / audit B-23) — the
            // rollback refetch must not pull the full history.
            const msgs = await getChatMessages(activeChatSessionId, undefined, 200);
            // Re-derive which buffer currently displays this session AFTER the
            // await: a session switch while the delete/refetch was in flight
            // must not write the old session's rows into the other chat's
            // buffer (same guard contract as cancelStream / onDone).
            const isActiveSession = get().activeChatSessionId === activeChatSessionId;
            const isSplitTarget =
              get().splitChatSessionId === activeChatSessionId && !isActiveSession;
            if (isActiveSession)
              set({
                messages: msgs ?? [],
                messagesSessionId: activeChatSessionId,
                hasMoreHistory: (msgs?.length ?? 0) >= 200,
              });
            else if (isSplitTarget)
              set({
                splitMessages: msgs ?? [],
                splitMessagesSessionId: activeChatSessionId,
                splitHasMoreHistory: (msgs?.length ?? 0) >= 200,
              });
          } catch {
            /* best-effort rollback */
          }
        }
      }
    },
  };
}
