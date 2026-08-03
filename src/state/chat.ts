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
  deleteChatMessage,
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
  type ChatTaskProgressPayload,
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

/** Live progress of a background chat task (download_file / run_shell),
 *  keyed by task id within a chat session. Updated by `chat:task-progress`
 *  events; the card UI renders the latest snapshot. */
export interface ChatTaskProgress {
  taskId: string;
  /** "download" | "shell" */
  kind: string;
  state: "running" | "completed" | "failed" | "cancelled";
  message: string;
  downloaded: number;
  total: number | null;
  speedBps: number;
  destPath: string | null;
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

export interface ChatState {
  loaded: boolean;
  sessions: ChatSession[];
  activeChatSessionId: string | null;
  messages: ChatMessageRecord[];
  streaming: Record<string, string>; // chatSessionId -> accumulating assistant text
  streamingChatSessionId: string | null; // which session is currently streaming
  /** Pre-token status notice per session (chatSessionId -> reason+message),
   *  e.g. a local model cold-starting after a restart. Cleared on the first
   *  token / done / error. */
  chatStatus: Record<string, { reason: string; message: string }>;
  config: ChatConfigPayload | null;
  error: string | null;
  /** Reasoning effort sent with messages ("" = provider default). */
  effort: string;
  /** Per-session extended-thinking toggle. `true` enables the thinking
   *  block on Anthropic / `chat_template_kwargs.enable_thinking` on local
   *  GGUF (Qwen3, DeepSeek-R1); cloud OpenAI ignores it. `false` explicitly
   *  suppresses thinking; `null` falls back to the provider default. */
  thinking: boolean | null;
  /** Context size (tokens) for local GGUF models; 0 = auto (picked from the
   *  GGUF file size). Applied when the llama-server sidecar (re)starts. */
  localCtx: number;
  /** Monotonic counter bumped every time a `context_compacted` chat:status
   *  event lands for the active session. Drives an immediate context-meter
   *  re-poll so the ring ticks down right after compaction instead of
   *  waiting up to one polling interval (2s). */
  compactionRevision: number;
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
  /** Background chat tasks (download_file / run_shell) with live progress,
   *  keyed by chat session id → task id → latest snapshot. */
  tasks: Record<string, Record<string, ChatTaskProgress>>;
  /** True while the full_auto confirmation modal is open for a session. */
  fullAutoConfirmingFor: string | null;
  /** Per-turn owner session id (mobile app's session identifier) keyed by
   *  chatSessionId. Set by `sendMessage` when invoked from the mobile relay
   *  so the chat:token / chat:done / chat:error / chat:status / chat:artifact
   *  / chat:approval-request event listeners can re-broadcast a corresponding
   *  `mobile:session_chat_event` Tauri event. The relay's `start_relay`
   *  listener picks that event up and writes the matching `DesktopMessage`
   *  variant onto the WS that originated the message. Cleared on the
   *  terminal `chat:done` / `chat:error` for the session. */
  ownerSessionByChatId: Record<string, string>;

  // Actions
  loadSessions: () => Promise<void>;
  loadMessages: (chatSessionId: string) => Promise<void>;
  loadConfig: (provider?: string) => Promise<void>;
  selectSession: (chatSessionId: string) => Promise<void>;
  newChat: (provider: string, model: string) => Promise<ChatSession | null>;
  deleteChat: (chatSessionId: string) => Promise<void>;
  /** Delete the active chat session if it has no turns (no persisted
   *  messages). Used when leaving the Chat tab so an untouched new chat
   *  doesn't linger as an empty session — returning to Chat starts fresh
   *  instead of reopening the empty stub (or spawning a duplicate). No-op
   *  when the active chat has any messages, or none is active. Returns the
   *  id of the deleted session (null if nothing was deleted). */
  deleteActiveIfEmpty: () => Promise<string | null>;
  renameChat: (chatSessionId: string, title: string) => Promise<void>;
  /** Star/unstar a chat (pins it to the top of the sidebar). */
  setStarred: (chatSessionId: string, starred: boolean) => Promise<void>;
  /** Mark a chat read/unread (shows an unread dot in the sidebar). */
  setUnread: (chatSessionId: string, unread: boolean) => Promise<void>;
  /** Record the owner session id for a chat session, set when the mobile
   *  relay invokes a session-scoped chat message. Used to re-broadcast chat
   *  events back over the relay's per-session WebSocket. */
  setOwnerSessionId: (chatSessionId: string, ownerSessionId: string) => void;
  /** Look up the owner session id for a chat session (returns undefined if
   *  no mobile relay turn is in flight for this chat session). */
  getOwnerSessionId: (chatSessionId: string) => string | undefined;
  setSessionModel: (chatSessionId: string, model: string) => Promise<void>;
  /** Switch a session's provider (e.g. to "local_gguf" when a local model is
   *  picked from the selector in a cloud session, or back again). */
  setSessionProvider: (chatSessionId: string, provider: string) => Promise<void>;
  setEffort: (effort: string) => void;
  setLocalCtx: (ctx: number) => void;
  setThinking: (thinking: boolean | null) => void;
  setToolsEnabled: (enabled: boolean) => void;
  setCodeExecEnabled: (enabled: boolean) => void;
  sendMessage: (
    content: string,
    attachments?: ChatAttachmentInput[],
    forceResearch?: boolean,
  ) => Promise<void>;
  /** Re-run the last user message to get a fresh assistant response. */
  regenerate: () => Promise<void>;
  /** Delete one message (user or assistant) from the active chat, both in
   *  the local state and the backend. The optimistic just-sent message has
   *  a negative id and the backend's DELETE matches zero rows; we still
   *  drop it locally so the bubble disappears immediately. */
  deleteMessage: (messageId: number) => Promise<void>;
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
  onStatus: (chatSessionId: string, reason: string, message: string) => void;
  onDone: (chatSessionId: string, inputTokens: number | null, outputTokens: number | null, costUsd: number | null) => void;
  onError: (chatSessionId: string, message: string, code: string | null) => void;
  onArtifact: (payload: ChatArtifactPayload) => void;
  onApprovalRequest: (payload: ChatApprovalRequestPayload) => void;
  onApprovalResolved: (payload: ChatApprovalResolvedPayload) => void;
  /** Track a background chat task's progress (downloads / shell runs). */
  onTaskProgress: (payload: ChatTaskProgressPayload) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  loaded: false,
  sessions: [],
  activeChatSessionId: null,
  messages: [],
  streaming: {},
  streamingChatSessionId: null,
  chatStatus: {},
  config: null,
  error: null,
  effort: "",
  // null = no override (provider default). The composer's "brain" button
  // flips this to true/false and resets to null on session change.
  thinking: null,
  localCtx: 0,
  // Bumped on every `chat:status` event with reason="context_compacted" so
  // the context meter re-polls immediately when compaction shortens the
  // history. Without this, the meter can keep showing the pre-compaction
  // count for up to one polling interval (2s), which is long enough for the
  // user to send another turn that re-triggers compaction on the same stale
  // number. ChatView derives a per-session value from chatStatus and feeds
  // it to useContextMeter as `compactionRevision`.
  compactionRevision: 0,
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
  tasks: {},

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
    // Capture the outgoing session's emptiness BEFORE the switch: the
    // `messages` buffer is replaced by the target session's messages below,
    // so the post-switch check would always see a non-empty buffer.
    const outgoingId = get().activeChatSessionId;
    const outgoingEmpty = get().messages.length === 0;
    // Opening a chat clears its unread mark (persisted only if it was set).
    const wasUnread = get().sessions.find((s) => s.id === chatSessionId)?.unread ?? false;
    // Reset the per-session thinking override to the provider default
    // whenever the user switches chats. The "brain" button is per-session.
    set((s) => ({
      activeChatSessionId: chatSessionId,
      error: null,
      previewArtifact: null,
      thinking: null,
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
    // Switching away from a brand-new chat that never received a message
    // (e.g. the auto-started default chat) should not leave an empty session
    // row behind in the sidebar. deleteChat() tombstones it, so the relist
    // above can't resurrect it.
    if (outgoingId && outgoingId !== chatSessionId && outgoingEmpty) {
      void get().deleteChat(outgoingId);
    }
  },

  newChat: async (provider, model) => {
    // Reuse the active session when it already has no turns — clicking "New
    // Chat" while sitting in a fresh empty chat should not spawn yet another
    // empty session. If the caller wants a different provider/model than the
    // empty session already has (e.g. Settings → "Use this model"), update it
    // in place rather than creating a duplicate.
    const { activeChatSessionId, messages, sessions } = get();
    const active = activeChatSessionId
      ? sessions.find((s) => s.id === activeChatSessionId)
      : undefined;
    if (active && messages.length === 0) {
      if (provider && active.provider !== provider) {
        await updateChatSessionProvider(active.id, provider);
      }
      if (model && active.model !== model) {
        await updateChatSessionModel(active.id, model);
      }
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === active.id
            ? {
                ...sess,
                provider: provider || sess.provider,
                model: model || sess.model,
              }
            : sess,
        ),
        error: null,
      }));
      return active;
    }

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

  deleteActiveIfEmpty: async () => {
    const { activeChatSessionId, messages } = get();
    if (!activeChatSessionId) return null;
    // Only delete when there are genuinely no persisted messages — a chat the
    // user typed into (even if the turn errored before an assistant reply)
    // keeps its user message and should persist.
    if (messages.length > 0) return null;
    await get().deleteChat(activeChatSessionId);
    return activeChatSessionId;
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

  /** Toggle the extended-thinking flag for the next message. `null` clears
   *  the override so the provider default is used. */
  setThinking: (thinking) => set({ thinking }),

  setToolsEnabled: (toolsEnabled) =>
    set(toolsEnabled ? { toolsEnabled } : { toolsEnabled, codeExecEnabled: false }),

  // Enabling code execution implies tools are on (the tool loop must run).
  setCodeExecEnabled: (codeExecEnabled) =>
    set(codeExecEnabled ? { codeExecEnabled, toolsEnabled: true } : { codeExecEnabled }),

  sendMessage: async (content, attachments, forceResearch) => {
    const {
      activeChatSessionId,
      messages,
      sessions,
      effort,
      toolsEnabled,
      codeExecEnabled,
      thinking,
    } = get();
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
      chatStatus: { ...get().chatStatus, [activeChatSessionId]: { reason: "thinking", message: "" } },
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
      thinking === null ? undefined : thinking,
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

  // Delete a single chat message by id. Optimistically removes the bubble
  // from the active session's message list, then asks the backend to
  // confirm. Persisted artifacts attributed to the message are detached
  // server-side (not deleted) so a user wiping a turn doesn't lose their
  // generated files — the artifact library still lists them.
  deleteMessage: async (messageId) => {
    set((s) => {
      // Drop the bubble from the local list. Negative ids are optimistic
      // just-sent bubbles that never round-tripped to the DB, so a missing
      // match here is fine — the local filter simply doesn't remove anything.
      const nextMessages = s.messages.filter((m) => m.id !== messageId);
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
      console.warn("deleteMessage failed", err);
    }
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

  setOwnerSessionId: (chatSessionId, ownerSessionId) =>
    set((s) => ({
      ownerSessionByChatId: { ...s.ownerSessionByChatId, [chatSessionId]: ownerSessionId },
    })),

  getOwnerSessionId: (chatSessionId) => get().ownerSessionByChatId[chatSessionId],

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
    set((s) => {
      const nextStatus = { ...s.chatStatus };
      delete nextStatus[chatSessionId];
      return {
        streaming: {
          ...s.streaming,
          [chatSessionId]: (s.streaming[chatSessionId] ?? "") + token,
        },
        // First token arrived — drop any pre-token status notice (e.g. the
        // "local model loading" line) since the wait is over.
        chatStatus: nextStatus,
        // Don't change streamingChatSessionId — it stays on the session that
        // sent the message, not the currently viewed session.
      };
    });
  },

  onStatus: (chatSessionId, reason, message) => {
    set((s) => {
      // An empty reason is the backend's "clear this notice" signal — used
      // when compaction was a no-op or errored so the "Compacting earlier
      // context…" spinner doesn't linger past the chat:done.
      if (!reason) {
        const next = { ...s.chatStatus };
        delete next[chatSessionId];
        return { chatStatus: next };
      }
      // A compaction that actually shortened the history triggers an
      // immediate re-poll of the context meter so the ring ticks down
      // right away. We bump `compactionRevision` only for the active
      // session — other sessions' compactions shouldn't churn this.
      const compactionBump =
        reason === "context_compacted" && s.activeChatSessionId === chatSessionId
          ? { compactionRevision: s.compactionRevision + 1 }
          : {};
      return {
        chatStatus: { ...s.chatStatus, [chatSessionId]: { reason, message } },
        ...compactionBump,
      };
    });
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
      const nextStatus = { ...s.chatStatus };
      delete nextStatus[chatSessionId];
      return {
        streaming: nextStreaming,
        chatStatus: nextStatus,
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
      const nextStatus = { ...s.chatStatus };
      delete nextStatus[chatSessionId];
      return {
        streaming: nextStreaming,
        chatStatus: nextStatus,
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

  onTaskProgress: ({ chatSessionId, taskId, kind, state, message, downloaded, total, speedBps, destPath }) => {
    set((s) => {
      const sessionTasks = { ...(s.tasks[chatSessionId] ?? {}) };
      sessionTasks[taskId] = { taskId, kind, state, message, downloaded, total, speedBps, destPath };
      return { tasks: { ...s.tasks, [chatSessionId]: sessionTasks } };
    });
  },
}));
