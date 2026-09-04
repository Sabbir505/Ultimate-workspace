// Composer telemetry HUD — a status bar anchored to the bottom border of the
// composer card that surfaces per-session perf: input/output tokens, LLM time,
// tool time, TTFT, tok/s, and cache hit rate.
//
// Source of truth, by state:
//  • While streaming  → `livePerf[chatSessionId]` (the throttled `chat:perf`
//    event from the backend), carried over from `lastTurnPerf` until each
//    metric's own measurement lands.
//  • Idle             → `lastTurnPerf[chatSessionId]` (the final numbers of
//    the turn just watched), falling back to `sessionMetrics[chatSessionId]`
//    (the `get_chat_session_metrics` aggregate from the DB).
//
// The HUD renders a FIXED chip grid: every state draws the same chips in the
// same order, so a turn starting or ending never reflows the row. A metric
// without data shows an em-dash; a real zero shows as zero. When a new turn
// starts, metrics that the backend hasn't measured yet keep the last turn's
// value (per-metric carry-over below) instead of collapsing to zero — each
// chip ticks over to the live number only once the backend reports it.
import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStore } from "../../state/chat";
import type { LastTurnMetrics } from "../../state/chat";
import type { ChatPerfPayload, ChatSessionMetricsPayload } from "../../lib/ipc";
import { useUiStore } from "../../state/ui";
import { ContextMeter } from "./ContextMeter";

interface Props {
  chatSessionId: string | null;
  streaming: boolean;
  /** "hud" renders the bordered status bar docked inside the composer card. */
  variant?: "hud" | "row";
  /** Context meter props — passed through to render the circular meter inline. */
  contextMeter?: {
    usedTokens: number | null;
    model: string | undefined | null;
    provider?: string | null;
    isLocal: boolean;
    localCtx?: number;
    liveMaxTokens?: number;
    chatSessionId?: string | null;
    /** User's cloud context-window cap (tokens, 0/undefined = auto). */
    contextLimitOverride?: number;
    /** The active model's PINNED window (Settings → Model list) —
     *  authoritative: it replaces the registry/live figure entirely. */
    pinnedWindow?: number;
  };
}

function fmtMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms === 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function fmtTokens(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n === 0) return "0 tok";
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k tok`;
  return `${(n / 1_000_000).toFixed(1)}M tok`;
}

function fmtTokPerSecond(t: number | null | undefined): string | null {
  if (t == null || !Number.isFinite(t) || t < 0) return null;
  if (t === 0) return "0 tok/s";
  return `${t.toFixed(t < 10 ? 1 : 0)} tok/s`;
}

function fmtPct(p: number | null | undefined): string | null {
  if (p == null || !Number.isFinite(p) || p < 0) return null;
  return `${Math.round(p * 100)}%`;
}

/** Tone drives the chip's value color: cache→green, speed/tokens→cyan. */
type Tone = "idle" | "speed" | "cache" | "tokens";

/** The fixed chip slots, in render order. Every state (fresh, aggregate,
 *  last-turn, live) renders ALL of them, so a chip's position on screen is
 *  constant across turn boundaries. `turns` is aggregate-only and appended
 *  after `elapsed`, so its appearance can never shift the slots before it. */
const CHIP_ORDER = [
  "in",
  "out",
  "llm",
  "tools",
  "ttft",
  "speed",
  "cache",
  "elapsed",
] as const;
type ChipKey = (typeof CHIP_ORDER)[number];

const CHIP_HINTS: Record<ChipKey | "turns", string> = {
  in: "Prompt tokens billed — accumulates at each tool round",
  out: "Output tokens generated",
  llm: "Model round time (connect + prompt eval + generation)",
  tools: "Tool execution time, excluding approval waits",
  ttft: "Time from the model request to the first streamed token",
  speed: "Decode rate — output tokens divided by generation time (prefill excluded)",
  cache: "Share of prompt tokens served from the prompt cache",
  elapsed: "Wall-clock time of the current or last turn",
  turns: "Completed turns in this session",
};

const CHIP_TONES: Record<ChipKey | "turns", Tone> = {
  in: "tokens",
  out: "tokens",
  llm: "idle",
  tools: "idle",
  ttft: "idle",
  speed: "speed",
  cache: "cache",
  elapsed: "idle",
  turns: "idle",
};

interface MetricChipProps {
  label: string;
  value: string;
  /** When true, the chip pulses (live indicator). */
  live?: boolean;
  tone?: Tone;
  /** Hover breakdown explaining what the metric measures. */
  hint?: string;
}

/** Half the tooltip's max-width (+margin), used to clamp its fixed position
 *  so the panel can never leave the viewport, whichever chip is hovered. */
const TIP_HALF = 124;

function MetricChip({ label, value, live, tone = "idle", hint }: MetricChipProps) {
  const chipRef = useRef<HTMLSpanElement>(null);
  // Fixed-viewport position for the portaled tooltip, computed from the
  // chip's rect at hover time (same approach as .context-meter-panel).
  const [tipPos, setTipPos] = useState<{ left: number; bottom: number } | null>(null);
  const setContextTipOpen = useUiStore((s) => s.setContextTipOpen);

  // While the portaled tooltip shows, tell native browser webviews to hide:
  // they float above ALL DOM, so no z-index could lift the tooltip over them
  // (same contract as the context-meter panel). Unmount-clears so a mid-hover
  // unmount can't strand the flag true.
  useEffect(() => {
    if (!tipPos) return;
    setContextTipOpen(true);
    return () => setContextTipOpen(false);
  }, [tipPos, setContextTipOpen]);

  const onHover = () => {
    const el = chipRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Center above the chip, clamped to the viewport; the HUD sits at the
    // composer card's bottom edge, so the tooltip opens upward.
    const left = Math.min(
      Math.max(r.left + r.width / 2, TIP_HALF),
      window.innerWidth - TIP_HALF,
    );
    setTipPos({ left, bottom: window.innerHeight - r.top + 6 });
  };

  const cls = [
    "composer-metrics-chip",
    live ? "is-live" : "",
    tone !== "idle" ? `tone-${tone}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      ref={chipRef}
      className={cls}
      onMouseEnter={onHover}
      onMouseLeave={() => setTipPos(null)}
    >
      <span className="composer-metrics-chip-dot" />
      <span className="composer-metrics-chip-label">{label}</span>
      <span className="composer-metrics-chip-value">{value}</span>
      {hint && tipPos &&
        createPortal(
          <span
            className="composer-metrics-tooltip"
            role="tooltip"
            style={{ left: tipPos.left, bottom: tipPos.bottom }}
          >
            {hint}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** One chip slot's display state: the raw metric value (null → em-dash) and
 *  whether the value is fed by the CURRENT turn's live measurement (pulses).
 *  `liveFed` is false for values carried over from the last completed turn —
 *  they hold the row steady until this turn's own number replaces them. */
interface Slot {
  value: number | null;
  liveFed: boolean;
}

/** Per-metric carry-over: while streaming, a metric the backend hasn't
 *  measured yet this turn (null, or 0 before its first update) falls back to
 *  the last completed turn's value, so the row never resets to zeros at turn
 *  start. Each slot flips to live (and starts pulsing) on the backend's first
 *  report for this turn. */
function buildSlots(
  live: ChatPerfPayload | undefined,
  last: LastTurnMetrics | undefined,
  agg: ChatSessionMetricsPayload | undefined,
): Record<ChipKey | "turns", Slot> {
  const base = last;
  const dash: Slot = { value: null, liveFed: false };
  // Idle fallback per slot, resolved once: last-turn first, then aggregate.
  const idle = (l: number | null | undefined, a: number | null | undefined): Slot => {
    const n = (last ? l : a) ?? null;
    return { value: n, liveFed: false };
  };
  // Live per-metric: this turn's measurement, else the carried-over value.
  const liveSlot = (cur: number | null | undefined, prev: number | null | undefined): Slot => {
    if (cur != null) return { value: cur, liveFed: true };
    return { value: prev ?? null, liveFed: false };
  };
  // Counters that start the turn at a hard 0 (not null) carry the previous
  // value until their first non-zero update — 0 is "not measured yet", since
  // the backend writes cumulative numbers from the first event onward.
  const liveFromZero = (cur: number, prev: number | null | undefined): Slot =>
    cur > 0 ? { value: cur, liveFed: true } : { value: prev ?? cur, liveFed: false };

  const slots = {
    in: live
      ? liveSlot(live.inputTokens, base?.inputTokens)
      : idle(last?.inputTokens, agg?.inputTokens ?? null),
    out: live
      ? liveFromZero(live.outputTokens, base?.outputTokens)
      : idle(last?.outputTokens, agg?.outputTokens ?? null),
    llm: live
      ? liveFromZero(live.llmTimeMs, base?.llmTimeMs)
      : idle(last?.llmTimeMs, agg?.llmTimeMs ?? null),
    tools: live
      ? liveFromZero(live.toolTimeMs, base?.toolTimeMs)
      : idle(last?.toolTimeMs, agg?.toolTimeMs ?? null),
    ttft: live
      ? liveSlot(live.ttftMs, base?.ttftMs)
      : idle(last?.ttftMs, agg?.ttftAvgMs ?? null),
    speed: live
      ? liveSlot(live.tokensPerSecond, base?.tokensPerSecond)
      : idle(last?.tokensPerSecond, agg?.tokensPerSecond ?? null),
    cache: live
      ? liveSlot(live.cacheHitRate, base?.cacheHitRate)
      : idle(last?.cacheHitRate, agg?.cacheHitRate ?? null),
    elapsed: live
      ? { value: live.elapsedMs, liveFed: true }
      : { value: last?.elapsedMs ?? null, liveFed: false },
    turns:
      !live && !last && agg && agg.turnCount > 0
        ? { value: agg.turnCount, liveFed: false }
        : dash,
  };
  return slots;
}

function fmtSlotValue(key: ChipKey, n: number | null | undefined): string | null {
  switch (key) {
    case "in":
    case "out":
      return fmtTokens(n);
    case "llm":
    case "tools":
    case "ttft":
    case "elapsed":
      return fmtMs(n);
    case "speed":
      return fmtTokPerSecond(n);
    case "cache":
      return fmtPct(n);
  }
}

function ComposerMetricsInner({ chatSessionId, streaming, variant = "row", contextMeter }: Props) {
  // Pick the source: live snapshot while streaming, otherwise the LAST
  // completed turn's final numbers (matching the "Worked for Xs" just
  // watched), falling back to the persisted session aggregate. Selecting all
  // three keeps the row reactive mid-turn while still rendering something
  // useful on idle chats that have past turns.
  const live = useChatStore((s) =>
    chatSessionId ? s.livePerf[chatSessionId] : undefined,
  );
  const last = useChatStore((s) =>
    chatSessionId ? s.lastTurnPerf[chatSessionId] : undefined,
  );
  const agg = useChatStore((s) =>
    chatSessionId ? s.sessionMetrics[chatSessionId] : undefined,
  );

  if (!chatSessionId) return null;

  const rowClass = variant === "hud" ? "composer-metrics-row is-hud" : "composer-metrics-row";
  const slots = buildSlots(live, last, agg);

  // FIXED grid: every slot renders in every state — "—" when there is no
  // data, a real zero as zero — so positions never shift across turns.
  const chips: MetricChipProps[] = CHIP_ORDER.map((key) => {
    const slot = slots[key];
    return {
      label: key,
      value: fmtSlotValue(key, slot.value) ?? "—",
      live: slot.liveFed,
      tone: CHIP_TONES[key],
      hint: CHIP_HINTS[key],
    };
  });
  if (slots.turns.value != null) {
    chips.push({
      label: "turns",
      value: `${slots.turns.value}`,
      tone: CHIP_TONES.turns,
      hint: CHIP_HINTS.turns,
    });
  }

  const hasAnyData = chips.some((c) => c.value !== "—");
  if (!hasAnyData) {
    return (
      <div className={`${rowClass} is-empty`} role="status" aria-live="polite">
        <div className="composer-metrics-chips">
          {chips.map((c) => (
            <MetricChip key={c.label} {...c} />
          ))}
        </div>
        {contextMeter && (
          <div className="composer-metrics-context-wrap">
            <ContextMeter
              usedTokens={contextMeter.usedTokens}
              model={contextMeter.model}
              provider={contextMeter.provider}
              isLocal={contextMeter.isLocal}
              localCtx={contextMeter.localCtx}
              liveMaxTokens={contextMeter.liveMaxTokens}
              chatSessionId={contextMeter.chatSessionId}
              contextLimitOverride={contextMeter.contextLimitOverride}
              pinnedWindow={contextMeter.pinnedWindow}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={rowClass} role="status" aria-live="polite">
      <div className="composer-metrics-chips">
        {chips.map((c) => (
          <MetricChip key={c.label} {...c} />
        ))}
      </div>
      {contextMeter && (
        <div className="composer-metrics-context-wrap">
          <ContextMeter
            usedTokens={contextMeter.usedTokens}
            model={contextMeter.model}
            provider={contextMeter.provider}
            isLocal={contextMeter.isLocal}
            localCtx={contextMeter.localCtx}
            liveMaxTokens={contextMeter.liveMaxTokens}
            chatSessionId={contextMeter.chatSessionId}
            contextLimitOverride={contextMeter.contextLimitOverride}
            pinnedWindow={contextMeter.pinnedWindow}
          />
        </div>
      )}
    </div>
  );
}

// Memoized (PERF): the HUD lives inside the composer, which re-renders on
// every keystroke. With a stable contextMeter object (memoized by
// ChatComposer) and stable primitives, memo skips the whole chips row +
// ContextMeter subtree on typing re-renders.
export const ComposerMetrics = memo(ComposerMetricsInner);
