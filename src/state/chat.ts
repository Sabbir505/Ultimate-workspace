// Chat store: sessions, messages, live streaming state, config, and all actions.
// Mirrors the style of src/state/projects.ts and src/state/settings.ts.
//
// IMPORTANT: all streaming updates are keyed by chatSessionId, NOT by
// "active session", so streams complete correctly even if the user switches
// to a different chat in the sidebar.
import { create } from "zustand";
import {
  cancelAgentChatMessage,
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
  sendAgentChatMessage,
  sendChatMessage,
  setChatApiKey,
  setChatSessionStarred,
  setChatSessionUnread,
  touchChatSession,
  updateChatSessionAgent,
  updateChatSessionModel,
  updateChatSessionProvider,
  updateChatSessionTitle,
  updateChatSessionWatchMode,
  type ChatAttachmentInput,
  type ChatArtifactPayload,
  type ChatConfigPayload,
  type ChatMessageRecord,
  type ChatSession,
  type ChatTaskProgressPayload,
} from "../lib/ipc";
import { generateSessionTitle } from "../lib/sessionTitle";
import { useArtifactsStore } from "./artifacts";
import { useProjectsStore } from "./projects";

/** Sessions the user manually renamed — never auto-summarize their title.
 *  Capped at 1000 entries to prevent unbounded growth across long sessions.
 *  Uses a Map (insertion-ordered) so the OLDEST entry is evicted when the cap
 *  is hit — protecting the most-recently-touched sessions from premature
 *  eviction that would re-enable auto-titling for a freshly renamed chat. */
const manuallyRenamed = new Map<string, number>();

/** Sessions deleted during this app run. Background session-list refreshes
 *  (`selectSession`'s touch-then-relist, `onDone`'s relist) fetch the list
 *  over IPC and can race the user's delete: the fetch starts before the
 *  DELETE commits but its payload is applied after — resurrecting the deleted
 *  chat in the sidebar. Every refresh path filters this tombstone set so a
 *  stale payload can never bring a deleted session back.
 *  Capped at 1000 entries to prevent unbounded growth. Using a Map (rather
 *  than a Set) lets us cap by insertion order so a recently-tombstoned
 *  session is never silently dropped from the filter (which would let the
 *  very race condition this set exists to prevent happen again). */
const deletedSessions = new Map<string, number>();

/** Session list with tombstoned (deleted-this-run) sessions removed. */
function withoutDeleted(sessions: ChatSession[]): ChatSession[] {
  return sessions.filter((s) => !deletedSessions.has(s.id));
}

/** Cap a Map to `max` entries by evicting oldest (insertion-order) entries.
 *  The map's iteration order is insertion order, so the first key seen is
 *  the oldest — which is the one we drop. This protects the most-recently
 *  added entries from being silently lost. */
function capMap<K>(map: Map<K, number>, max: number) {
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}
const SET_CAP = 1000;

function markDeleted(sid: string) {
  deletedSessions.set(sid, Date.now());
  capMap(deletedSessions, SET_CAP);
}

function markManuallyRenamed(sid: string) {
  manuallyRenamed.set(sid, Date.now());
  capMap(manuallyRenamed, SET_CAP);
}

/** Watch-mode pacing for browser actions. "on" | "off". */
export type WatchMode = "on" | "off";

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

/** A file the model generated during a chat, surfaced as a download chip. */
export interface ChatArtifact {
  path: string;
  filename: string;
  /** Inline (non-file) live preview payload — e.g. a ```jsx / ```tsx code
   *  block from an assistant message. When set, the preview pane renders it
   *  directly (live React preview) instead of reading `path` from disk. */
  inline?: { kind: "jsx" | "tsx"; code: string };
}

/** A message stacked while a turn is running (composer queue, FIFO).
 *  Drained one-by-one when the session's stream finishes. */
export interface QueuedChatMessage {
  id: number;
  content: string;
  attachments?: ChatAttachmentInput[];
  forceResearch?: boolean;
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
  /** Artifacts open in the Canvas tab, shown like browser tabs. */
  previewArtifacts: ChatArtifact[];
  /** Path of the focused Canvas tab (null = no tab focused). */
  activePreviewPath: string | null;
  /** Background chat tasks (download_file / run_shell) with live progress,
   *  keyed by chat session id → task id → latest snapshot. */
  tasks: Record<string, Record<string, ChatTaskProgress>>;
  /** Per-turn owner session id (mobile app's session identifier) keyed by
   *  chatSessionId. Set by `sendMessage` when invoked from the mobile relay
   *  so the chat:token / chat:done / chat:error / chat:status / chat:artifact
   *  / chat:approval-request event listeners can re-broadcast a corresponding
   *  `mobile:session_chat_event` Tauri event. The relay's `start_relay`
   *  listener picks that event up and writes the matching `DesktopMessage`
   *  variant onto the WS that originated the message. Cleared on the
   *  terminal `chat:done` / `chat:error` for the session. */
  ownerSessionByChatId: Record<string, string>;
  /** Custom working folder per chat session, chosen via the composer's "+"
   *  folder picker. Overrides the selected project's path as the harness
   *  send's cwd and is granted as an extra fs_root on the built-in path.
   *  In-memory only (a session-scoped convenience, not a persisted setting). */
  cwdOverrides: Record<string, string>;
  /** The project each chat session is bound to, recorded when the user sends
   *  a message or switches projects while viewing that chat. The composer
   *  notch and the working directory sent to the backend follow this binding
   *  instead of the global selection, so switching between chats shows each
   *  chat's own project. In-memory only (same scope as cwdOverrides). */
  sessionProjects: Record<string, string>;
  /** Messages queued while a turn is running, per chat session, FIFO. Sent
   *  one-by-one by `drainQueue` when the session's stream finishes. */
  messageQueue: Record<string, QueuedChatMessage[]>;

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
  /** Set a session's agent selection ("builtin" | "local" | "harness:<id>" |
   *  null). Persisted per chat session; drives the composer's locked/unlocked
   *  model chip. */
  setSessionAgent: (chatSessionId: string, agent: string | null) => Promise<void>;
  setEffort: (effort: string) => void;
  setLocalCtx: (ctx: number) => void;
  setThinking: (thinking: boolean | null) => void;
  setToolsEnabled: (enabled: boolean) => void;
  setCodeExecEnabled: (enabled: boolean) => void;
  /** Set/clear a session's custom working folder (null clears, reverting to
   *  the selected project's path). */
  setCwdOverride: (chatSessionId: string, path: string | null) => void;
  /** Fully unbind a session from its project: drop the per-chat project
   *  binding AND any custom-folder override, so the composer notch disappears
   *  and the working directory falls back to the global selection. */
  unbindProject: (chatSessionId: string) => void;
  /** Drop one queued message from a session's FIFO queue (composer "×"). */
  removeQueuedMessage: (chatSessionId: string, id: number) => void;
  /** Send the oldest queued message for a session. No-op unless the session
   *  is active and no stream is running (sendMessage targets the active
   *  session; queued items for background sessions wait for selectSession). */
  drainQueue: (chatSessionId: string) => void;
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
  /** Open an artifact in the Canvas tab, or focus its tab if already open.
   *  `null` closes all Canvas tabs. */
  setPreviewArtifact: (artifact: ChatArtifact | null) => void;
  /** Close one Canvas tab (default: the focused one). Closing the focused tab
   *  activates its neighbor. */
  closePreviewArtifact: (path?: string) => void;
  /** Set a session's watch-mode pacing override. on/off = per-session override;
   *  null clears the override so the session inherits the global setting. */
  setSessionWatchMode: (chatSessionId: string, mode: WatchMode | null) => Promise<void>;
  saveApiKey: (provider: string, key: string, baseUrl?: string, model?: string) => Promise<void>;
  clearApiKey: (provider: string) => Promise<void>;

  // Called by the event hook (useChatEvents) — not meant for direct component use.
  onToken: (chatSessionId: string, token: string) => void;
  onStatus: (chatSessionId: string, reason: string, message: string) => void;
  onDone: (chatSessionId: string, inputTokens: number | null, outputTokens: number | null, costUsd: number | null) => void;
  onError: (chatSessionId: string, message: string, code: string | null) => void;
  onArtifact: (payload: ChatArtifactPayload) => void;
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
  previewArtifacts: [],
  activePreviewPath: null,
  tasks: {},
  ownerSessionByChatId: {},
  cwdOverrides: {},
  sessionProjects: {},
  messageQueue: {},

  setCwdOverride: (chatSessionId, path) =>
    set((s) => {
      const next = { ...s.cwdOverrides };
      if (path) next[chatSessionId] = path;
      else delete next[chatSessionId];
      return { cwdOverrides: next };
    }),

  unbindProject: (chatSessionId) =>
    set((s) => {
      const sessionProjects = { ...s.sessionProjects };
      delete sessionProjects[chatSessionId];
      const cwdOverrides = { ...s.cwdOverrides };
      delete cwdOverrides[chatSessionId];
      return { sessionProjects, cwdOverrides };
    }),

  removeQueuedMessage: (chatSessionId, id) =>
    set((s) => ({
      messageQueue: {
        ...s.messageQueue,
        [chatSessionId]: (s.messageQueue[chatSessionId] ?? []).filter((m) => m.id !== id),
      },
    })),

  drainQueue: (chatSessionId) => {
    // sendMessage targets the ACTIVE session, so a background session's queue
    // waits until the user opens it (selectSession calls drainQueue too).
    if (get().activeChatSessionId !== chatSessionId) return;
    if (get().streamingChatSessionId) return;
    const [next, ...rest] = get().messageQueue[chatSessionId] ?? [];
    if (!next) return;
    set((s) => ({ messageQueue: { ...s.messageQueue, [chatSessionId]: rest } }));
    void get().sendMessage(next.content, next.attachments, next.forceResearch);
  },

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
      previewArtifacts: [],
      activePreviewPath: null,
      thinking: null,
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId && sess.unread ? { ...sess, unread: false } : sess,
      ),
    }));
    if (wasUnread) void setChatSessionUnread(chatSessionId, false);
    // Follow the chat's project binding: switching to a chat that was working
    // on a different project moves the global selection (and with it the
    // composer notch, Files tab, and the working directory) to that project.
    // Without this every chat showed whatever project was clicked last.
    const boundProjectId = get().sessionProjects[chatSessionId];
    if (boundProjectId) {
      const ps = useProjectsStore.getState();
      if (ps.selectedProjectId !== boundProjectId && ps.projectById(boundProjectId)) {
        ps.selectProject(boundProjectId);
      }
    }
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
    // Opening a session that has messages stacked in its queue (queued while
    // it was in the background) starts draining them now that it's active.
    get().drainQueue(chatSessionId);
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
    // Kill any running harness CLI process for this session before removing
    // the DB row. Without this the persistent claude process (or a mid-turn
    // kimi/opencode child) keeps running and emitting chat:token events for
    // a session that no longer exists.
    const session = get().sessions.find((s) => s.id === chatSessionId);
    if (session?.agent?.startsWith("harness:")) {
      try { await cancelAgentChatMessage(chatSessionId); } catch { /* best-effort */ }
    }
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
      return {
        sessions: s.sessions.filter((sess) => sess.id !== chatSessionId),
        activeChatSessionId: s.activeChatSessionId === chatSessionId ? null : s.activeChatSessionId,
        messages: s.activeChatSessionId === chatSessionId ? [] : s.messages,
        streaming: nextStreaming,
        streamingChatSessionId:
          s.streamingChatSessionId === chatSessionId ? null : s.streamingChatSessionId,
        artifacts: nextArtifacts,
        pendingArtifacts: nextPendingArtifacts,
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
    // For a harness session, a model change requires killing the running CLI
    // process: claude_code is spawned with `--model`, so the old process is
    // bound to the old model and must be respawned (the next send does that
    // via the spawned_model check, but killing here stops any in-flight work
    // immediately instead of letting it finish on the old model).
    const session = get().sessions.find((s) => s.id === chatSessionId);
    if (session?.agent?.startsWith("harness:") && session.model !== model) {
      try { await cancelAgentChatMessage(chatSessionId); } catch { /* best-effort */ }
    }
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

  setSessionAgent: async (chatSessionId, agent) => {
    // Switching away from a harness agent, or switching between different
    // harnesses, must kill the running CLI process — otherwise it keeps
    // executing and emitting tokens for this session.
    const prev = get().sessions.find((s) => s.id === chatSessionId);
    if (prev?.agent?.startsWith("harness:") && prev.agent !== agent) {
      try { await cancelAgentChatMessage(chatSessionId); } catch { /* best-effort */ }
    }
    await updateChatSessionAgent(chatSessionId, agent);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, agent } : sess,
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
    // A turn is already running for this session: stack the message above
    // the composer instead of dropping it. drainQueue sends the queue FIFO
    // when the current turn finishes (onDone / onError / cancelStream).
    if (get().streamingChatSessionId === activeChatSessionId) {
      const queued: QueuedChatMessage = {
        id: Date.now(),
        content,
        attachments: attachments ?? undefined,
        forceResearch: forceResearch || undefined,
      };
      set((s) => ({
        messageQueue: {
          ...s.messageQueue,
          [activeChatSessionId]: [...(s.messageQueue[activeChatSessionId] ?? []), queued],
        },
      }));
      return;
    }

    // Client-side fallback title. The LLM auto-titling in onDone
    // (generateChatTitle) silently no-ops for harness-backed sessions (no
    // stored API key) and other failure modes, leaving "Untitled Chat"
    // forever. Derive a deterministic title from the first user message
    // instead. Persisted via the same backend command renameChat uses, but
    // WITHOUT markManuallyRenamed — this is an auto title, so the turn-3
    // generateChatTitle refinement may still improve it later.
    const untitled = sessions.find((s) => s.id === activeChatSessionId);
    if (untitled && !(untitled.title ?? "").trim()) {
      const derived = generateSessionTitle(content);
      if (derived) {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === activeChatSessionId ? { ...sess, title: derived } : sess,
          ),
        }));
        void updateChatSessionTitle(activeChatSessionId, derived).catch(() => {
          /* best-effort: the local title above still stands for this run */
        });
      }
    }

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

    // Bump the session to top of the list. Re-read from state rather than
    // using the `sessions` snapshot — the derived-title set() above may
    // already have updated this session's entry.
    const active = get().sessions.find((s) => s.id === activeChatSessionId);
    if (active) {
      set((s) => ({
        sessions: sortSessions([
          active,
          ...s.sessions.filter((sess) => sess.id !== activeChatSessionId),
        ]),
      }));
    }

    const session = get().sessions.find((s) => s.id === activeChatSessionId);

    // Bind this chat to the currently-selected project (first send, or after
    // the user deliberately switched projects while viewing it). The binding
    // drives the composer notch and the working directory on later visits.
    const projectsState = useProjectsStore.getState();
    if (
      projectsState.selectedProjectId &&
      get().sessionProjects[activeChatSessionId] !== projectsState.selectedProjectId
    ) {
      const pid = projectsState.selectedProjectId;
      set((s) => ({ sessionProjects: { ...s.sessionProjects, [activeChatSessionId]: pid } }));
    }
    // Working folder resolution, shared by both send paths: a custom folder
    // from the composer "+" picker wins, then the chat's bound project,
    // then the global selection.
    const boundProject = projectsState.projectById(
      get().sessionProjects[activeChatSessionId] ?? projectsState.selectedProjectId,
    );
    const workingDir = get().cwdOverrides[activeChatSessionId] ?? boundProject?.path;

    // CLI harness agents (Phase 2): the turn goes to the headless CLI process
    // (agent_sessions.rs) instead of the built-in provider path. Same chat:*
    // events come back, so streaming/done handling above works unchanged.
    if (session?.agent?.startsWith("harness:")) {
      const projects = useProjectsStore.getState();
      const cwd = workingDir;
      try {
        await sendAgentChatMessage(
          activeChatSessionId,
          content,
          session.agent.slice("harness:".length),
          session.model || undefined,
          cwd,
          // Feeds the conduit-browser MCP registration (CONDUIT_PROJECT_ID) so
          // browser auto-open is scoped to the selected project.
          projects.selectedProjectId ?? undefined,
        );
      } catch (err) {
        console.error('[harness] sendAgentChatMessage failed:', err);
        // Delete the keys (not `undefined` assignments — those keep the key
        // present, so `sid in streaming` stays true and the sidebar "Working…"
        // dot never clears; it also breaks the Record<string, string> type).
        const streaming = { ...get().streaming };
        const chatStatus = { ...get().chatStatus };
        delete streaming[activeChatSessionId];
        delete chatStatus[activeChatSessionId];
        set({
          streamingChatSessionId: null,
          streaming,
          chatStatus,
          error: String(err),
        });
        return;
      }
      return;
    }

    // The built-in path can reject synchronously (unknown session/provider,
    // local-model warmup failure) before any chat:error event exists. Without
    // a catch the session wedges: streamingChatSessionId stays set, the
    // double-send guard blocks every later send, and the user stares at a
    // permanent "thinking" spinner with no error. Mirror the harness reset.
    try {
      await sendChatMessage(
        activeChatSessionId,
        content,
        effort || undefined,
        toolsEnabled,
        codeExecEnabled,
        attachments,
        forceResearch,
        thinking === null ? undefined : thinking,
        // Working folder for this chat (custom folder → bound project →
        // global selection, resolved above). The backend grants it as an
        // fs_root AND names it in the system prompt so the model knows
        // which directory it is working in.
        workingDir,
      );
    } catch (err) {
      console.error('[chat] sendChatMessage failed:', err);
      const streaming = { ...get().streaming };
      const chatStatus = { ...get().chatStatus };
      delete streaming[activeChatSessionId];
      delete chatStatus[activeChatSessionId];
      set({
        streamingChatSessionId: null,
        streaming,
        chatStatus,
        error: String(err),
      });
    }
  },

  // Regenerate resends the most recent user message. The backend appends a
  // new assistant turn (history is rebuilt from the DB each send).
  //
  // IMPORTANT: the bubble's `content` may contain "[Attached image: …]" /
  // "[Attached file: …]" markers that the UI injected for display purposes
  // only. Re-sending those markers would let the model misinterpret them as
  // fresh attachments and try to process nonexistent files. Strip them so
  // the regenerated turn mirrors what the BACKEND actually persisted.
  regenerate: async () => {
    const { messages, streamingChatSessionId } = get();
    if (streamingChatSessionId) return; // don't regenerate mid-stream
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const clean = lastUser.content.replace(/\n\n\[Attached (?:image|file)[^\]]*\]/g, "");
    await get().sendMessage(clean);
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
      // Rollback: the backend rejected the delete (e.g. DB error, or the row
      // was already gone via another path). Re-fetch so the local list
      // matches persisted state instead of staying out of sync.
      console.warn("deleteMessage failed", err);
      const activeChatSessionId = get().activeChatSessionId;
      if (activeChatSessionId) {
        try {
          const msgs = await getChatMessages(activeChatSessionId);
          set({ messages: msgs ?? [] });
        } catch {
          /* best-effort rollback */
        }
      }
    }
  },

  setPreviewArtifact: (artifact) => {
    // null closes ALL Canvas tabs (the pane's empty state shows).
    if (!artifact) {
      set({ previewArtifacts: [], activePreviewPath: null });
      return;
    }
    // Open-or-focus: a new artifact becomes a new focused tab; an already
    // open one just gets focused (keyed by path, like a browser tab's URL).
    set((s) => ({
      previewArtifacts: s.previewArtifacts.some((a) => a.path === artifact.path)
        ? s.previewArtifacts
        : [...s.previewArtifacts, artifact],
      activePreviewPath: artifact.path,
    }));
  },

  closePreviewArtifact: (path) =>
    set((s) => {
      const closing = path ?? s.activePreviewPath;
      if (!closing) return s;
      const idx = s.previewArtifacts.findIndex((a) => a.path === closing);
      if (idx < 0) return s;
      const next = s.previewArtifacts.filter((a) => a.path !== closing);
      // Closing the focused tab activates its neighbor (the one that slid
      // into the closed tab's slot, or the last tab when closing the tail).
      const activePreviewPath =
        s.activePreviewPath === closing
          ? (next[Math.min(idx, next.length - 1)]?.path ?? null)
          : s.activePreviewPath;
      return { previewArtifacts: next, activePreviewPath };
    }),

  setSessionWatchMode: async (chatSessionId, mode) => {
    await updateChatSessionWatchMode(chatSessionId, mode);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, watchMode: mode } : sess,
      ),
    }));
  },

  setOwnerSessionId: (chatSessionId, ownerSessionId) =>
    set((s) => ({
      ownerSessionByChatId: { ...s.ownerSessionByChatId, [chatSessionId]: ownerSessionId },
    })),

  getOwnerSessionId: (chatSessionId) => get().ownerSessionByChatId[chatSessionId],

  cancelStream: async () => {
    const { streamingChatSessionId } = get();
    if (streamingChatSessionId) {
      const session = get().sessions.find((s) => s.id === streamingChatSessionId);
      if (session?.agent?.startsWith("harness:")) {
        await cancelAgentChatMessage(streamingChatSessionId);
      } else {
        await cancelChatMessage(streamingChatSessionId);
      }
      // The backend may still fire chat:error or chat:done; our event handler
      // will clear streaming state. But we clear optimistically here too.
      set({ streamingChatSessionId: null });
      // A cancelled turn frees the queue too — send the next stacked message.
      get().drainQueue(streamingChatSessionId);
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
      const prev = s.streaming[chatSessionId] ?? "";
      // Cap the streaming buffer to 200KB per session to avoid OOM on
      // extremely long streaming turns (hundreds of thousands of tokens).
      // The tail is what matters for rendering; anything beyond ~50K chars
      // is scrolled out of view already.
      const next = (prev + token).slice(-200_000);
      return {
        streaming: {
          ...s.streaming,
          [chatSessionId]: next,
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
        // message that just completed (the last assistant record). This must
        // run even when the user is viewing a DIFFERENT chat: artifactsByMessage
        // is keyed by the persisted message id (globally unique), so the chips
        // will be there when the user opens that session — previously they were
        // silently discarded while the pending buffer was cleared regardless.
        // Only the flat `messages` buffer (the active session's list) stays
        // gated on the active session so two sessions finishing simultaneously
        // don't cross-contaminate.
        const isActiveSession = s.activeChatSessionId === chatSessionId;
        const pending = s.pendingArtifacts[chatSessionId] ?? [];
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        const artifactsByMessage =
          pending.length > 0 && lastAssistant
            ? { ...s.artifactsByMessage, [lastAssistant.id]: pending }
            : s.artifactsByMessage;
        const nextPending = { ...s.pendingArtifacts };
        delete nextPending[chatSessionId];
        return {
          messages: isActiveSession ? messages : s.messages,
          artifactsByMessage,
          pendingArtifacts: nextPending,
        };
      });
    }

    // Refresh the session list (title may have been updated by the backend).
    const sessions = await listChatSessions();
    if (sessions) set({ sessions: withoutDeleted(sessions) });
    // Turn finished — send the next queued message, if any (FIFO).
    get().drainQueue(chatSessionId);
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
        // Auto-open the newly generated file as a Canvas tab when it belongs
        // to the chat the user is currently viewing — except diagrams/HTML,
        // which render inline in the chat. The new tab becomes the focused
        // one; an already-open path is just focused (no duplicate tab).
        ...( !rendersInline && s.activeChatSessionId === chatSessionId
          ? {
              previewArtifacts: s.previewArtifacts.some((a) => a.path === path)
                ? s.previewArtifacts
                : [...s.previewArtifacts, artifact],
              activePreviewPath: artifact.path,
            }
          : {}),
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
    // Turn ended (in error) — keep the queue moving rather than stranding it.
    get().drainQueue(chatSessionId);
  },

  onTaskProgress: ({ chatSessionId, taskId, kind, state, message, downloaded, total, speedBps, destPath }) => {
    set((s) => {
      const sessionTasks = { ...(s.tasks[chatSessionId] ?? {}) };
      sessionTasks[taskId] = { taskId, kind, state, message, downloaded, total, speedBps, destPath };
      return { tasks: { ...s.tasks, [chatSessionId]: sessionTasks } };
    });
  },
}));

// Bind the active chat to a project when the user switches projects while
// viewing it — no message send required. The composer notch and the working
// directory follow the per-chat binding (sessionProjects) instead of the
// global selection. sendMessage also records this binding; selectSession
// pushes it back into the global selection when reopening a bound chat.
useProjectsStore.subscribe((s) => {
  const pid = s.selectedProjectId;
  if (!pid) return;
  const { activeChatSessionId, sessionProjects } = useChatStore.getState();
  if (!activeChatSessionId || sessionProjects[activeChatSessionId] === pid) return;
  useChatStore.setState((st) => ({
    sessionProjects: { ...st.sessionProjects, [activeChatSessionId]: pid },
  }));
});
