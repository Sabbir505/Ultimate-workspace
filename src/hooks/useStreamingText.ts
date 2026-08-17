import { useEffect, useRef, useState, useTransition } from "react";

/**
 * Minimal push-stream the hook can subscribe to. Both a real `Observable`
 * and any object with a `subscribe(cb) -> unsub` method satisfy this.
 * The frontend's chat-token channel adapter (see `lib/channels.ts`) wraps
 * the Tauri `Channel.onmessage` in this shape.
 */
export interface StreamLike<T> {
  subscribe(cb: (chunk: T) => void): () => void;
}

export interface UseStreamingTextOpts<T = string> {
  /** Initial text the hook starts with (e.g. the persisted partial message). */
  initial: string;
  /** Source of incoming chunks. Each chunk is appended to the displayed text. */
  incoming$: StreamLike<T>;
  /**
   * Optional transform: turn a raw chunk into the text to append. Default
   * identity (the chunk is a string). Useful when the upstream payload is
   * `{ token: string }` and you want to extract `.token` here.
   */
  toText?: (chunk: T) => string;
}

/**
 * Streaming text buffer with rAF-aligned flushing + useTransition.
 *
 * Why this exists (PERFORMANCE_AUDIT.md F8 / mobile C6): the naive pattern
 * of `setState(s => ({ ...s, streaming: s.streaming + token }))` per token
 * fires a React render at the producer's rate (50-200/sec during fast
 * streams). This hook:
 *   1. Buffers incoming chunks in a `useRef` (no React re-render per chunk)
 *   2. Schedules a single `requestAnimationFrame` flush per frame, regardless
 *      of how many chunks landed
 *   3. Wraps the state update in `useTransition` so the UI stays responsive
 *      to user input (scrolling, typing) even during a 60Hz stream
 *   4. Caps the rAF chain to one pending frame — if a flush is in flight,
 *      subsequent chunks just append to the buffer and get picked up by
 *      the next frame's flush
 *
 * Returns the displayed text + a `reset(initial)` for clean transitions
 * (e.g. when the user switches to a new chat session).
 */
export function useStreamingText<T = string>({
  initial,
  incoming$,
  toText,
}: UseStreamingTextOpts<T>): {
  displayed: string;
  reset: (next: string) => void;
  isStreaming: boolean;
} {
  const [displayed, setDisplayed] = useState(initial);
  const [, startTransition] = useTransition();
  const buffer = useRef("");
  const rafId = useRef<number | null>(null);
  const streaming = useRef(false);
  // Bumped by reset(). A flush that was scheduled (or whose transition update
  // was queued) before a reset must not resurrect the old session's text on
  // top of the new one — the flush checks the epoch it captured at schedule
  // time and discards itself when reset happened in between.
  const epoch = useRef(0);

  useEffect(() => {
    const transform = toText ?? ((c: unknown) => c as string);
    const unsub = incoming$.subscribe((chunk) => {
      streaming.current = true;
      const text = transform(chunk);
      if (!text) return;
      buffer.current += text;
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = null;
          const flushed = buffer.current;
          buffer.current = "";
          if (!flushed) return;
          const flushEpoch = epoch.current;
          // Functional update (not a displayedRef snapshot): a snapshot can
          // go stale when a previous transition hasn't committed yet, and a
          // second frame's flush would then overwrite the first flush's
          // pending update — silently dropping streamed text. The epoch guard
          // makes a flush queued just before reset() a no-op instead of
          // resurrecting the pre-reset text.
          startTransition(() => {
            if (epoch.current !== flushEpoch) return;
            setDisplayed((prev) => prev + flushed);
          });
        });
      }
    });
    return () => {
      unsub();
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
    };
    // We intentionally only subscribe once. The `incoming$` reference is
    // expected to be stable for the lifetime of the chat session (the
    // Tauri Channel is created once per pane/session open).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming$]);

  // Heartbeat the `isStreaming` boolean — flips false ~250ms after the last
  // chunk so a paused stream surfaces as not-streaming without the producer
  // having to send a sentinel. Also reads `streaming.current` for the live
  // status.
  const [isStreaming, setIsStreaming] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      if (streaming.current) {
        streaming.current = false;
        setIsStreaming(true);
      } else if (isStreaming) {
        setIsStreaming(false);
      }
    }, 250);
    return () => clearInterval(id);
  }, [isStreaming]);

  return {
    displayed,
    reset: (next: string) => {
      // Invalidate any flush that was already scheduled or queued — its
      // text belongs to the previous stream and must not land on `next`.
      epoch.current += 1;
      buffer.current = "";
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
      setDisplayed(next);
    },
    isStreaming,
  };
}
