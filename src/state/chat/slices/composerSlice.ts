// Composer slice: drafts, the per-session FIFO queue, the global send toggles,
// and drainQueue (which re-enters sendMessage via get()).
import type { ChatStoreGet, ChatStoreSet } from "../types";
import { queueIdCounter } from "../moduleState";

export function createComposerSlice(set: ChatStoreSet, get: ChatStoreGet) {
  return {
    setComposerDraft: (sessionId: string | null, value: string | ((prev: string) => string)) => {
      if (!sessionId) return;
      set((s) => {
        const prev = s.composerDrafts[sessionId] ?? "";
        const next = typeof value === "function" ? value(prev) : value;
        if (next === prev) return s;
        return { composerDrafts: { ...s.composerDrafts, [sessionId]: next } };
      });
    },

    removeQueuedMessage: (chatSessionId: string, id: number) =>
      set((s) => ({
        messageQueue: {
          ...s.messageQueue,
          [chatSessionId]: (s.messageQueue[chatSessionId] ?? []).filter((m) => m.id !== id),
        },
      })),

    steerQueuedMessage: async (chatSessionId: string, id: number) => {
      const queue = get().messageQueue[chatSessionId] ?? [];
      const steered = queue.find((m) => m.id === id);
      if (!steered) return;
      const remaining = queue.filter((m) => m.id !== id);
      // Park the rest of the stack FIRST: cancelStream drains the queue on
      // completion (chat.ts cancel path), and without this it would fire the
      // WRONG (FIFO-next) message ahead of the steered one.
      set((s) => ({ messageQueue: { ...s.messageQueue, [chatSessionId]: [] } }));
      if (chatSessionId in get().streaming) {
        // Steering = interrupt. Stop the in-flight turn, then dispatch the
        // steered message as the very next turn (the partial reply survives
        // via the cancel path's partial persist). Both calls take the session
        // id explicitly — without it they'd cancel/send into whichever chat is
        // globally active, not the one being steered (audit B-21).
        await get().cancelStream(chatSessionId);
      }
      // Put the not-yet-sent messages back — they drain FIFO once the steered
      // turn finishes (onDone → drainQueue).
      set((s) => ({ messageQueue: { ...s.messageQueue, [chatSessionId]: remaining } }));
      void get().sendMessage(steered.content, steered.attachments, steered.forceResearch, chatSessionId);
    },

    editQueuedMessage: (chatSessionId: string, id: number, content: string) =>
      set((s) => ({
        messageQueue: {
          ...s.messageQueue,
          [chatSessionId]: (s.messageQueue[chatSessionId] ?? []).map((m) =>
            m.id === id ? { ...m, content } : m,
          ),
        },
      })),

    moveQueuedMessage: (chatSessionId: string, from: number, to: number) =>
      set((s) => {
        const queue = [...(s.messageQueue[chatSessionId] ?? [])];
        if (from < 0 || from >= queue.length || to < 0 || to >= queue.length || from === to) {
          return {};
        }
        const [moved] = queue.splice(from, 1);
        queue.splice(to, 0, moved);
        return { messageQueue: { ...s.messageQueue, [chatSessionId]: queue } };
      }),

    drainQueue: (chatSessionId: string) => {
      // sendMessage takes a per-session override, so a background or split-pane
      // session drains its own queue directly instead of stranding it until
      // the user re-opens the chat.
      // Per-session check (not the shared streamingChatSessionId scalar):
      // sessions A and B can stream concurrently, and A's queued messages must
      // not strand just because B owns the scalar when A finishes.
      if (chatSessionId in get().streaming) return;
      const [next, ...rest] = get().messageQueue[chatSessionId] ?? [];
      if (!next) return;
      set((s) => ({ messageQueue: { ...s.messageQueue, [chatSessionId]: rest } }));
      void get().sendMessage(next.content, next.attachments, next.forceResearch, chatSessionId);
    },

    setEffort: (effort: string) => set({ effort }),

    setLocalCtx: (localCtx: number) => set({ localCtx }),

    /** Toggle the extended-thinking flag for the next message. `null` clears
     *  the override so the provider default is used. */
    setThinking: (thinking: boolean | null) => set({ thinking }),

    setToolsEnabled: (toolsEnabled: boolean) =>
      set(toolsEnabled ? { toolsEnabled } : { toolsEnabled, codeExecEnabled: false }),

    // Enabling code execution implies tools are on (the tool loop must run).
    setCodeExecEnabled: (codeExecEnabled: boolean) =>
      set(codeExecEnabled ? { codeExecEnabled, toolsEnabled: true } : { codeExecEnabled }),
  };
}
