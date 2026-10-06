// Negative ephemeral ids: a module counter instead of Date.now() — two sends
// in the same millisecond used to collide (audit L17), producing duplicate
// list keys and confusing the desktop-echo replacement.
let optimisticIdCounter = 0;
const nextOptimisticId = () => --optimisticIdCounter;

/**
 * useSessionChat — per-conversation state store + WS bridge.
 *
 * Each mobile session is a chat. The hook keeps a per-session ordered
 * list of `SessionMessageRecord` (the desktop persists these keyed by
 * `owner_session_id`), the streaming assistant buffer (the most recent
 * in-flight tokens before the chat is "done"), pending approvals, plan
 * proposals, the session's model meta, artifacts, and pagination state.
 *
 * Architecture
 * ------------
 * - History is paginated: the first fetch pulls `limit=50` newest-first;
 *   the caller can `loadMore()` to fetch the next page (older messages
 *   prepended) using `before_id` of the oldest-known id.
 * - While a stream is active, `SessionChatToken` events append to
 *   `streamingContent` and a "live" `MessageBubble` shows the partial
 *   reply. `SessionChatDone` finalizes it as a real `assistant` message
 *   in the list.
 * - Approvals arrive via `SessionApprovalRequest` and are resolved by
 *   the caller calling `resolveApproval(pendingId, decision, alwaysAllow)`.
 *   They are dismissed from ANY surface via `SessionApprovalResolved`
 *   (e.g. the user approved on the desktop while the phone showed the card).
 * - Plan proposals (`present_plan`) arrive via `SessionPlanProposal` and are
 *   answered with `resolvePlan(approved, feedback)`.
 * - Status messages (`SessionChatStatus`) show transient banners
 *   ("Compacting…", "Reading file…") without adding to the message list.
 *
 * The hook subscribes to the global event buses from `useRelay.ts` so
 * events arrive whether the WS connects once at app boot or reconnects
 * after a desktop restart.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { screenCacheGet, screenCacheSet } from '../lib/screenCache';
import {
  onSessionChatDone,
  onSessionChatError,
  onSessionChatStatus,
  onSessionChatToken,
  onSessionMessages,
  onSessionApprovalRequest,
  onSessionApprovalResolved,
  onSessionPlanProposal,
  onSessionQuestionRequest,
  onSessionQuestionResolved,
  onSessionModelSet,
  onSessionDeleted,
  onSessionMessageDeleted,
  onSessionMeta,
  onSessionArtifacts,
  onSessionArtifact,
  onCheckpointRestored,
  onPermissionModeSet,
  onSessionCompacted,
  onCheckpoints,
  onConnected,
  onDomainError,
  type ChatCheckpointInfo,
  useRelay,
  type SessionMessageRecord,
  type SessionArtifact,
  type SessionChatAttachment,
} from './useRelay';

export interface PendingApproval {
  pendingId: string;
  tool: string;
  summary: string;
  args: unknown;
  /** True when the Always-Allow button should be offered (FS mutators only —
   *  the desktop rules engine governs exactly these). */
  canAlwaysAllow: boolean;
}

export interface PendingQuestion {
  pendingId: string;
  questions: import('./useRelay').AgentQuestion[];
}

export interface PendingPlan {
  pendingId: string;
  title: string;
  plan: string;
}

export interface SessionMetaInfo {
  provider: string;
  model: string;
  title?: string;
  /** Reasoning effort on the chat row ('' = provider default). */
  effort?: string | null;
  /** Permission posture: plan | read_only | manual | auto_edit | full_auto. */
  permissionMode?: string | null;
  /** The chat's bound project — keys the diff peek on file-edit rows. */
  projectId?: string | null;
  /** Resolved display name (desktop meta) — instant header chip. */
  projectName?: string | null;
}

/** Filesystem mutators the desktop approval-rules engine can auto-allow. */
const ALWAYS_ALLOWABLE_TOOLS = new Set([
  'write_file', 'edit_file', 'delete_file', 'move_file', 'copy_file',
]);

export interface SessionChatState {
  /** Newest-first, in render order. The latest user + assistant turn are at the top. */
  messages: SessionMessageRecord[];
  /** True while the first page is still loading. */
  loading: boolean;
  /** True while a stream is active for this session. */
  streaming: boolean;
  /** Streaming tokens that haven't been finalized into a message yet. */
  streamingContent: string;
  /** Transient status line (e.g. "Compacting…"). Cleared on next token. */
  status: string | null;
  /** Approvals awaiting the user's decision. */
  pendingApprovals: PendingApproval[];
  /** Live plan-proposal card, when the agent is presenting a plan. */
  planProposal: PendingPlan | null;
  /** A harness asked the user a question mid-turn (the turn is parked). */
  questionRequest: PendingQuestion | null;
  /** Session meta (provider/model/title) for the header + model sheet. */
  meta: SessionMetaInfo | null;
  /** Artifacts produced in this session (timeline order). */
  artifacts: SessionArtifact[];
  /** True when this session was just deleted on the desktop (or via `remove`). */
  deleted: boolean;
  /** Older pages exist; call `loadMore` to fetch them. */
  hasMore: boolean;
  /** Follow-ups typed while a turn is running; sent FIFO when it ends
   *  (desktop composer queue parity). */
  queued: string[];
  /** Turn checkpoints (Undo) — newest last. */
  checkpoints: ChatCheckpointInfo[];
  /** Last error surfaced from the chat pipeline. */
  error: string | null;
  /** Last finalized usage for the assistant's turn (for the cost chip). */
  lastUsage: { inputTokens: number; outputTokens: number; costUsd?: number } | null;
}

const INITIAL: SessionChatState = {
  messages: [],
  loading: false,
  streaming: false,
  streamingContent: '',
  status: null,
  pendingApprovals: [],
  planProposal: null,
  questionRequest: null,
  meta: null,
  artifacts: [],
  deleted: false,
  hasMore: false,
  queued: [],
  checkpoints: [],
  error: null,
  lastUsage: null,
};

export function useSessionChat(sessionId: string | null) {
  const [state, setState] = useState<SessionChatState>(INITIAL);
  // Track which session this hook instance is "for" so streaming events
  // from a previous session (delivered after a navigation) don't leak in.
  const currentSessionId = useRef<string | null>(null);
  // Latest meta for read-then-send actions — the effort commit rides the
  // session's current provider/model.
  const metaRef = useRef<SessionMetaInfo | null>(null);
  metaRef.current = state.meta;

  // PERF (PERFORMANCE_AUDIT.md C6): token batching. A local model can emit
  // 30-80 tokens/sec and each token used to trigger a full setState +
  // re-render of the message list. Tokens accumulate in `tokenBuf` and are
  // flushed into state at most every 50ms (the same debounce cadence the
  // desktop uses for partial messages). The buffer MUST be flushed
  // synchronously before the Done handler promotes `streamingContent` into
  // a finalized message, otherwise the unflushed tail would be lost.
  const tokenBuf = useRef<string>('');
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamActive = useRef(false);

  const stopFlushTimer = useCallback(() => {
    if (flushTimer.current) { clearInterval(flushTimer.current); flushTimer.current = null; }
  }, []);
  // A turn is in flight from the moment we SEND (not from its first token) —
  // otherwise a fast double-send started two concurrent desktop turns.
  const turnInFlight = useRef(false);
  // Watchdog state: was ANY token received for the current turn?
  const tokenReceived = useRef(false);
  const turnWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Slow-model retry loop (desktop fail-over parity): instead of erroring at
  // the first timeout, re-send the SAME turn up to 10 times with backoff.
  // Local sidecars (and busy providers) legitimately take minutes to start
  // streaming — a hard 75s cut killed exactly those.
  const retryAttempt = useRef(0);
  const lastTurnRef = useRef<{ text: string; attachments: SessionChatAttachment[] } | null>(null);
  // Turn timing for the "Worked for Xs" fold chip (unix seconds). Stamped at
  // dispatch and at Done; fetched turns get theirs from the wire timestamps.
  const turnStartedAt = useRef<number | null>(null);
  const dispatchRef = useRef<((text: string, attachments: SessionChatAttachment[], isRetry?: boolean) => boolean) | null>(null);
  // Set by cancel(): the relay still broadcasts the cancelled turn's
  // Done/Error ack after our optimistic teardown. Without this, the stale
  // ack promoted the STEERED turn's partial tokens into a finalized bubble
  // and split its reply in two whenever it outran the 350ms steer delay.
  // Consumed by the first Done/Error; cleared on session switch/disconnect.
  const cancelledTurn = useRef(false);
  // Set by cancel(): the streaming true→false transition must not auto-send
  // the next queued follow-up — the user explicitly STOPPED; a queued chip
  // drains on the next real turn boundary (or "send now").
  const suppressNextFlush = useRef(false);
  const connectedRef = useRef(true);
  // (The `connected` mirror lives just below, after the useRelay()
  // destructure declares it.)
  useEffect(() => {
    const off = onConnected.on((v) => {
      connectedRef.current = v;
      if (!v) {
        // Disconnected mid-turn: the Done/Error events will never arrive.
        setState((s) => ({ ...s, streaming: false }));
        stopFlushTimer();
        streamActive.current = false;
        turnInFlight.current = false;
        cancelledTurn.current = false;
      }
    });
    return off;
  }, [stopFlushTimer]);

  const flushTokens = useCallback(() => {
    const pending = tokenBuf.current;
    if (!pending) return;
    tokenBuf.current = '';
    setState((s) => ({ ...s, streamingContent: s.streamingContent + pending }));
  }, []);

  const endStream = useCallback(() => {
    flushTokens();
    stopFlushTimer();
    streamActive.current = false;
  }, [flushTokens, stopFlushTimer]);

  const {
    connected,
    getSessionMessages,
    sendSessionChat,
    cancelSessionStream,
    resolveSessionApproval,
    renameSession,
    setSessionModel,
    deleteChatMessage,
    editUserMessage,
    regenerateMessage,
    listChatCheckpoints,
    restoreChatCheckpoint,
    setSessionPermissionMode,
    resolveSessionQuestion,
    compactSession,
    deleteSession,
    getSessionMeta,
    listSessionArtifacts,
    resolvePlanProposal,
  } = useRelay();

  // Mirror the hook's `connected` value into the ref: the onConnected-event
  // subscription only fires on TRANSITIONS, so mounting the chat while
  // already offline left the ref `true` and the first fetch took the
  // loading-forever branch (the frame was silently dropped by _send).
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  // Live-turn transcript sync. A turn started on the DESKTOP (or by an
  // automation) persists its user row backend-side — the phone never ran its
  // optimistic-send path, so without a fetch the reply streamed in with no
  // prompt above it. Sync on the first token and on status banners (harness
  // turns can sit in tool phases long before the first token), debounced so
  // chatty status streams don't hammer the WS; the 2.5s poll below keeps
  // covering the rest of the turn.
  const lastTranscriptSync = useRef(0);
  const syncTranscript = useCallback(
    (sid: string) => {
      const now = Date.now();
      if (now - lastTranscriptSync.current < 1200) return;
      lastTranscriptSync.current = now;
      getSessionMessages(sid);
    },
    [getSessionMessages],
  );

  // Subscribe to event buses exactly once for the lifetime of the hook.
  useEffect(() => {
    const offMessages = onSessionMessages.on(({ sessionId: sid, messages, hasMore, append }) => {
      if (sid !== currentSessionId.current) return;
      // Persist the first page per chat: an offline reopen paints the cached
      // conversation instead of a blank screen (stale-while-revalidate).
      if (!append) screenCacheSet(`chat:${sid}`, messages);
      setState((s) => {
        // The CALLER says which this is: a pagination reply prepends, a
        // first-page reply replaces. Guessing from ids broke deletion — a
        // shortened first page looked "older" and got prepended, so the
        // deleted message never left the list.
        if (append) {
          return { ...s, messages: [...messages, ...s.messages], hasMore, loading: false };
        }
        // An empty page can be a STALE reply that raced a just-sent message
        // (the optimistic bubble isn't persisted yet) — never blank the list
        // for that. But when every local row came from the SERVER, an empty
        // page is authoritative: it is how deleting the last remaining
        // message converges. The old unconditional guard pinned that bubble
        // on screen forever.
        if (messages.length === 0 && s.messages.length > 0) {
          const onlyOptimistic = s.messages.every((m) => m.id < 0);
          if (onlyOptimistic) return { ...s, hasMore, loading: false };
        }
        // Convergence: tokens never arrived (the desktop's re-broadcast
        // didn't reach us) but the server already holds the finished turn
        // — clear the phantom streaming state instead of spinning forever.
        if (s.streaming && !streamActive.current && messages[0]?.role === 'assistant') {
          return { ...s, messages, hasMore, loading: false, streaming: false, streamingContent: '' };
        }
        // Keep optimistic bubbles the server hasn't persisted yet — a
        // mid-turn poll must not make the user's sent message blink out of
        // the list. Persisted rows inline attachment notes AFTER the typed
        // text while the optimistic bubble is the typed text alone, so both
        // sides match on the typed prefix (desktop mergeOptimistic's
        // base-text rule) — otherwise an attachment send duplicated once
        // the server row landed.
        const baseText = (content: string): string => {
          for (const marker of ['\n\n[Attached image:', '\n\nAttached file:', '\n\n[Attached file:']) {
            const i = content.indexOf(marker);
            if (i !== -1) return content.slice(0, i);
          }
          return content;
        };
        const serverContent = new Set(messages.map((m) => baseText(m.content)));
        const pending = s.messages.filter((m) => m.id < 0 && !serverContent.has(baseText(m.content)));
        return { ...s, messages: [...pending, ...messages], hasMore, loading: false };
      });
    });    // Delete ack: drop the row immediately. The relay also sends a refreshed
    // first page, but waiting on it left the deleted message on screen for
    // the length of a round-trip (and forever if that page came back empty).
    const offMessageDeleted = onSessionMessageDeleted.on(({ sessionId: sid, messageId }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({
        ...s,
        messages: s.messages.filter((m) => m.id !== messageId),
      }));
    });
    const offToken = onSessionChatToken.on(({ sessionId: sid, token }) => {
      if (!tokenReceived.current) {
        // First token of this attempt — the retry banner is stale now.
        setState((x) => (x.status && x.status.startsWith('Model is slow') ? { ...x, status: null } : x));
      }
      tokenReceived.current = true;
      if (sid !== currentSessionId.current) return;
      tokenBuf.current += token;
      if (!streamActive.current) {
        // First token of a stream: flip streaming on, clear any status
        // banner / stale error immediately, and start the 50ms flush. Also
        // sync the transcript once — a desktop-started turn's user row only
        // reaches this list through a fetch (the relay persists it before
        // the first token, so it IS in this first reply).
        streamActive.current = true;
        turnInFlight.current = true;
        setState((s) => ({ ...s, streaming: true, status: null, error: null }));
        flushTimer.current = setInterval(flushTokens, 50);
        syncTranscript(sid);
      }
    });
    const offDone = onSessionChatDone.on(({ sessionId: sid, usage }) => {
      if (sid !== currentSessionId.current) return;
      // AFTER the session guard: the relay broadcasts Done for every session,
      // and clearing the flag for another conversation's turn let send()
      // start a second concurrent turn mid-stream.
      turnInFlight.current = false;
      // The ack of a locally-cancelled turn: tear nothing down (cancel()
      // already did) and promote nothing — consume the flag and move on.
      if (cancelledTurn.current) {
        cancelledTurn.current = false;
        return;
      }
      // Flush BEFORE promoting so the unflushed tail isn't dropped.
      endStream();
      setState((s) => {
        if (!s.streaming) return s;
        // Zero tokens arrived (e.g. an empty reply) — nothing to promote;
        // close the stream WITHOUT appending an empty assistant bubble.
        if (!s.streamingContent) {
          return {
            ...s,
            streaming: false,
            streamingContent: '',
            lastUsage: usage
              ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, costUsd: usage.cost_usd }
              : s.lastUsage,
          };
        }
        // Promote the streaming buffer to a real assistant message.
        const nowSec = Math.floor(Date.now() / 1000);
        const finalized: SessionMessageRecord = {
          id: nextOptimisticId(), // Negative = ephemeral, never sent to the desktop.
          role: 'assistant',
          content: s.streamingContent,
          createdAt: nowSec,
          startedAt: turnStartedAt.current ?? undefined,
          completedAt: nowSec,
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          costUsd: usage?.cost_usd,
        };
        return {
          ...s,
          messages: [finalized, ...s.messages],
          streaming: false,
          streamingContent: '',
          lastUsage: usage
            ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, costUsd: usage.cost_usd }
            : s.lastUsage,
        };
      });
    });
    const offError = onSessionChatError.on(({ sessionId: sid, error }) => {
      if (sid !== currentSessionId.current) return;
      turnInFlight.current = false;
      // A cancelled turn can still surface its death as an error frame —
      // same swallow as the Done path (cancel already cleaned up).
      if (cancelledTurn.current) {
        cancelledTurn.current = false;
        return;
      }
      endStream();
      setState((s) => ({ ...s, streaming: false, error, status: null }));
    });
    // Session-scoped relay ops (GetSessionMeta, ListSessionArtifacts, the
    // permission/checkpoint arms) answer with a ChatError tagged
    // "session-chat". Show it on the open chat instead of dropping it.
    const offDomainError = onDomainError.on(({ domain, error }) => {
      if (domain !== 'session-chat' && domain !== 'session-connectors') return;
      if (currentSessionId.current === null) return;
      setState((s) => ({ ...s, error }));
    });
    const offStatus = onSessionChatStatus.on(({ sessionId: sid, message }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({ ...s, status: message }));
      // Status banners can arrive long before the first token (harness tool
      // phases) — sync the transcript so the prompt that started the live
      // turn shows without waiting for tokens or the 2.5s poll.
      syncTranscript(sid);
    });
    const offApproval = onSessionApprovalRequest.on(({ sessionId: sid, pendingId, tool, summary, args }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({
        ...s,
        pendingApprovals: [...s.pendingApprovals, {
          pendingId, tool, summary, args,
          canAlwaysAllow: ALWAYS_ALLOWABLE_TOOLS.has(tool),
        }],
      }));
    });
    const offApprovalResolved = onSessionApprovalResolved.on(({ sessionId: sid, pendingId }) => {
      if (sid !== currentSessionId.current) return;
      // Dismiss from ANY surface — desktop card, another phone, our own
      // optimistic removal is a no-op when the entry is already gone.
      setState((s) => ({
        ...s,
        pendingApprovals: s.pendingApprovals.filter((a) => a.pendingId !== pendingId),
      }));
    });
    const offPlan = onSessionPlanProposal.on(({ sessionId: sid, pendingId, title, plan }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({ ...s, planProposal: { pendingId, title, plan } }));
    });
    const offQuestion = onSessionQuestionRequest.on(({ sessionId: sid, pendingId, questions }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({ ...s, questionRequest: { pendingId, questions } }));
    });
    const offQuestionResolved = onSessionQuestionResolved.on(({ pendingId }) => {
      setState((s) =>
        s.questionRequest?.pendingId === pendingId ? { ...s, questionRequest: null } : s,
      );
    });
    const offModelSet = onSessionModelSet.on(({ sessionId: sid, providerId, model, effort }) => {
      if (sid !== currentSessionId.current) return;
      // Spread the existing meta: rebuilding it used to drop permissionMode
      // and projectId, killing the diff peek and showing the wrong
      // permission mode until the next SessionMeta round-trip.
      setState((s) => ({ ...s, meta: { ...s.meta, provider: providerId, model, effort: effort ?? s.meta?.effort } }));
    });
    const offMeta = onSessionMeta.on(({ sessionId: sid, provider, model, title, effort, permission_mode, projectId, projectName }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({ ...s, meta: { provider, model, title, effort: effort ?? null, permissionMode: permission_mode ?? null, projectId: projectId ?? s.meta?.projectId ?? null, projectName: projectName ?? s.meta?.projectName ?? null } }));
    });
    const offCheckpoints = onCheckpoints.on(({ sessionId: sid, checkpoints }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({ ...s, checkpoints }));
    });
    const offRestored = onCheckpointRestored.on(({ sessionId: sid }) => {
      if (sid !== currentSessionId.current) return;
      // A restore rewrites files and may roll the conversation back — pull
      // the fresh first page (the relay also pushes one after the ack).
      getSessionMessages(sid);
    });
    const offPermission = onPermissionModeSet.on(({ sessionId: sid, mode }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({ ...s, meta: s.meta ? { ...s.meta, permissionMode: mode } : s.meta }));
    });
    const offCompacted = onSessionCompacted.on(({ sessionId: sid }) => {
      if (sid !== currentSessionId.current) return;
      getSessionMessages(sid);
    });
    const offArtifacts = onSessionArtifacts.on(({ sessionId: sid, artifacts }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({ ...s, artifacts }));
    });
    const offArtifact = onSessionArtifact.on(({ sessionId: sid, artifact }) => {
      if (sid !== currentSessionId.current) return;
      // Live artifact during a turn — merge by path, newest wins.
      setState((s) => {
        const rest = s.artifacts.filter((a) => a.path !== artifact.path);
        return { ...s, artifacts: [...rest, artifact] };
      });
    });
    const offDeleted = onSessionDeleted.on(({ sessionId: sid }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({ ...s, deleted: true }));
    });
    return () => {
      offMessages();
      offToken();
      offDone();
      offError();
      offStatus();
      offApproval();
      offApprovalResolved();
      offPlan();
      offQuestion();
      offQuestionResolved();
      offModelSet();
      offMeta();
      offCheckpoints();
      offRestored();
      offPermission();
      offCompacted();
      offArtifacts();
      offArtifact();
      offDeleted();
      offMessageDeleted();
      offDomainError();
      stopFlushTimer();
    };
  }, [flushTokens, endStream, stopFlushTimer]);

  // --- turn dispatch (shared by send / queue flush / steer) ---
  // One copy of the dispatch sequence: send + in-flight guard + optimistic
  // user bubble. The flush and steer paths used to send blind — no
  // turnInFlight guard (a fast follow-up send raced a second concurrent
  // desktop turn) and no bubble (the message was invisible until the first
  // token, and vanished entirely if the turn never started).
  const dispatchTurn = useCallback(
    (text: string, attachments: SessionChatAttachment[] = [], isRetry = false): boolean => {
      if (!sessionId) return false;
      tokenReceived.current = false;
      turnStartedAt.current = Math.floor(Date.now() / 1000);
      // A watchdog retry must NOT reset the attempt counter (infinite loop);
      // every fresh user send does.
      if (!isRetry) retryAttempt.current = 0;
      lastTurnRef.current = { text, attachments };
      const sent = sendSessionChat(sessionId, text, attachments);
      if (sent) {
        turnInFlight.current = true;
        armTurnWatchdog(sessionId);
      }
      // Images render from the LOCAL bytes we already hold — the persisted
      // marker + relay preview round-trip would leave a spinner up for
      // seconds on a big photo.
      const localAttachments = attachments
        .filter((a) => a.kind === 'image' && a.data)
        .map((a) => ({ name: a.name, dataUri: `data:${a.media_type ?? 'image/png'};base64,${a.data}` }));
      const userMsg: SessionMessageRecord = {
        id: nextOptimisticId(),
        role: 'user',
        content: text,
        createdAt: Math.floor(Date.now() / 1000),
        localAttachments,
      };
      setState((s) => ({
        ...s,
        messages: [userMsg, ...s.messages],
        streaming: sent,
        streamingContent: '',
        error: sent ? s.error : 'Not connected to desktop — message not sent. Reconnect and try again.',
      }));
      return sent;
    },
    [sessionId, sendSessionChat],
  );
  dispatchRef.current = dispatchTurn;

  /** Arm the no-token watchdog. Fires per window: local GGUF sidecars get a
   *  longer first wait (model load into VRAM can take minutes); everything
   *  else 75s.
   *
   *  On fire WITHOUT any token the watchdog now WAITS AND RECONCILES — it does
   *  NOT cancel or re-send. It used to cancel the stream and re-dispatch the
   *  same turn up to 10 times, which (a) appended a duplicate user bubble per
   *  attempt to the transcript and (b) fired a second concurrent
   *  SendChatMessage at the desktop per attempt — the pile-up that wedged the
   *  desktop relay's send path (it parked on its own DB lock at
   *  `5d: fs_roots`). A slow model is not a failure: tokens may still be
   *  coming, and the transcript is the source of truth on the desktop.
   *
   *  Each window asks for the session's messages so a turn that finished
   *  (with its tokens lost in a reconnect) reconciles instead of hanging.
   *  After MAX windows the turn is surfaced as stalled — the user decides
   *  whether to re-send; the app never posts duplicates on its own. */
  const armTurnWatchdog = useCallback((sid: string) => {
    if (turnWatchdog.current) clearTimeout(turnWatchdog.current);
    const isLocal = metaRef.current?.provider === 'local_gguf';
    const waitMs = isLocal ? 180_000 : 75_000;
    turnWatchdog.current = setTimeout(() => {
      if (currentSessionId.current !== sid) return;
      if (tokenReceived.current) return;
      const attempt = ++retryAttempt.current;
      const MAX = 10;
      if (attempt > MAX) {
        // Stop waiting; leave the turn's optimistic bubble visible and say so
        // honestly. No cancel storm, no re-sends.
        turnInFlight.current = false;
        streamActive.current = false;
        setState((x) => ({
          ...x,
          streaming: false,
          streamingContent: '',
          status: null,
          error: 'The model has not responded for a while. It may be rate-limited or down — tap the message to re-send, or pick another model.',
        }));
        return;
      }
      // Reconcile: pull the transcript. If the desktop finished the turn while
      // the stream was lost, onSessionMessages renders it (and a ChatDone that
      // raced in clears streaming).
      getSessionMessages(sid);
      setState((x) => ({
        ...x,
        status: x.streaming
          ? `Still waiting for the model — ${attempt}/${MAX}…`
          : x.status,
      }));
      // Keep watching the SAME turn — do not cancel, do not re-dispatch.
      armTurnWatchdog(sid);
    }, waitMs);
  }, [cancelSessionStream, getSessionMessages]);

  // Queue flush: when a turn ends (Done, error, or cancel), dispatch the next
  // queued follow-up. Kept as an effect so every end-path is covered.
  const prevStreaming = useRef(false);
  useEffect(() => {
    const was = prevStreaming.current;
    prevStreaming.current = state.streaming;
    if (suppressNextFlush.current) {
      suppressNextFlush.current = false;
      return;
    }
    if (was && !state.streaming && state.queued.length > 0) {
      const [next, ...rest] = state.queued;
      const sid = sessionId;
      setState((s) => ({ ...s, queued: rest }));
      // Small gap so the desktop can finish persisting the finished turn.
      setTimeout(() => {
        // The user may have switched chats during the gap — the message must
        // go to the chat it was typed in, never the newly-opened one.
        if (sid === null || sid !== currentSessionId.current) return;
        // dispatchTurn surfaces the not-connected error itself; on failure
        // the message goes back to the queue HEAD (its original place).
        const ok = dispatchTurn(next);
        if (!ok) {
          setState((s) => ({ ...s, queued: [next, ...s.queued] }));
        }
      }, 350);
    }
  }, [state.streaming, state.queued, sessionId, dispatchTurn]);

  const cancelQueued = useCallback((text: string) => {
    setState((s) => {
      // Two identical queued texts are two distinct sends — remove exactly
      // ONE instance (a `filter` used to drop both).
      const i = s.queued.indexOf(text);
      if (i === -1) return s;
      const queued = s.queued.slice();
      queued.splice(i, 1);
      return { ...s, queued };
    });
  }, []);

  // PHONE-SIDE LIVE CONVERGENCE. Token/Done events for pane-backed (CLI
  // harness) turns only reach the phone when the desktop FRONTEND re-broadcasts
  // them; when it doesn't, the turn looked frozen until a manual refresh. While
  // a turn is in flight, poll the transcript every 2.5s — the messages handler
  // swaps in the server rows (replacing the optimistic ones) and clears the
  // phantom streaming state when it sees the finished assistant turn. Instant
  // token streaming still wins when the events DO arrive.
  useEffect(() => {
    if (!state.streaming || !sessionId) return;
    const timer = setInterval(() => {
      getSessionMessages(sessionId);
    }, 2500);
    return () => clearInterval(timer);
  }, [state.streaming, sessionId, getSessionMessages]);

  // Switch session: reset state and fetch the first page of the new session.
  useEffect(() => {
    // Any in-flight stream belongs to the OLD session — drop its buffer.
    tokenBuf.current = '';
    stopFlushTimer();
    streamActive.current = false;
    turnInFlight.current = false;
    cancelledTurn.current = false;
    suppressNextFlush.current = false;
    currentSessionId.current = sessionId;
    if (!sessionId) {
      setState(INITIAL);
      return;
    }
    // A disconnected phone can't fetch the page; leaving `loading: true`
    // left the chat on its first-load spinner forever.
    if (connectedRef.current !== false) {
      setState((s) => ({ ...INITIAL, loading: true }));
      getSessionMessages(sessionId, undefined, 50);
    } else {
      setState((s) => ({ ...INITIAL, loading: false }));
    }
    // Header (model chip) + artifacts gallery state for this chat.
    getSessionMeta(sessionId);
    listSessionArtifacts(sessionId);
  }, [sessionId, getSessionMessages, stopFlushTimer, getSessionMeta, listSessionArtifacts]);

  // Disconnect recovery: a mid-stream disconnect means the Done/Error events
  // for the in-flight turn will NEVER arrive — the chat used to sit "streaming"
  // forever. On drop: stop the 50ms flush timer, discard the partial buffer,
  // and clear the streaming UI so the composer recovers immediately.
  useEffect(() => {
    if (connected || currentSessionId.current === null) return;
    endStream();
    tokenBuf.current = '';
    setState((s) =>
      s.streaming || s.streamingContent
        ? { ...s, streaming: false, streamingContent: '' }
        : s,
    );
  }, [connected, endStream]);

  // (Re)connect: re-fetch the FIRST page. The session-switch fetch rides the
  // socket and is silently dropped while offline, so this effect is what
  // actually populates history when the WS comes up later — and after a
  // mid-stream reconnect it converges the list with whatever the desktop
  // persisted for the interrupted turn. Also dispatches a STRANDED queue
  // head: a queued message whose flush send failed just sat there (the
  // flush effect only fires on a streaming transition, which never happens
  // offline — the "will resend when the connection returns" promise used to
  // be empty).
  const queuedRef = useRef(state.queued);
  queuedRef.current = state.queued;
  useEffect(() => {
    if (!connected || !sessionId) return;
    getSessionMessages(sessionId, undefined, 50);
    const queued = queuedRef.current;
    if (queued.length > 0 && !streamActive.current && !turnInFlight.current) {
      const [next, ...rest] = queued;
      setState((s) => ({ ...s, queued: rest }));
      dispatchTurn(next);
    }
  }, [connected, sessionId, getSessionMessages, dispatchTurn]);

  // --- actions ---

  const send = useCallback(
    (text: string, attachments: SessionChatAttachment[] = []) => {
      if (!sessionId) return;
      // Mid-turn sends would collide with the running turn on the desktop —
      // queue them and flush in order when it completes. `turnInFlight` is set
      // at SEND time, so a fast double-send queues instead of racing a
      // second concurrent turn. No cap: the desktop queue is unbounded, and
      // `.slice(-10)` silently discarded the OLDEST queued messages with no
      // error or indication.
      if (streamActive.current || turnInFlight.current) {
        setState((s) => ({ ...s, queued: [...s.queued, text.trim()] }));
        return;
      }
      dispatchTurn(text, attachments);
    },
    [sessionId, dispatchTurn],
  );

  const cancel = useCallback(() => {
    if (!sessionId) return;
    cancelSessionStream(sessionId);
    // Drop the unflushed tail too — a cancelled stream's tokens are moot.
    // Clearing turnInFlight lets the very next send start a fresh turn
    // immediately (steer) instead of being silently queued behind the
    // dying one.
    tokenBuf.current = '';
    stopFlushTimer();
    streamActive.current = false;
    turnInFlight.current = false;
    // The relay's Done/Error ack for this turn is now stale — swallow it
    // (and never auto-flush the queue because of it: the user STOPPED).
    cancelledTurn.current = true;
    suppressNextFlush.current = true;
    setState((s) => ({ ...s, streaming: false, streamingContent: '' }));
  }, [sessionId, cancelSessionStream, stopFlushTimer]);

  /** Steer (desktop composer parity): cancel the running turn and send this
   *  queued message NOW, parking the rest of the queue until the steered
   *  turn finishes (the queue-flush effect drains it in order). */
  const steerQueued = useCallback(
    (text: string) => {
      if (!sessionId) return;
      // Park the queue BEFORE cancel: the streaming true→false transition
      // must not trigger the queue-flush effect and race this send
      // (cancel() also arms suppressNextFlush as a second guard).
      // Exactly ONE instance of `text` leaves the queue (indexOf/splice) —
      // a duplicate queued text is a separate send, not the same one.
      const idx = state.queued.indexOf(text);
      const parked = state.queued.slice();
      if (idx !== -1) parked.splice(idx, 1);
      setState((s) => ({ ...s, queued: [] }));
      cancel();
      const sid = sessionId;
      setTimeout(() => {
        // The user may have switched chats during the gap — never steer the
        // newly-opened conversation.
        if (sid !== currentSessionId.current) return;
        // The steered turn streams; the parked follow-ups drain FIFO when
        // it ends (queue-flush effect). Show them again so the user sees
        // what's still pending.
        if (dispatchTurn(text)) {
          setState((s) => ({ ...s, queued: [...s.queued, ...parked] }));
        } else {
          setState((s) => ({ ...s, queued: [text, ...parked, ...s.queued] }));
        }
      }, 350);
    },
    [sessionId, state.queued, cancel, dispatchTurn],
  );

  const approve = useCallback(
    (pendingId: string, alwaysAllow = false) => {
      if (!sessionId) return;
      resolveSessionApproval(sessionId, pendingId, 'approve', alwaysAllow);
      setState((s) => ({
        ...s,
        pendingApprovals: s.pendingApprovals.filter((a) => a.pendingId !== pendingId),
      }));
    },
    [sessionId, resolveSessionApproval],
  );

  const deny = useCallback(
    (pendingId: string) => {
      if (!sessionId) return;
      resolveSessionApproval(sessionId, pendingId, 'deny');
      setState((s) => ({
        ...s,
        pendingApprovals: s.pendingApprovals.filter((a) => a.pendingId !== pendingId),
      }));
    },
    [sessionId, resolveSessionApproval],
  );

  const resolvePlan = useCallback(
    (pendingId: string, approved: boolean, feedback?: string) => {
      if (!sessionId) return;
      resolvePlanProposal(sessionId, pendingId, approved, feedback);
      setState((s) => (s.planProposal?.pendingId === pendingId ? { ...s, planProposal: null } : s));
    },
    [sessionId, resolvePlanProposal],
  );

  /** Answer a parked harness question (desktop QuestionCard parity).
   *  `answers` maps each question's text to the chosen label(s). */
  const answerQuestion = useCallback(
    (answers: Record<string, string | string[]>, response?: string) => {
      if (!sessionId || !state.questionRequest) return;
      resolveSessionQuestion(sessionId, state.questionRequest.pendingId, answers, response);
      setState((s) => ({ ...s, questionRequest: null }));
    },
    [sessionId, state.questionRequest, resolveSessionQuestion],
  );

  // ---- Message actions (desktop MessageBubble parity) ----
  const deleteMessage = useCallback(
    (messageId: number) => {
      if (!sessionId) return;
      deleteChatMessage(sessionId, messageId);
    },
    [sessionId, deleteChatMessage],
  );

  const editMessage = useCallback(
    (messageId: number, text: string) => {
      if (!sessionId || !text.trim()) return;
      editUserMessage(sessionId, messageId, text.trim());
    },
    [sessionId, editUserMessage],
  );

  const regenerate = useCallback(
    (latestUserMessageId?: number) => {
      if (!sessionId) return;
      if (latestUserMessageId != null) {
        setState((s) => ({
          ...s,
          // Persisted rows older than the fork point survive; EVERY ephemeral
          // row dies with them. The old `m.id < latestUserMessageId` filter
          // kept the just-streamed reply: finalized ephemeral rows carry
          // NEGATIVE ids, and -N < any positive id is always true.
          messages: s.messages.filter((m) => m.id > 0 && m.id < latestUserMessageId),
        }));
      }
      regenerateMessage(sessionId);
    },
    [sessionId, regenerateMessage],
  );

  const refreshCheckpoints = useCallback(
    () => {
      if (!sessionId) return;
      listChatCheckpoints(sessionId);
    },
    [sessionId, listChatCheckpoints],
  );

  const restoreCheckpoint = useCallback(
    (checkpointId: number, rollbackMessages = false) => {
      if (!sessionId) return;
      restoreChatCheckpoint(sessionId, checkpointId, rollbackMessages);
    },
    [sessionId, restoreChatCheckpoint],
  );

  const setPermissionMode = useCallback(
    (mode: string) => {
      if (!sessionId) return;
      setSessionPermissionMode(sessionId, mode);
      setState((s) => ({ ...s, meta: s.meta ? { ...s.meta, permissionMode: mode } : s.meta }));
    },
    [sessionId, setSessionPermissionMode],
  );

  const compact = useCallback(
    () => {
      if (!sessionId) return;
      compactSession(sessionId);
    },
    [sessionId, compactSession],
  );

  const setModel = useCallback(
    (providerId: string, model: string) => {
      if (!sessionId) return;
      setSessionModel(sessionId, providerId, model);
      // Optimistic header update; SessionModelSet confirms. Spread the
      // existing meta (permissionMode/projectId must survive a model pick).
      setState((s) => ({ ...s, meta: s.meta ? { ...s.meta, provider: providerId, model } : s.meta }));
    },
    [sessionId, setSessionModel],
  );

  // Effort slider (desktop AgentModelPicker parity): commits to the chat row
  // alongside the current provider/model, applied at the next spawn.
  const setEffort = useCallback(
    (effort: string) => {
      if (!sessionId) return;
      setSessionModel(sessionId, metaRef.current?.provider || 'auto', metaRef.current?.model || 'auto', effort);
      setState((s) => ({ ...s, meta: s.meta ? { ...s.meta, effort } : s.meta }));
    },
    [sessionId, setSessionModel],
  );

  const remove = useCallback(
    (onGone?: () => void) => {
      if (!sessionId) return;
      deleteSession(sessionId);
      setState((s) => ({ ...s, deleted: true }));
      if (onGone) onGone();
    },
    [sessionId, deleteSession],
  );

  const loadMore = useCallback(() => {
    if (!sessionId || !state.hasMore || state.messages.length === 0) return;
    const oldest = state.messages[state.messages.length - 1]!;
    setState((s) => ({ ...s, loading: true }));
    getSessionMessages(sessionId, oldest.id, 50);
  }, [sessionId, state.hasMore, state.messages, getSessionMessages]);

  const rename = useCallback(
    (title: string) => {
      if (!sessionId) return;
      renameSession(sessionId, title);
    },
    [sessionId, renameSession],
  );

  // M10: pull-to-refresh — re-fetch the FIRST page (no before_id); the
  // onSessionMessages handler replaces (not merges) the list for first-page
  // responses, so this is a true refresh.
  const refresh = useCallback(() => {
    if (!sessionId) return;
    setState((s) => ({ ...s, loading: true }));
    getSessionMessages(sessionId, undefined, 50);
  }, [sessionId, getSessionMessages]);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  return {
    ...state,
    send,
    cancel,
    cancelQueued,
    steerQueued,
    approve,
    deny,
    resolvePlan,
    answerQuestion,
    setModel,
    setEffort,
    deleteMessage,
    editMessage,
    regenerate,
    refreshCheckpoints,
    restoreCheckpoint,
    setPermissionMode,
    compact,
    remove,
    loadMore,
    refresh,
    rename,
    clearError,
  };
}
