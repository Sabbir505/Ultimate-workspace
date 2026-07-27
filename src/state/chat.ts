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
  resolveToolAction,
  sendChatMessage,
  setChatApiKey,
  setChatSessionStarred,
  setChatSessionUnread,
  touchChatSession,
  updateChatSessionModel,
  updateChatSessionPermissionMode,
  updateChatSessionProvider,
  updateChatSessionTitle,
  updateChatSessionWatchMode,
  type ChatApprovalRequestPayload,
  type ChatApprovalResolvedPayload,
  type ChatAttachmentInput,
  type ChatArtifactPayload,
  type ChatConfigPayload,
  type ChatMessageRecord,
  type ChatSession,
} from "../lib/ipc";
import { useArtifactsStore } from "./artifacts";

/** Sessions the user manually renamed — never auto-summarize their title.
 *  Capped at 1000 entries to prevent unbounded growth across long sessions. */
const manuallyRenamed = new Set<string>();

/** Sessions deleted during this app run. Background session-list refreshes
 *  (`selectSession`'s touch-then-relist, `onDone`'s relist) fetch the list
 *  over IPC and can race the user's delete: the fetch starts before the
 *  DELETE commits but its payload is applied after — resurrecting the deleted
 *  chat in the sidebar. Every refresh path filters this tombstone set so a
 *  stale payload can never bring a deleted session back.
 *  Capped at 1000 entries to prevent unbounded growth. */
const deletedSessions = new Set<string>();

/** Session list with tombstoned (deleted-this-run) sessions removed. */
function withoutDeleted(sessions: ChatSession[]): ChatSession[] {
  return sessions.filter((s) => !deletedSessions.has(s.id));
}

/** Cap a Set to `max` entries by evicting oldest (iteration-order) entries. */
function capSet<T>(set: Set<T>, max: number) {
  if (set.size > max) {
    let toDelete = set.size - max;
    for (const entry of set) {
      if (toDelete <= 0) break;
      set.delete(entry);
      toDelete--;
    }
  }
}
const SET_CAP = 1000;

function markDeleted(sid: string) {
  deletedSessions.add(sid);
  capSet(deletedSessions, SET_CAP);
}

function markManuallyRenamed(sid: string) {
  manuallyRenamed.add(sid);
  capSet(manuallyRenamed, SET_CAP);
}

/** The four filesystem permission postures a chat session can be in. Mirrors
 *  `chat::permission::PermissionMode` in the Rust backend. */
export type PermissionMode = "read_only" | "manual" | "auto_edit" | "full_auto";

/** Default posture for every new chat session (per the task spec). */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "manual";

/** Watch-mode pacing for browser actions. "on" | "off". */
export type WatchMode = "on" | "off";

/** A pending per-action filesystem-tool approval card, one per chat session. */
export interface PendingApproval {
  pendingId: string;
  tool: string;
  summary: string;
  args: unknown;
}

/** Sessions in which the user has already confirmed the full_auto modal this
 *  session — the one-time confirmation isn't re-shown within the same session.
 *  (The mode itself persists in the DB; this set only suppresses re-prompting.) */
const fullAutoConfirmed = new Set<string>();

function markFullAutoConfirmed(sid: string) {
  fullAutoConfirmed.add(sid);
  capSet(fullAutoConfirmed, SET_CAP);
}

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
  /** Context size (tokens) for local GGUF models; 0 = auto (picked from the
   *  GGUF file size). Applied when the llama-server sidecar (re)starts. */
  localCtx: number;
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
  /** Pending per-action filesystem-tool approvals, keyed by chat session. A
   *  session has at most one card at a time (the tool loop pauses on it). */
  pendingApprovals: Record<string, PendingApproval>;
  /** True while the full_auto confirmation modal is open for a session. */
  fullAutoConfirmingFor: string | null;

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
  /** Switch a session's provider (e.g. to "local_gguf" when a local model is
   *  picked from the selector in a cloud session, or back again). */
  setSessionProvider: (chatSessionId: string, provider: string) => Promise<void>;
  setEffort: (effort: string) => void;
  setLocalCtx: (ctx: number) => void;
  setToolsEnabled: (enabled: boolean) => void;
  setCodeExecEnabled: (enabled: boolean) => void;
  sendMessage: (
    content: string,
    attachments?: ChatAttachmentInput[],
    forceResearch?: boolean,
  ) => Promise<void>;
  /** Re-run the last user message to get a fresh assistant response. */
  regenerate: () => Promise<void>;
  cancelStream: () => Promise<void>;
  /** Open/close the artifact preview pane. */
  setPreviewArtifact: (artifact: ChatArtifact | null) => void;
  /** Set the active session's filesystem permission posture. Switching INTO
   *  `full_auto` first opens a one-time confirmation modal (per session);
   *  switching OUT of it applies immediately. Returns true if applied, false
   *  if a confirmation modal was opened instead. */
  setSessionPermissionMode: (chatSessionId: string, mode: PermissionMode) => Promise<boolean>;
  /** Set a session's watch-mode pacing override. on/off = per-session override;
   *  null clears the override so the session inherits the global setting. */
  setSessionWatchMode: (chatSessionId: string, mode: WatchMode | null) => Promise<void>;
  /** Confirm the full_auto modal — applies the mode and records that this
   *  session has confirmed, so it isn't re-prompted. */
  confirmFullAuto: (chatSessionId: string) => Promise<void>;
  /** Dismiss the full_auto modal without applying (mode unchanged). */
  cancelFullAutoConfirm: () => void;
  /** Resolve a pending per-action approval card (Approve/Deny). Sends the
   *  decision to the backend; the paused tool loop resumes. */
  resolveApproval: (chatSessionId: string, approved: boolean) => Promise<void>;
  saveApiKey: (provider: string, key: string, baseUrl?: string, model?: string) => Promise<void>;
  clearApiKey: (provider: string) => Promise<void>;

  // Called by the event hook (useChatEvents) — not meant for direct component use.
  onToken: (chatSessionId: string, token: string) => void;
  onDone: (chatSessionId: string, inputTokens: number | null, outputTokens: number | null, costUsd: number | null) => void;
  onError: (chatSessionId: string, message: string, code: string | null) => void;
  onArtifact: (payload: ChatArtifactPayload) => void;
  onApprovalRequest: (payload: ChatApprovalRequestPayload) => void;
  onApprovalResolved: (payload: ChatApprovalResolvedPayload) => void;
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
  localCtx: 0,
  // Tools are on by default so the model itself decides when to web-search,
  // generate a file/document/diagram, fetch a URL or run code — the user no
  // longer has to arm them manually before each relevant request.
  toolsEnabled: true,
  codeExecEnabled: true,
  artifacts: {},
  artifactsByMessage: {},
  pendingArtifacts: {},
  previewArtifact: null,
  pendingApprovals: {},
  fullAutoConfirmingFor: null,

  loadSessions: async () => {
    const sessions = await listChatSessions();
    set({ loaded: true, sessions: withoutDeleted(sessions ?? []) });
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
    // Ignore selects for sessions deleted this run (stale sidebar row, in-
    // flight click). The tombstone is the source of truth until restart.
    if (deletedSessions.has(chatSessionId)) return;
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
      if (sessions) set({ sessions: withoutDeleted(sessions) });
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
    // Tombstone this session for the rest of the app run so background
    // session-list refreshes (selectSession's touch-then-relist, onDone's
    // relist) can't resurrect it via a stale IPC payload that raced the
    // DELETE. Cleared on a full app restart.
    markDeleted(chatSessionId);
    set((s) => {
      // Drop any per-session state too, so switching sessions never briefly
      // shows this chat's old messages/artifacts.
      const nextStreaming = { ...s.streaming };
      delete nextStreaming[chatSessionId];
      const nextArtifacts = { ...s.artifacts };
      delete nextArtifacts[chatSessionId];
      const nextPendingArtifacts = { ...s.pendingArtifacts };
      delete nextPendingArtifacts[chatSessionId];
      const nextPendingApprovals = { ...s.pendingApprovals };
      delete nextPendingApprovals[chatSessionId];
      return {
        sessions: s.sessions.filter((sess) => sess.id !== chatSessionId),
        activeChatSessionId: s.activeChatSessionId === chatSessionId ? null : s.activeChatSessionId,
        messages: s.activeChatSessionId === chatSessionId ? [] : s.messages,
        streaming: nextStreaming,
        streamingChatSessionId:
          s.streamingChatSessionId === chatSessionId ? null : s.streamingChatSessionId,
        artifacts: nextArtifacts,
        pendingArtifacts: nextPendingArtifacts,
        pendingApprovals: nextPendingApprovals,
      };
    });
  },

  renameChat: async (chatSessionId, title) => {
    markManuallyRenamed(chatSessionId);
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

  setSessionProvider: async (chatSessionId, provider) => {
    await updateChatSessionProvider(chatSessionId, provider);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, provider } : sess,
      ),
    }));
  },

  setEffort: (effort) => set({ effort }),

  setLocalCtx: (localCtx) => set({ localCtx }),

  setToolsEnabled: (toolsEnabled) =>
    set(toolsEnabled ? { toolsEnabled } : { toolsEnabled, codeExecEnabled: false }),

  // Enabling code execution implies tools are on (the tool loop must run).
  setCodeExecEnabled: (codeExecEnabled) =>
    set(codeExecEnabled ? { codeExecEnabled, toolsEnabled: true } : { codeExecEnabled }),

  sendMessage: async (content, attachments, forceResearch) => {
    const { activeChatSessionId, messages, sessions, effort, toolsEnabled, codeExecEnabled } =
      get();
    if (!activeChatSessionId) return;
    if (deletedSessions.has(activeChatSessionId)) return;
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
      // Carry the live attachments so the bubble can render real image
      // thumbnails before the backend persists (persisted messages parse
      // attachment markers out of `content` instead).
      attachments: attachments ?? undefined,
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
      forceResearch,
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

  setSessionPermissionMode: async (chatSessionId, mode) => {
    // Switching INTO full_auto opens a one-time confirmation modal first
    // (per session — `fullAutoConfirmed` suppresses re-prompting within the
    // same session). All other transitions apply immediately.
    if (mode === "full_auto" && !fullAutoConfirmed.has(chatSessionId)) {
      set({ fullAutoConfirmingFor: chatSessionId });
      return false;
    }
    await updateChatSessionPermissionMode(chatSessionId, mode);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, permissionMode: mode } : sess,
      ),
      fullAutoConfirmingFor: null,
    }));
    return true;
  },

  setSessionWatchMode: async (chatSessionId, mode) => {
    await updateChatSessionWatchMode(chatSessionId, mode);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, watchMode: mode } : sess,
      ),
    }));
  },

  confirmFullAuto: async (chatSessionId) => {
    markFullAutoConfirmed(chatSessionId);
    await updateChatSessionPermissionMode(chatSessionId, "full_auto");
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, permissionMode: "full_auto" } : sess,
      ),
      fullAutoConfirmingFor: null,
    }));
  },

  cancelFullAutoConfirm: () => set({ fullAutoConfirmingFor: null }),

  resolveApproval: async (chatSessionId, approved) => {
    const pending = get().pendingApprovals[chatSessionId];
    if (!pending) return;
    // Optimistically remove the card; the backend's `chat:approval-resolved`
    // would also clear it, but this avoids a flicker if the event is slow.
    set((s) => {
      const next = { ...s.pendingApprovals };
      delete next[chatSessionId];
      return { pendingApprovals: next };
    });
    await resolveToolAction(pending.pendingId, approved);
  },

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
    if (sessions) set({ sessions: withoutDeleted(sessions) });
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

  onApprovalRequest: ({ chatSessionId, pendingId, tool, summary, args }) => {
    // Surface the per-action approval card for this session. Only one card is
    // shown at a time (the tool loop pauses on it); a new request replaces any
    // stale one (the prior would already have been resolved or cancelled).
    set((s) => ({
      pendingApprovals: {
        ...s.pendingApprovals,
        [chatSessionId]: { pendingId, tool, summary, args },
      },
    }));
  },

  onApprovalResolved: ({ chatSessionId }) => {
    // The backend resumed the paused tool loop — dismiss the card.
    set((s) => {
      const next = { ...s.pendingApprovals };
      delete next[chatSessionId];
      return { pendingApprovals: next };
    });
  },
}));
