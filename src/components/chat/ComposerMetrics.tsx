// Composer metrics row — a slim strip directly below the context-meter row in
// the chat composer that surfaces per-session perf: LLM time, tool time, TTFT
// (avg), live tok/s while streaming, and cache hit rate. Renders nothing when
// there are no metrics to show (no turns yet, no live stream) so fresh chats
// stay clean.
//
// Source of truth, by state:
//  • While streaming  → `livePerf[chatSessionId]` (the throttled `chat:perf`
//    event from the backend). Shows live tok/s + elapsed.
//  • Idle             → `sessionMetrics[chatSessionId]` (the
//    `get_chat_session_metrics` aggregate from the DB). Shows turn-count
//    averages / totals.
//
// Both are stored on `useChatStore`. The row is intentionally compact: a few
// small chips with a leading dot, mirroring the context-meter's sizing.
import { useChatStore } from "../../state/chat";

interface Props {
  chatSessionId: string | null;
  streaming: boolean;
}

function fmtMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function fmtTokPerSecond(t: number | null | undefined): string | null {
  if (t == null || !Number.isFinite(t) || t <= 0) return null;
  return `${t.toFixed(t < 10 ? 1 : 0)} tok/s`;
}

function fmtPct(p: number | null | undefined): string | null {
  if (p == null || !Number.isFinite(p) || p < 0) return null;
  return `${Math.round(p * 100)}% cache`;
}

function fmtTokens(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k tok`;
  return `${(n / 1_000_000).toFixed(1)}M tok`;
}

interface MetricChipProps {
  label: string;
  value: string;
  /** When true, the chip pulses (live indicator). */
  live?: boolean;
}

function MetricChip({ label, value, live }: MetricChipProps) {
  return (
    <span className={`composer-metrics-chip${live ? " is-live" : ""}`}>
      <span className="composer-metrics-chip-dot" />
      <span className="composer-metrics-chip-label">{label}</span>
      <span className="composer-metrics-chip-value">{value}</span>
    </span>
  );
}

export function ComposerMetrics({ chatSessionId, streaming }: Props) {
  // Pick the source: live snapshot while streaming, otherwise the persisted
  // session aggregate. Selecting both keeps the row reactive mid-turn while
  // still rendering something useful on idle chats that have past turns.
  const live = useChatStore((s) =>
    chatSessionId ? s.livePerf[chatSessionId] : undefined,
  );
  const agg = useChatStore((s) =>
    chatSessionId ? s.sessionMetrics[chatSessionId] : undefined,
  );

  if (!chatSessionId) return null;

  const chips: MetricChipProps[] = [];

  if (streaming && live) {
    // Live turn — show what's moving: tok/s, elapsed, TTFT. While the turn
    // is just starting (TTFT not yet known, no tokens counted) fall through
    // to the placeholder set below so the row layout stays stable instead
    // of collapsing to nothing.
    const tokS = fmtTokPerSecond(live.tokensPerSecond ?? undefined);
    if (tokS) chips.push({ label: "speed", value: tokS, live: true });
    const llm = fmtMs(live.llmTimeMs);
    if (llm) chips.push({ label: "llm", value: llm });
    if (live.toolTimeMs > 0) {
      const t = fmtMs(live.toolTimeMs);
      if (t) chips.push({ label: "tools", value: t });
    }
    if (live.ttftMs != null) {
      const ttft = fmtMs(live.ttftMs);
      if (ttft) chips.push({ label: "ttft", value: ttft });
    }
    const elapsed = fmtMs(live.elapsedMs);
    if (elapsed) chips.push({ label: "elapsed", value: elapsed, live: true });
  } else if (agg) {
    // Idle — show session averages.
    const llm = fmtMs(agg.llmTimeMs ?? undefined);
    if (llm) chips.push({ label: "llm total", value: llm });
    if ((agg.toolTimeMs ?? 0) > 0) {
      const t = fmtMs(agg.toolTimeMs ?? undefined);
      if (t) chips.push({ label: "tools total", value: t });
    }
    if (agg.ttftAvgMs != null) {
      const ttft = fmtMs(agg.ttftAvgMs ?? undefined);
      if (ttft) chips.push({ label: "ttft avg", value: ttft });
    }
    // Aggregate tok/s, weighted by output tokens, is more stable than the live
    // value — show with one decimal under 10 for granularity.
    const tokS = fmtTokPerSecond(agg.tokensPerSecond ?? undefined);
    if (tokS) chips.push({ label: "speed avg", value: tokS });
    const cache = fmtPct(agg.cacheHitRate ?? undefined);
    if (cache) chips.push({ label: "cache", value: cache });
    if (agg.turnCount > 0) {
      const out = fmtTokens(agg.outputTokens);
      if (out) chips.push({ label: "out", value: out });
    }
  }

  // Always render the row — even on a fresh chat or one with no data yet — so
  // the composer's footer height doesn't jump when the first turn starts. The
  // placeholders keep the same chip silhouette (dot + uppercase label + value
  // slot), just dimmed with an em-dash where the number would go.
  if (chips.length === 0) {
    return (
      <div className="composer-metrics-row is-empty" role="status" aria-live="polite">
        <MetricChip label="llm" value="—" />
        <MetricChip label="tools" value="—" />
        <MetricChip label="ttft" value="—" />
        <MetricChip label="speed" value="—" />
        <MetricChip label="cache" value="—" />
      </div>
    );
  }

  return (
    <div className="composer-metrics-row" role="status" aria-live="polite">
      {chips.map((c, i) => (
        <MetricChip key={`${c.label}-${i}`} {...c} />
      ))}
    </div>
  );
}
