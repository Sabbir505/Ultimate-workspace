// The chat transcript's scroll engine, carved out of ChatView.tsx verbatim:
// stick-to-bottom latch with programmatic-pin suppression, measured live-edge
// pinning over the virtualized list, older-history prepend with anchor
// restore, smooth jump-to-latest glide, composer-dock wheel chaining,
// approval/question-card scroll anchoring, and the TurnNavigator's
// scroll-to-message registration.
//
// The list virtualizer itself is created in ChatView (it needs the derived
// render items), so the follow/pin pass reaches it through virtualizerImplRef
// — assigned during ChatView's render, i.e. always populated by the time any
// effect runs.
import { useCallback, useEffect, useRef, useState } from "react";
import { useElementHeight } from "../../hooks/useElementHeight";
import { setChatScrollToMessage } from "../../lib/chatScroll";

export function useTranscriptScroll({
  activeChatSessionId,
  isSplitView,
  hasMoreHistory,
  loadOlderMessages,
  loadOlderSplitMessages,
  messages,
  streaming,
  approvalKey,
  questionKey,
}: {
  activeChatSessionId: string | null;
  isSplitView: boolean;
  hasMoreHistory: boolean;
  loadOlderMessages: (sessionId: string) => Promise<unknown>;
  loadOlderSplitMessages: (sessionId: string) => Promise<unknown>;
  /** Dep-only: the follow/pin effect re-runs when the transcript changes. */
  messages: unknown;
  /** Dep-only: the follow/pin effect re-runs while tokens stream. */
  streaming: unknown;
  /** Pending approval/question card ids — their mount/unmount shrinks the
   *  viewport, so the anchor-restore effect re-runs when they flip. */
  approvalKey: string | null;
  questionKey: string | null;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // The composer dock FLOATS over the transcript, so the message list must
  // reserve the dock's real height as bottom padding — a hardcoded constant
  // goes stale the moment the composer grows a line or a queue/approval/
  // goal-loop chip stacks on top of it. Measured live instead.
  const [composerDockRef, composerDockHeight] = useElementHeight<HTMLDivElement>();
  // Live mirror of the virtualizer's totalSize. MEASURED (2026-08-27): the
  // virtualizer's measurement cache updates WITHOUT notifying React, so
  // `virtualizer.getTotalSize()` can return a STALE value at render time —
  // the sized wrapper div then renders too short, the absolutely-positioned
  // rows overflow it and define the scroll extent themselves, and the last
  // message can never scroll above the floating composer. The pin pass
  // keeps this state in sync so the render always has the true height via
  // Math.max().
  const [liveTotal, setLiveTotal] = useState(0);
  const liveTotalRef = useRef(0);
  // Whether new content should keep the view pinned to the bottom. Flipped
  // off as soon as the user scrolls up, so streaming tokens never yank the
  // scroll back down while they're reading history; flipped on again when
  // they scroll back to the bottom.
  const stickToBottomRef = useRef(true);
  // Mirrors of the derived render items + the list virtualizer, so the
  // scroll-to-message helper (registered once, above their definitions) can
  // reach the current values without stale closures.
  const itemsRef = useRef<Array<{ key: string; id?: number }>>([]);
  const virtualizerRef = useRef<{ scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto"; behavior?: "auto" | "smooth" }) => void } | null>(null);
  // The full virtualizer instance (needs getTotalSize + the size-cache poke),
  // assigned by ChatView during render — see the file header.
  const virtualizerImplRef = useRef<{ getTotalSize: () => number } | null>(null);
  // Currently-mounted virtual row elements by item key. Lets the structural-
  // change effect re-measure just the visible rows (see the structureSig
  // effect below) instead of wiping the whole measurement cache.
  const rowElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // Last-known real height per row key. Rows whose ref-measure was skipped
  // (the virtualizer skips element measures while its isScrolling flag is hot
  // — and the auto-follow scrollTop writes keep it hot through every stream)
  // keep their 160px estimate forever once they scroll out of the render
  // window: ResizeObserver never fires without a later resize, so nothing
  // corrects them. totalSize then under-counts real content height, and the
  // absolutely-positioned rows overflow past it — the typing indicator (which
  // sits right after totalSize) painted over earlier messages instead of
  // following the newest turn. We record each mounted row's offsetHeight here
  // and write it back into the virtualizer's size cache when the row unmounts.
  const rowHeightsRef = useRef<Map<string, number>>(new Map());

  const loadOlderRef = useRef(false);
  // Patch-tail-then-pin, published by the follow effect below so the scroll
  // handler (flip back to "at bottom") and the mount pass can invoke it too.
  const pinToLiveEdgeRef = useRef<(() => void) | null>(null);

  // Track whether the user is pinned near the bottom. Runs on every scroll
  // (user- or programmatic). Once they scroll up past the threshold, auto
  // follow is paused until they return to the bottom. Also: M7 — scrolling to
  // the very top of a paged session prepends the next older page while
  // holding the visual position steady.
  //
  // Auto-scroll ownership: `stickToBottomRef` is the single latch. It flips
  // to "free" ONLY from a scroll event that the user produced — the app's
  // own pin writes also emit scroll events, so each programmatic write arms
  // a short suppression window (programmaticPinUntilRef) during which those
  // self-inflicted events are ignored. Without the window, a mid-stream
  // measurement cascade (the virtualizer resizing rows around our pin
  // target) could momentarily read as "user scrolled away", flip the latch
  // off, and strand the viewport far from the content the turn ended with.
  const programmaticPinUntilRef = useRef(0);
  const PROGRAMMATIC_PIN_GUARD_MS = 120;
  // Last observed distance-from-bottom, maintained by handleScroll. The
  // approval/question-card anchor restore consumes it as the PRE-mutation
  // position (the card effect runs after React already committed the card,
  // so a live layout read there reflects the post-change layout).
  const distFromBottomRef = useRef<number | null>(null);
  // Timestamp until which a jump-to-latest SMOOTH animation owns the scroll.
  // While hot, patchTailAndPin must not write scrollTop directly — an instant
  // write would cut the animation to a snap. Cleared when the jump lands.
  const smoothScrollUntilRef = useRef(0);
  // True once the user has scrolled far enough above the live edge that the
  // streaming tail is out of sight — drives the jump-to-latest pill.
  const [awayFromLive, setAwayFromLive] = useState(false);
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    // Always record the freshest distance-from-bottom — even for events the
    // suppression guard ignores below. The approval/question-card anchor
    // restore reads this ref as the PRE-mutation scroll position (reading
    // layout inside the card effect runs AFTER React has already committed
    // the card, which made the restore a no-op).
    distFromBottomRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (performance.now() < programmaticPinUntilRef.current) return;
    const threshold = 80; // px from bottom to still count as "at bottom"
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const wasStuck = stickToBottomRef.current;
    stickToBottomRef.current = distanceFromBottom < threshold;
    // Jump-pill visibility: only when the live edge is meaningfully out of
    // view (>240px below the fold), not for small scroll jitters.
    setAwayFromLive(distanceFromBottom > 240);
    // Returning to the live edge re-runs the tail-size patch + pin — a
    // session that was stranded with its last turn behind the composer
    // heals the moment the user scrolls back down (the follow effect only
    // fires on message/dock changes, not on scroll).
    if (!wasStuck && stickToBottomRef.current) pinToLiveEdgeRef.current?.();

    // BUG FIX (jump-to-top on send): the prepend trigger used to fire on
    // `scrollTop < 120` alone — but a chat pinned to the bottom whose content
    // barely overflows ALSO sits at scrollTop < 120, so merely SENDING a
    // message (whose scroll events land here) silently prepended up to 200
    // estimated-tall rows above the viewport. The view suddenly showed the
    // oldest page and the anchor restore raced the virtualizer's measuring
    // cascade — reading as "the chat scrolled to the top". Only prepend when
    // the user actually scrolled AWAY from the live edge.
    if (
      container.scrollTop < 120 &&
      distanceFromBottom > threshold &&
      hasMoreHistory &&
      !loadOlderRef.current &&
      activeChatSessionId
    ) {
      loadOlderRef.current = true;
      const prevHeight = container.scrollHeight;
      const prevTop = container.scrollTop;
      const prepend = isSplitView
        ? loadOlderSplitMessages(activeChatSessionId)
        : loadOlderMessages(activeChatSessionId);
      void prepend.finally(() => {
        loadOlderRef.current = false;
        // Restore the visual anchor: prepended rows pushed everything down.
        requestAnimationFrame(() => {
          const el = messagesContainerRef.current;
          if (el) {
            el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
            programmaticPinUntilRef.current = performance.now() + PROGRAMMATIC_PIN_GUARD_MS;
          }
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMoreHistory, activeChatSessionId, isSplitView, loadOlderMessages, loadOlderSplitMessages]);

  /** The scrollTop that pins the viewport to the live edge, computed from
   *  MEASURED content — the last mounted virtual row plus the in-flow tail
   *  that follows the wrapper (task cards, proposal cards, error strip, the
   *  dock spacer) — clamped to the container's real scroll range. The
   *  wrapper div's style height can OVER-count (virtualizer 160px estimates,
   *  or a stale `liveTotal` carried across a session switch): pinning to raw
   *  scrollHeight then parks the viewport in blank space below the real
   *  content, which read as "scrolled excessively downward" on first contact
   *  with a chat. Returns plain max-scroll when the tail row isn't mounted
   *  (the virtual window hasn't reached the end yet) — converging across the
   *  settle frames as the tail mounts. */
  const pinTargetFor = useCallback((el: HTMLDivElement): number => {
    const maxScroll = el.scrollHeight - el.clientHeight;
    const rows = el.querySelectorAll<HTMLElement>("[data-index]");
    const last = rows[rows.length - 1];
    if (!last || itemsRef.current.length === 0) return maxScroll;
    if (Number(last.dataset.index) !== itemsRef.current.length - 1) return maxScroll;
    const elRect = el.getBoundingClientRect();
    const rowBottom = last.getBoundingClientRect().bottom - elRect.top + el.scrollTop;
    let tail = 0;
    const firstTail = last.parentElement?.nextElementSibling ?? null;
    if (firstTail) tail = 18; // .chat-messages flex gap before the tail stack
    for (let n: Element | null = firstTail; n; n = n.nextElementSibling) {
      tail += (n as HTMLElement).offsetHeight;
    }
    return Math.max(0, Math.min(maxScroll, rowBottom + tail - el.clientHeight));
  }, []);

  /** Jump-to-latest pill: glide smoothly down to the live edge instead of
   *  snapping. The virtualizer makes this more than one scrollTo call:
   *  rows mount as the viewport approaches them (the measured live edge
   *  moves), and async content (diagrams, highlighting) can grow the tail
   *  mid-flight — so a rAF settle loop keeps the animation owned (its own
   *  scroll events must not read as user intent, and the streaming follower
   *  must not write over it), re-aims when the edge moved, and finishes with
   *  one measured instant pin once the glide stops short or lands. */
  const jumpToLiveEdge = useCallback(() => {
    const el = messagesContainerRef.current;
    stickToBottomRef.current = true;
    setAwayFromLive(false);
    // Respect the OS reduced-motion preference: no glide, straight pin.
    if (
      !el ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    ) {
      pinToLiveEdgeRef.current?.();
      return;
    }

    // While hot, this guard doubles as the handleScroll suppression (its own
    // events ignored) and the patchTailAndPin stand-down (no snap writes).
    const GUARD_MS = PROGRAMMATIC_PIN_GUARD_MS + 60;
    const ownScroll = () => {
      const until = performance.now() + GUARD_MS;
      programmaticPinUntilRef.current = until;
      smoothScrollUntilRef.current = until;
    };

    let retries = 3; // re-aim budget: virtualizer mounting + tail growth
    let stableFrames = 0;
    let lastTop = el.scrollTop;
    let raf = 0;

    const done = () => {
      smoothScrollUntilRef.current = 0;
      // One final measured patch+pin: lands exactly on the live edge (≤1px
      // from where the glide left us when nothing moved) and re-runs the
      // tail-height patch the stand-down skipped.
      pinToLiveEdgeRef.current?.();
    };

    const step = () => {
      const target = pinTargetFor(el);
      if (Math.abs(el.scrollTop - target) <= 1) {
        done();
        return;
      }
      ownScroll();
      if (el.scrollTop !== lastTop) {
        stableFrames = 0;
        lastTop = el.scrollTop;
      } else if (++stableFrames >= 8) {
        // The glide stopped short of the live edge — the target moved out
        // from under it (rows mounted / tail grew) or the browser cut the
        // animation. Re-aim while budget remains, else finish instantly.
        if (retries-- > 0) {
          stableFrames = 0;
          el.scrollTo({ top: pinTargetFor(el), behavior: "smooth" });
          raf = requestAnimationFrame(step);
          return;
        }
        done();
        return;
      }
      raf = requestAnimationFrame(step);
    };

    el.scrollTo({ top: pinTargetFor(el), behavior: "smooth" });
    raf = requestAnimationFrame(step);
  }, []);

  // Follow new messages / streaming tokens only while pinned to the bottom.
  // Writes scrollTop directly instead of scrollIntoView: scrollIntoView also
  // repositions every scrollable ANCESTOR and can be hijacked mid-flight by
  // the virtualizer's own scroll corrections — both able to leave the list
  // stranded away from (or above) the live edge during a send/stream burst.
  //
  // The write is deferred one animation frame: the virtualizer materializes
  // the newly-mounted tail rows a LAYOUT PASS after `messages` changes, so
  // a synchronous write here reads the STALE scrollHeight and strands the
  // live edge behind the floating composer — exactly the "last turn is
  // stuck at the bottom of the screen under the composer" symptom. The
  // dock height is a dep too, so a dock that grows (queue chip, approval
  // card, extra input line) re-pins the view instead of eating the gap.
  useEffect(() => {
    const patchTailAndPin = () => {
      const el = messagesContainerRef.current;
      if (!el || !stickToBottomRef.current) return;
      const virt = virtualizerImplRef.current;
      if (!virt) return;
      // A jump-to-latest smooth animation owns the scroll while in flight —
      // the instant write below would cut the glide to a snap. The jump's
      // settle loop runs this once more itself when it lands.
      if (performance.now() < smoothScrollUntilRef.current) return;
      // MEASURED ROOT CAUSE (pad-debug overlay, 2026-08-27): the virtualizer's
      // sized wrapper div rendered with a STALE height (inner h=743 while
      // totalSize=3017) — its measurement cache was already correct, but no
      // React re-render ever applied it, so the absolutely-positioned rows
      // overflowed the div by ~2270px and defined the scroll extent
      // themselves. At max scroll that pins the last row's bottom to the
      // container's bottom edge — permanently dockHeight behind the floating
      // composer (GAP=-171 across every code state). Padding and in-flow
      // spacers can't win against positioned overflow, so sync the wrapper's
      // height DIRECTLY in the DOM from the live totalSize — no React
      // re-render required — before pinning.
      const rows = el.querySelectorAll<HTMLElement>("[data-index]");
      const last = rows[rows.length - 1];
      if (last && last.parentElement) {
        const inner = last.parentElement;
        const total = virt.getTotalSize();
        if (Math.abs(inner.offsetHeight - total) > 1) {
          // Instant DOM sync (next React render confirms it via liveTotal —
          // a plain React style write would otherwise clobber this with the
          // stale getTotalSize() it computes at render time).
          inner.style.setProperty("height", `${total}px`, "important");
        }
        // Push the true total into React state so the NEXT render bakes the
        // correct height into the JSX (Math.max below) even while
        // getTotalSize() still returns its stale value at render time.
        if (total !== liveTotalRef.current) {
          liveTotalRef.current = total;
          setLiveTotal(total);
        }
        // Secondary hardening: if the tail row is STILL taller than its
        // cached slot (async content growth — diagrams, highlighting —
        // measured after the cache settled), patch the cache with the real
        // height so the next layout pass stops under-allocating it.
        const overflow =
          last.getBoundingClientRect().bottom -
          last.parentElement.getBoundingClientRect().bottom;
        if (overflow > 1) {
          const v = virt as unknown as {
            itemSizeCache?: Map<string, number>;
            itemSizeCacheVersion?: number;
            notify?: (sync: boolean) => void;
          };
          let key: string | null = null;
          for (const [k, e] of rowElsRef.current) {
            if (e === last) {
              key = k;
              break;
            }
          }
          const realH = last.offsetHeight;
          if (key && realH > 0 && v.itemSizeCache && v.itemSizeCache.get(key) !== realH) {
            v.itemSizeCache.set(key, realH);
            if (v.itemSizeCacheVersion != null) v.itemSizeCacheVersion++;
            v.notify?.(false);
          }
        }
      }
      const target = pinTargetFor(el);
      // Skip the write when already at the live edge: redundant scrollTop
      // writes fire scroll events that keep the virtualizer's isScrolling
      // flag hot, which makes its element-measure pass SKIP rows mounting
      // mid-stream (the swapped-in persisted row after a turn ends).
      if (Math.abs(el.scrollTop - target) > 1) {
        el.scrollTop = target;
        // The scroll event this write produces must not be read as user
        // intent (see handleScroll).
        programmaticPinUntilRef.current = performance.now() + PROGRAMMATIC_PIN_GUARD_MS;
      }
    };
    pinToLiveEdgeRef.current = patchTailAndPin;
    if (!stickToBottomRef.current) return;
    // SETTLE WINDOW: re-run patch+pin across a short backoff (frames
    // 1,2,4,8,16,32 ≈ 0.5s at 60fps). One pass isn't enough — the tail row's
    // content can grow ASYNC after mount (mermaid diagrams, code highlight),
    // so a size patched at frame 1 can already be stale at frame 4; each
    // pass re-patches the cache and re-pins against the reflowed layout.
    const frames = [1, 2, 4, 8, 16, 32];
    let frame = 0;
    let raf = 0;
    const step = () => {
      patchTailAndPin();
      frame++;
      if (frame < frames.length) {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      pinToLiveEdgeRef.current = null;
    };
  }, [messages, streaming, composerDockHeight, pinTargetFor]);

  // Heal an already-stranded session on mount / fast-refresh reload: the
  // patch+pin above only fires on message/dock changes, but a chat saved in
  // the stuck state (last turn behind the composer) has none coming. The
  // second, later pass catches async content (diagrams, highlighting)
  // that lands after the first heal measured the tail row.
  useEffect(() => {
    const t1 = setTimeout(() => pinToLiveEdgeRef.current?.(), 350);
    const t2 = setTimeout(() => pinToLiveEdgeRef.current?.(), 1200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  // Switching sessions resets to the bottom of the new conversation — and
  // resets the measurement mirrors with it: `liveTotal` is a height from the
  // PREVIOUS session's virtualizer cache. Math.max(totalSize, liveTotal)
  // would otherwise inflate the new (possibly empty) chat's wrapper by the
  // old conversation's height, and the mount pin would slam the viewport
  // deep into that blank space — the "first message scrolls excessively
  // downward" report.
  useEffect(() => {
    stickToBottomRef.current = true;
    liveTotalRef.current = 0;
    setLiveTotal(0);
    setAwayFromLive(false);
  }, [activeChatSessionId]);

  // Wheel over the composer dock scrolls the transcript. The dock overlays
  // the bottom of the message list but is a SIBLING subtree of
  // .chat-messages, so the browser never chains wheel events into it — with
  // the composer focused (cursor parked at the bottom of the window) rolling
  // the wheel there did nothing and read as "the chat view isn't scrollable
  // while the composer is active". Chain the delta into .chat-messages, but
  // first let any scrollable element under the cursor (the textarea with
  // overflow, the slash menu, queue text) consume it — including honoring
  // its scroll edges so the leftover delta hands off naturally.
  useEffect(() => {
    const dock = composerDockRef.current;
    if (!dock) return;
    const onWheel = (e: WheelEvent) => {
      for (let n = e.target as Element | null; n && n !== dock; n = n.parentElement) {
        const el = n as HTMLElement;
        if (el.scrollHeight <= el.clientHeight + 1) continue;
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY !== "auto" && overflowY !== "scroll") continue;
        const atTop = el.scrollTop <= 0;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) return;
      }
      const view = dock.closest(".chat-view")?.querySelector(".chat-messages");
      if (!view) return;
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      view.scrollTop += delta;
      e.preventDefault();
    };
    dock.addEventListener("wheel", onWheel, { passive: false });
    return () => dock.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The per-action approval card sits below the message list in the composer
  // flex column. Mounting/unmounting it shrinks/grows the scroll viewport, and
  // the browser clamps scrollTop when the viewport shrinks — so the chat
  // appears to "jump to the top" when an approval card appears mid-stream.
  // Preserve the user's scroll anchor across approval-card mount/unmount.
  // A harness question card mounting/unmounting has the same viewport-shrink
  // effect as an approval card — include it in the anchor key.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    // Pinned to the live edge? Then after the card settles just slam to the
    // bottom (the follow effect does the same) — computing a restore offset
    // against a mid-layout snapshot is what let this effect fling the chat
    // upward when it fired while content heights were still settling.
    if (stickToBottomRef.current) {
      const raf = requestAnimationFrame(() => {
        const el = messagesContainerRef.current;
        if (el && stickToBottomRef.current) {
          el.scrollTop = pinTargetFor(el);
          programmaticPinUntilRef.current = performance.now() + PROGRAMMATIC_PIN_GUARD_MS;
        }
      });
      return () => cancelAnimationFrame(raf);
    }
    // Snapshot the relative scroll position (distance from bottom) BEFORE the
    // card's height change is reflected in the layout — read from the ref
    // handleScroll keeps updated (a live read here runs after React already
    // committed the card, which made this restore a no-op).
    const prevBottom =
      distFromBottomRef.current ??
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const raf = requestAnimationFrame(() => {
      // After the card mounts/unmounts, restore the same distance-from-bottom
      // so the chat content stays visually put. Clamp into the valid range —
      // a stale/negative target must never move scrollTop.
      const el = messagesContainerRef.current;
      if (!el) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.min(max, Math.max(0, el.scrollHeight - el.clientHeight - prevBottom));
    });
    return () => cancelAnimationFrame(raf);
  }, [approvalKey, questionKey, pinTargetFor]);

  // Register a scroll-to-message helper so the TurnNavigator can jump to a
  // specific turn. Sets stickToBottom OFF first so the auto-follow effect
  // doesn't yank the scroll back to the bottom while streaming. Keyed by THIS
  // view's session (split view registers its own); cleanup is owner-scoped so
  // one view closing can't disable the other's registration.
  useEffect(() => {
    setChatScrollToMessage(activeChatSessionId, (msgId: number) => {
      stickToBottomRef.current = false;
      // PERF (F5): with the message list virtualized, off-screen bubbles
      // aren't in the DOM — scroll the virtualizer to the message's index
      // instead of querySelector'ing a possibly-unmounted element.
      const idx = itemsRef.current.findIndex((i) => i.id === msgId);
      if (idx >= 0) {
        virtualizerRef.current?.scrollToIndex(idx, {
          align: "start",
          behavior: "smooth",
        });
      }
    });
    return () => setChatScrollToMessage(activeChatSessionId, null);
  }, [activeChatSessionId]);

  return {
    messagesEndRef,
    messagesContainerRef,
    composerDockRef,
    composerDockHeight,
    liveTotal,
    stickToBottomRef,
    itemsRef,
    virtualizerRef,
    virtualizerImplRef,
    rowElsRef,
    rowHeightsRef,
    awayFromLive,
    handleScroll,
    jumpToLiveEdge,
  };
}
