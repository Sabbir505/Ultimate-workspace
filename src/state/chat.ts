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
  getChatConfig,
  getChatMessages,
  listChatSessions,
  sendChatMessage,
  setChatApiKey,
  touchChatSession,
  updateChatSessionModel,
  updateChatSessionTitle,
  type ChatArtifactPayload,
  type ChatConfigPayload,
  type ChatMessageRecord,
  type ChatSession,
} from "../lib/ipc";

/** A file the model generated during a chat, surfaced as a download chip. */
export interface ChatArtifact {
  path: string;
  filename: string;
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
  /** Diagram mode override: "" = model decides, "quick" = Mermaid,
   *  "designed" = html_diagram (generate_diagram tool). */
  diagramMode: "" | "quick" | "designed";
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
  setSessionModel: (chatSessionId: string, model: string) => Promise<void>;
  setEffort: (effort: string) => void;
  setToolsEnabled: (enabled: boolean) => void;
  setCodeExecEnabled: (enabled: boolean) => void;
  setDiagramMode: (mode: "" | "quick" | "designed") => void;
  sendMessage: (content: string) => Promise<void>;
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
  toolsEnabled: false,
  codeExecEnabled: false,
  diagramMode: "" as "" | "quick" | "designed",
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
    set({ activeChatSessionId: chatSessionId, error: null, previewArtifact: null });
    const messages = await getChatMessages(chatSessionId);
    // Only update messages if the user hasn't clicked away to another session
    // while the fetch was in-flight.
    if (get().activeChatSessionId === chatSessionId) {
      set({ messages: messages ?? [], activeChatSessionId: chatSessionId });
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
      // Insert at the top so it appears immediately in the sidebar.
      set((s) => ({
        sessions: [session, ...s.sessions],
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
    await updateChatSessionTitle(chatSessionId, title);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, title } : sess,
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

  setDiagramMode: (diagramMode) => set({ diagramMode }),

  sendMessage: async (content) => {
    const { activeChatSessionId, messages, sessions, effort, toolsEnabled, codeExecEnabled, diagramMode } =
      get();
    if (!activeChatSessionId) return;

    // Optimistically append the user message.
    const userMsg: ChatMessageRecord = {
      id: -Date.now(), // temporary negative id
      chatSessionId: activeChatSessionId,
      role: "user",
      content,
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
        sessions: [active, ...s.sessions.filter((sess) => sess.id !== activeChatSessionId)],
      }));
    }

    await sendChatMessage(
      activeChatSessionId,
      content,
      effort || undefined,
      toolsEnabled,
      codeExecEnabled,
      diagramMode,
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
        // belongs to the chat the user is currently viewing.
        previewArtifact:
          s.activeChatSessionId === chatSessionId ? artifact : s.previewArtifact,
      };
    });
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
