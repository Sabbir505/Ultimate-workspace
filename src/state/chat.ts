// Chat store: sessions, messages, live streaming state, config, and all actions.
// Mirrors the style of src/state/projects.ts and src/state/settings.ts.
//
// IMPORTANT: all streaming updates are keyed by chatSessionId, NOT by
// "active session", so streams complete correctly even if the user switches
// to a different chat in the sidebar.
import { create } from "zustand";
import {
  cancelChatMessage,
  createChatSession,
  deleteChatApiKey,
  deleteChatSession,
  generateChatTitle,
  getChatConfig,
  getChatMessages,
  listChatArtifacts,
  listChatSessions,
  sendChatMessage,
  setChatApiKey,
  setChatSessionStarred,
  setChatSessionUnread,
  touchChatSession,
  updateChatSessionModel,
  updateChatSessionTitle,
  type ChatAttachmentInput,
  type ChatArtifactPayload,
  type ChatConfigPayload,
  type ChatMessageRecord,
  type ChatSession,
} from "../lib/ipc";
import { useArtifactsStore } from "./artifacts";

/** Sessions the user manually renamed — never auto-summarize their title. */
const manuallyRenamed = new Set<string>();

/** A file the model generated during a chat, surfaced as a download chip. */
export interface ChatArtifact {
  path: string;
  filename: string;
  /** Inline (non-file) live preview payload — e.g. a ```jsx / ```tsx code
   *  block from an assistant message. When set, the preview pane renders it
   *  directly (live React preview) instead of reading `path` from disk. */
  inline?: { kind: "jsx" | "tsx"; code: string };
}

/** Float starred chats to the top while preserving the existing (recency)
 *  order within the starred and unstarred groups. Stable so the optimistic
 *  "bump active chat to top" reordering still works. */
function sortSessions(list: ChatSession[]): ChatSession[] {
  const starred = list.filter((s) => s.starred);
  const rest = list.filter((s) => !s.starred);
  return [...starred, ...rest];
}

interface ChatState {
  loaded: boolean;
  sessions: ChatSession[];
  activeChatSessionId: string | null;
  messages: ChatMessageRecord[];
  streaming: Record<string, string>; // chatSessionId -> accumulating assistant text
  streamingChatSessionId: string | null; // which session is currently streaming
  config: ChatConfigPayload | null;
  error: string | null;
  /** Reasoning effort sent with messages ("" = provider default). */
  effort: string;
  /** When true, the model may call tools (web search, …) during a turn. */
  toolsEnabled: boolean;
  /** When true, the model may execute code (opt-in, security-sensitive). */
  codeExecEnabled: boolean;
  /** Generated files per chat session (chatSessionId -> artifacts). */
  artifacts: Record<string, ChatArtifact[]>;
  /** Artifacts attributed to a specific assistant message (messageId -> artifacts). */
  artifactsByMessage: Record<number, ChatArtifact[]>;
  /** Artifacts produced by the in-flight turn, keyed by session, until the
   *  assistant message is persisted and they can be attributed to it. */
  pendingArtifacts: Record<string, ChatArtifact[]>;
  /** The artifact currently shown in the preview pane (null = pane closed). */
  previewArtifact: ChatArtifact | null;

  // Actions
  loadSessions: () => Promise<void>;
  loadMessages: (chatSessionId: string) => Promise<void>;
  loadConfig: (provider?: string) => Promise<void>;
  selectSession: (chatSessionId: string) => Promise<void>;
  newChat: (provider: string, model: string) => Promise<ChatSession | null>;
  deleteChat: (chatSessionId: string) => Promise<void>;
  renameChat: (chatSessionId: string, title: string) => Promise<void>;
  /** Star/unstar a chat (pins it to the top of the sidebar). */
  setStarred: (chatSessionId: string, starred: boolean) => Promise<void>;
  /** Mark a chat read/unread (shows an unread dot in the sidebar). */
  setUnread: (chatSessionId: string, unread: boolean) => Promise<void>;
  setSessionModel: (chatSessionId: string, model: string) => Promise<void>;
  setEffort: (effort: string) => void;
  setToolsEnabled: (enabled: boolean) => void;
  setCodeExecEnabled: (enabled: boolean) => void;
  sendMessage: (content: string, attachments?: ChatAttachmentInput[]) => Promise<void>;
  /** Re-run the last user message to get a fresh assistant response. */
  regenerate: () => Promise<void>;
  cancelStream: () => Promise<void>;
  /** Open/close the artifact preview pane. */
  setPreviewArtifact: (artifact: ChatArtifact | null) => void;
  saveApiKey: (provider: string, key: string, baseUrl?: string, model?: string) => Promise<void>;
  clearApiKey: (provider: string) => Promise<void>;

  // Called by the event hook (useChatEvents) — not meant for direct component use.
  onToken: (chatSessionId: string, token: string) => void;
  onDone: (chatSessionId: string, inputTokens: number | null, outputTokens: number | null, costUsd: number | null) => void;
  onError: (chatSessionId: string, message: string, code: string | null) => void;
  onArtifact: (payload: ChatArtifactPayload) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  loaded: false,
  sessions: [],
  activeChatSessionId: null,
  messages: [],
  streaming: {},
  streamingChatSessionId: null,
  config: null,
  error: null,
  effort: "",
  // Tools are on by default so the model itself decides when to web-search,
  // generate a file/document/diagram, fetch a URL or run code — the user no
  // longer has to arm them manually before each relevant request.
  toolsEnabled: true,
  codeExecEnabled: true,
  artifacts: {},
  artifactsByMessage: {},
  pendingArtifacts: {},
  previewArtifact: null,

  loadSessions: async () => {
    const sessions = await listChatSessions();
    set({ loaded: true, sessions: sessions ?? [] });
  },

  loadMessages: async (chatSessionId) => {
    const messages = await getChatMessages(chatSessionId);
    set((s) => ({
      messages: s.activeChatSessionId === chatSessionId ? (messages ?? []) : s.messages,
    }));
  },

  loadConfig: async (provider?: string) => {
    const config = await getChatConfig(provider);
    set({ config });
  },

  selectSession: async (chatSessionId) => {
    // Opening a chat clears its unread mark (persisted only if it was set).
    const wasUnread = get().sessions.find((s) => s.id === chatSessionId)?.unread ?? false;
    set((s) => ({
      activeChatSessionId: chatSessionId,
      error: null,
      previewArtifact: null,
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId && sess.unread ? { ...sess, unread: false } : sess,
      ),
    }));
    if (wasUnread) void setChatSessionUnread(chatSessionId, false);
    const [messages, records] = await Promise.all([
      getChatMessages(chatSessionId),
      listChatArtifacts(chatSessionId),
    ]);
    // Only update messages if the user hasn't clicked away to another session
    // while the fetch was in-flight.
    if (get().activeChatSessionId === chatSessionId) {
      set({ messages: messages ?? [], activeChatSessionId: chatSessionId });
      // Restore this chat's generated artifacts (inline diagrams / file chips)
      // so they reappear when the session is reopened. Skip sessions that are
      // mid-stream — their live buffers are the source of truth.
      if (records && get().streamingChatSessionId !== chatSessionId) {
        const list: ChatArtifact[] = records.map((r) => ({
          path: r.path,
          filename: r.filename,
        }));
        const byMessage: Record<number, ChatArtifact[]> = {};
        for (const r of records) {
          if (r.chatMessageId == null) continue;
          (byMessage[r.chatMessageId] ??= []).push({
            path: r.path,
            filename: r.filename,
          });
        }
        set((s) => ({
          artifacts: { ...s.artifacts, [chatSessionId]: list },
          artifactsByMessage: { ...s.artifactsByMessage, ...byMessage },
        }));
      }
    }
    // Touch and reorder in the background.
    void touchChatSession(chatSessionId).then(async () => {
      const sessions = await listChatSessions();
      if (sessions) set({ sessions });
    });
  },

  newChat: async (provider, model) => {
    const session = await createChatSession(provider, model);
    if (session) {
      // Insert at the top so it appears immediately in the sidebar (below
      // any starred chats).
      set((s) => ({
        sessions: sortSessions([session, ...s.sessions]),
        activeChatSessionId: session.id,
        messages: [],
        error: null,
      }));
    }
    return session;
  },

  deleteChat: async (chatSessionId) => {
    await deleteChatSession(chatSessionId);
    set((s) => ({
      sessions: s.sessions.filter((sess) => sess.id !== chatSessionId),
      activeChatSessionId: s.activeChatSessionId === chatSessionId ? null : s.activeChatSessionId,
      messages: s.activeChatSessionId === chatSessionId ? [] : s.messages,
      // Don't clear streaming state for another session if it happens to be the same ID
      // (unlikely but safe).
      streamingChatSessionId:
        s.streamingChatSessionId === chatSessionId ? null : s.streamingChatSessionId,
    }));
  },

  renameChat: async (chatSessionId, title) => {
    manuallyRenamed.add(chatSessionId);
    await updateChatSessionTitle(chatSessionId, title);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, title } : sess,
      ),
    }));
  },

  setStarred: async (chatSessionId, starred) => {
    await setChatSessionStarred(chatSessionId, starred);
    set((s) => ({
      sessions: sortSessions(
        s.sessions.map((sess) =>
          sess.id === chatSessionId ? { ...sess, starred } : sess,
        ),
      ),
    }));
  },

  setUnread: async (chatSessionId, unread) => {
    await setChatSessionUnread(chatSessionId, unread);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, unread } : sess,
      ),
    }));
  },

  setSessionModel: async (chatSessionId, model) => {
    await updateChatSessionModel(chatSessionId, model);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, model } : sess,
      ),
    }));
  },

  setEffort: (effort) => set({ effort }),

  setToolsEnabled: (toolsEnabled) =>
    set(toolsEnabled ? { toolsEnabled } : { toolsEnabled, codeExecEnabled: false }),

  // Enabling code execution implies tools are on (the tool loop must run).
  setCodeExecEnabled: (codeExecEnabled) =>
    set(codeExecEnabled ? { codeExecEnabled, toolsEnabled: true } : { codeExecEnabled }),

  sendMessage: async (content, attachments) => {
    const { activeChatSessionId, messages, sessions, effort, toolsEnabled, codeExecEnabled } =
      get();
    if (!activeChatSessionId) return;
    // Guard against a double-send while a turn is already streaming for this
    // session (e.g. a duplicate submit during a slow tool-calling turn), which
    // would persist the same user message twice.
    if (get().streamingChatSessionId === activeChatSessionId) return;

    // Optimistic bubble mirrors what the backend will persist: the typed text
    // plus a compact note per attachment (the model gets the real content).
    const attachNote = (attachments ?? [])
      .map((a) =>
        a.kind === "image" ? `\n\n[Attached image: ${a.name}]` : `\n\n[Attached file: ${a.name}]`,
      )
      .join("");
    const displayContent = `${content}${attachNote}`;

    // Optimistically append the user message.
    const userMsg: ChatMessageRecord = {
      id: -Date.now(), // temporary negative id
      chatSessionId: activeChatSessionId,
      role: "user",
      content: displayContent,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      createdAt: Date.now(),
    };
    set({
      messages: [...messages, userMsg],
      streamingChatSessionId: activeChatSessionId,
      streaming: { ...get().streaming, [activeChatSessionId]: "" },
      // Start a fresh artifact buffer for this turn.
      pendingArtifacts: { ...get().pendingArtifacts, [activeChatSessionId]: [] },
      error: null,
    });

    // Bump the session to top of the list.
    const active = sessions.find((s) => s.id === activeChatSessionId);
    if (active) {
      set((s) => ({
        sessions: sortSessions([
          active,
          ...s.sessions.filter((sess) => sess.id !== activeChatSessionId),
        ]),
      }));
    }

    await sendChatMessage(
      activeChatSessionId,
      content,
      effort || undefined,
      toolsEnabled,
      codeExecEnabled,
      attachments,
    );
  },

  // Regenerate resends the most recent user message. The backend appends a
  // new assistant turn (history is rebuilt from the DB each send).
  regenerate: async () => {
    const { messages, streamingChatSessionId } = get();
    if (streamingChatSessionId) return; // don't regenerate mid-stream
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    await get().sendMessage(lastUser.content);
  },

  setPreviewArtifact: (previewArtifact) => set({ previewArtifact }),

  cancelStream: async () => {
    const { streamingChatSessionId } = get();
    if (streamingChatSessionId) {
      await cancelChatMessage(streamingChatSessionId);
      // The backend may still fire chat:error or chat:done; our event handler
      // will clear streaming state. But we clear optimistically here too.
      set({ streamingChatSessionId: null });
    }
  },

  saveApiKey: async (provider, key, baseUrl, model) => {
    await setChatApiKey(provider, key, baseUrl, model);
    // Refresh config for the SPECIFIC provider that was just saved, so the
    // API Keys panel sees hasKey: true for the currently selected provider.
    const config = await getChatConfig(provider);
    set({ config });
  },

  clearApiKey: async (provider) => {
    await deleteChatApiKey(provider);
    const config = await getChatConfig(provider);
    set({ config });
  },

  // ---- Event handlers (called by useChatEvents) ----

  onToken: (chatSessionId, token) => {
    set((s) => ({
      streaming: {
        ...s.streaming,
        [chatSessionId]: (s.streaming[chatSessionId] ?? "") + token,
      },
      // Don't change streamingChatSessionId — it stays on the session that
      // sent the message, not the currently viewed session.
    }));
  },

  onDone: async (chatSessionId, inputTokens, outputTokens, costUsd) => {
    // A reply that lands while the user is viewing a different chat marks the
    // finished one unread, so it surfaces in the sidebar.
    if (get().activeChatSessionId !== chatSessionId) {
      await setChatSessionUnread(chatSessionId, true);
    }
    // Clear streaming state for this session.
    set((s) => {
      const nextStreaming = { ...s.streaming };
      delete nextStreaming[chatSessionId];
      return {
        streaming: nextStreaming,
        streamingChatSessionId:
          s.streamingChatSessionId === chatSessionId ? null : s.streamingChatSessionId,
      };
    });

    // Refetch messages from the backend to get the final persisted
    // ChatMessageRecord with usage data.
    const messages = await getChatMessages(chatSessionId);

    // Auto-summarize the chat title after the 1st completed turn (a quick
    // first guess) and refine it after the 3rd, unless the user renamed it.
    const assistantTurns = (messages ?? []).filter((m) => m.role === "assistant").length;
    if (
      !manuallyRenamed.has(chatSessionId) &&
      (assistantTurns === 1 || assistantTurns === 3)
    ) {
      void generateChatTitle(chatSessionId)
        .then((title) => {
          if (!title) return;
          set((s) => ({
            sessions: sortSessions(
              s.sessions.map((sess) =>
                sess.id === chatSessionId ? { ...sess, title } : sess,
              ),
            ),
          }));
        })
        .catch(() => {
          /* best-effort: keep the existing title on failure */
        });
    }

    if (messages) {
      set((s) => {
        // Attribute the artifacts produced during this turn to the assistant
        // message that just completed (the last assistant record).
        const pending = s.pendingArtifacts[chatSessionId] ?? [];
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        const artifactsByMessage =
          pending.length > 0 && lastAssistant
            ? { ...s.artifactsByMessage, [lastAssistant.id]: pending }
            : s.artifactsByMessage;
        const nextPending = { ...s.pendingArtifacts };
        delete nextPending[chatSessionId];
        return {
          messages: s.activeChatSessionId === chatSessionId ? messages : s.messages,
          artifactsByMessage,
          pendingArtifacts: nextPending,
        };
      });
    }

    // Refresh the session list (title may have been updated by the backend).
    const sessions = await listChatSessions();
    if (sessions) set({ sessions });
  },

  onArtifact: ({ chatSessionId, path, filename }) => {
    const artifact = { path, filename };
    // Diagrams / HTML render inline in the chat message, so they must NOT
    // hijack the preview pane; other files still auto-open there.
    const ext = filename.split(".").pop()?.toLowerCase();
    const rendersInline = ext === "html" || ext === "svg";
    set((s) => {
      const existing = s.artifacts[chatSessionId] ?? [];
      const alreadyTracked = existing.some((a) => a.path === path);
      const pending = s.pendingArtifacts[chatSessionId] ?? [];
      const pendingTracked = pending.some((a) => a.path === path);
      return {
        artifacts: alreadyTracked
          ? s.artifacts
          : { ...s.artifacts, [chatSessionId]: [...existing, artifact] },
        // Buffer the artifact so it can be attributed to the assistant message
        // that produced it once that message is persisted (on chat:done).
        pendingArtifacts: pendingTracked
          ? s.pendingArtifacts
          : { ...s.pendingArtifacts, [chatSessionId]: [...pending, artifact] },
        // Auto-open the newly generated file in the preview pane when it
        // belongs to the chat the user is currently viewing — except diagrams/
        // HTML, which render inline in the chat.
        previewArtifact:
          !rendersInline && s.activeChatSessionId === chatSessionId
            ? artifact
            : s.previewArtifact,
      };
    });
    // Refresh the persistent Artifacts sidebar library.
    void useArtifactsStore.getState().load();
  },

  onError: (chatSessionId, message, code) => {
    // Clear streaming state and surface the error for the active session.
    set((s) => {
      const nextStreaming = { ...s.streaming };
      delete nextStreaming[chatSessionId];
      return {
        streaming: nextStreaming,
        streamingChatSessionId:
          s.streamingChatSessionId === chatSessionId ? null : s.streamingChatSessionId,
        error:
          s.activeChatSessionId === chatSessionId ? message : s.error,
      };
    });
  },
}));
