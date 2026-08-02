/**
 * useSessionChat — per-conversation state store + WS bridge.
 *
 * Each mobile session is a chat. The hook keeps a per-session ordered
 * list of `SessionMessageRecord` (the desktop persists these keyed by
 * `owner_session_id`), the streaming assistant buffer (the most recent
 * in-flight tokens before the chat is "done"), pending approvals, the
 * streaming status, the latest artifact, and pagination state.
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
 *   the caller calling `resolveApproval(pendingId, decision)`, which
 *   sends `ResolveSessionApproval` and removes the pending entry.
 * - Status messages (`SessionChatStatus`) show transient banners
 *   ("Compacting…", "Reading file…") without adding to the message list.
 *
 * The hook subscribes to the global event buses from `useRelay.ts` so
 * events arrive whether the WS connects once at app boot or reconnects
 * after a desktop restart.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  onSessionChatDone,
  onSessionChatError,
  onSessionChatStatus,
  onSessionChatToken,
  onSessionMessages,
  onSessionApprovalRequest,
  onSessionArtifact,
  useRelay,
  type SessionMessageRecord,
  type SessionArtifact,
} from './useRelay';

export interface PendingApproval {
  pendingId: string;
  tool: string;
  summary: string;
  args: unknown;
}

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
  /** Latest artifact attached to a message in this session, if any. */
  lastArtifact: SessionArtifact | null;
  /** Older pages exist; call `loadMore` to fetch them. */
  hasMore: boolean;
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
  lastArtifact: null,
  hasMore: false,
  error: null,
  lastUsage: null,
};

export function useSessionChat(sessionId: string | null) {
  const [state, setState] = useState<SessionChatState>(INITIAL);
  // Track which session this hook instance is "for" so streaming events
  // from a previous session (delivered after a navigation) don't leak in.
  const currentSessionId = useRef<string | null>(null);

  const {
    getSessionMessages,
    sendSessionChat,
    cancelSessionStream,
    resolveSessionApproval,
    renameSession,
  } = useRelay();

  // Subscribe to event buses exactly once for the lifetime of the hook.
  useEffect(() => {
    const offMessages = onSessionMessages.on(({ sessionId: sid, messages, hasMore }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => {
        // The first page replaces the list. Older pages (loadMore) prepend.
        if (messages.length > 0 && (s.messages.length === 0 || messages[0].id < s.messages[s.messages.length - 1]!.id)) {
          // Older page — prepend.
          return { ...s, messages: [...messages, ...s.messages], hasMore, loading: false };
        }
        return { ...s, messages, hasMore, loading: false };
      });
    });
    const offToken = onSessionChatToken.on(({ sessionId: sid, token }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({
        ...s,
        streaming: true,
        streamingContent: s.streamingContent + token,
        status: null, // First token clears any status banner.
        error: null,
      }));
    });
    const offDone = onSessionChatDone.on(({ sessionId: sid, usage }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => {
        if (!s.streaming) return s;
        // Promote the streaming buffer to a real assistant message.
        const finalized: SessionMessageRecord = {
          id: -Date.now(), // Negative = ephemeral, never sent to the desktop.
          role: 'assistant',
          content: s.streamingContent,
          created_at: Math.floor(Date.now() / 1000),
          input_tokens: usage?.input_tokens,
          output_tokens: usage?.output_tokens,
          cost_usd: usage?.cost_usd,
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
      setState((s) => ({ ...s, streaming: false, error, status: null }));
    });
    const offStatus = onSessionChatStatus.on(({ sessionId: sid, message }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({ ...s, status: message }));
    });
    const offApproval = onSessionApprovalRequest.on(({ sessionId: sid, pendingId, tool, summary, args }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({
        ...s,
        pendingApprovals: [...s.pendingApprovals, { pendingId, tool, summary, args }],
      }));
    });
    const offArtifact = onSessionArtifact.on(({ sessionId: sid, artifact }) => {
      if (sid !== currentSessionId.current) return;
      setState((s) => ({ ...s, lastArtifact: artifact }));
    });
    return () => {
      offMessages();
      offToken();
      offDone();
      offError();
      offStatus();
      offApproval();
      offArtifact();
    };
  }, []);

  // Switch session: reset state and fetch the first page of the new session.
  useEffect(() => {
    currentSessionId.current = sessionId;
    if (!sessionId) {
      setState(INITIAL);
      return;
    }
    setState((s) => ({ ...INITIAL, loading: true }));
    getSessionMessages(sessionId, undefined, 50);
  }, [sessionId, getSessionMessages]);

  // --- actions ---

  const send = useCallback(
    (text: string) => {
      if (!sessionId) return;
      // Optimistically show the user message immediately so the UI feels
      // responsive before the desktop echoes it back via GetSessionMessages.
      const userMsg: SessionMessageRecord = {
        id: -Date.now() - 1, // Distinct from the streaming-finalize id above.
        role: 'user',
        content: text,
        created_at: Math.floor(Date.now() / 1000),
      };
      setState((s) => ({ ...s, messages: [userMsg, ...s.messages], streaming: true, streamingContent: '' }));
      sendSessionChat(sessionId, text, []);
    },
    [sessionId, sendSessionChat],
  );

  const cancel = useCallback(() => {
    if (!sessionId) return;
    cancelSessionStream(sessionId);
    setState((s) => ({ ...s, streaming: false, streamingContent: '' }));
  }, [sessionId, cancelSessionStream]);

  const approve = useCallback(
    (pendingId: string) => {
      if (!sessionId) return;
      resolveSessionApproval(sessionId, pendingId, 'approve');
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

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  return {
    ...state,
    send,
    cancel,
    approve,
    deny,
    loadMore,
    rename,
    clearError,
  };
}
