// Live context-window token count for a local-model session.
//
// Polls `count_context_tokens` while a `local_gguf` chat is active so the
// composer's circular meter is always current — including the moment the
// session is sitting idle and the user is composing their next message.
// The meter previously only updated on chat:done (when the *next* assistant
// turn's `inputTokens` arrived), so the ring went stale the moment any
// turn ended and never reflected a compaction until the next reply.
//
// Polling is debounced to 2s — /tokenize is a network round-trip to the
// sidecar and we don't need sub-second resolution to make the meter useful.
// Pauses while a stream is in flight (the send path is already doing its
// own /tokenize for the compaction check) and only resumes once the
// session is idle again.
//
// The meter MUST update immediately when the active history shortens due to
// compaction (to_compact is folded into a summary row, dropping N messages
// from the model's view). The frontend gets a `chat:status` event with
// reason="context_compacted" — the caller passes that in via the
// `compactionRevision` prop so this hook re-polls as soon as the compaction
// finishes, instead of waiting up to `intervalMs` for the next tick.

import { useEffect, useRef, useState } from "react";
import { countContextTokens } from "../lib/ipc";

interface Options {
  chatSessionId: string | null;
  isLocal: boolean;
  /** True while a turn is being generated for this session. */
  isStreaming: boolean;
  /** Increment whenever messages change so a poll runs immediately after
   *  the user sends a turn (so the meter shows the just-incremented usage
   *  before the next reply arrives). */
  messagesRevision: number;
  /** Increment whenever the active history shortens due to compaction.
   *  Same effect as `messagesRevision` (re-runs the immediate poll) but
   *  driven by a separate signal so a compaction that doesn't change
   *  `messages.length` (e.g. a fold into a 1-line summary) still triggers
   *  a refresh. */
  compactionRevision: number;
  /** Polling interval while idle, in ms. Defaults to 2000. */
  intervalMs?: number;
}

export interface ContextUsageState {
  usedTokens: number | null;
  maxTokens: number;
}

/** Returns the live `used / max` token counts for the meter's ring. The
 *  meter should prefer `usedTokens` when non-null and fall back to its
 *  own heuristic (last assistant inputTokens) when null. */
export function useContextMeter({
  chatSessionId,
  isLocal,
  isStreaming,
  messagesRevision,
  compactionRevision,
  intervalMs = 2000,
}: Options): ContextUsageState {
  const [state, setState] = useState<ContextUsageState>({
    usedTokens: null,
    maxTokens: 0,
  });
  // Keep a ref of the latest streaming flag so the poll loop doesn't have
  // to re-create its interval on every render.
  const streamingRef = useRef(isStreaming);
  streamingRef.current = isStreaming;

  useEffect(() => {
    // Only local sessions have a sidecar to query. Cloud sessions should
    // keep using the last assistant turn's inputTokens (passed in from
    // ChatView's `lastInputTokens`), so we don't need to poll anything.
    if (!chatSessionId || !isLocal) {
      setState({ usedTokens: null, maxTokens: 0 });
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      // Skip the round-trip while a turn is being generated — the send path
      // is already busy with its own /tokenize call, and the meter is going
      // to get a fresh value from chat:done anyway. Re-arm for the next idle
      // tick instead.
      if (streamingRef.current) {
        timer = setTimeout(tick, intervalMs);
        return;
      }
      try {
        const result = await countContextTokens(chatSessionId);
        if (cancelled) return;
        if (result) {
          setState({
            usedTokens: result.usedTokens,
            maxTokens: result.maxTokens,
          });
        }
      } catch {
        // Silent: a transient sidecar hiccup shouldn't surface as an error
        // toast. The meter will keep showing the previous value.
      }
      if (!cancelled) {
        timer = setTimeout(tick, intervalMs);
      }
    };

    // Fire one immediately, then schedule the recurring tick. `messagesRevision`
    // and `compactionRevision` as deps re-trigger the effect (and therefore
    // an immediate poll) whenever the user sends a message OR compaction
    // shortens the history. The immediate poll is critical for the
    // post-compaction case — without it, the meter keeps showing the
    // pre-compaction count for up to `intervalMs` (default 2s), which is
    // long enough for the user to send another turn that re-triggers
    // compaction on the same stale number.
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [chatSessionId, isLocal, messagesRevision, compactionRevision, intervalMs]);

  return state;
}
