// Composer telemetry HUD — a status bar anchored to the bottom border of the
// composer card that surfaces per-session perf: input/output tokens, LLM time,
// tool time, TTFT, tok/s, and cache hit rate.
//
// Source of truth, by state:
//  • While streaming  → `livePerf[chatSessionId]` (the throttled `chat:perf`
//    event from the backend). Shows live tok/s + elapsed.
//  • Idle             → `sessionMetrics[chatSessionId]` (the
//    `get_chat_session_metrics` aggregate from the DB). Shows turn-count
//    averages / totals.
//
// Both are stored on `useChatStore`. The HUD always renders the same chip
// silhouette so the composer's height never jumps when a turn starts: idle
// metrics show a muted em-dash, active ones switch to a high-contrast tone.
import { useChatStore } from "../../state/chat";
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
    isLocal: boolean;
    localCtx?: number;
    liveMaxTokens?: number;
    chatSessionId?: string | null;
  };
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

interface MetricChipProps {
  label: string;
  value: string;
  /** When true, the chip pulses (live indicator). */
  live?: boolean;
  tone?: Tone;
  /** Hover breakdown explaining what the metric measures. */
  hint?: string;
}

function MetricChip({ label, value, live, tone = "idle", hint }: MetricChipProps) {
  const cls = [
    "composer-metrics-chip",
    live ? "is-live" : "",
    tone !== "idle" ? `tone-${tone}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} title={hint}>
      <span className="composer-metrics-chip-dot" />
      <span className="composer-metrics-chip-label">{label}</span>
      <span className="composer-metrics-chip-value">{value}</span>
      {hint && <span className="composer-metrics-tooltip" role="tooltip">{hint}</span>}
    </span>
  );
}

export function ComposerMetrics({ chatSessionId, streaming, variant = "row", contextMeter }: Props) {
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
  const chips: MetricChipProps[] = [];

  if (live) {
    // While streaming, always surface output tokens + speed even at zero so the
    // user can see the counter live-tick from the first token. The remaining
    // chips only render when they have a positive value (e.g. llm/tools/ttft
    // are null or 0 before the first measurement lands).
    chips.push({
      label: "out",
      value: fmtTokens(live.outputTokens) ?? "0 tok",
      live: true,
      tone: "tokens",
      hint: "Output tokens generated so far this turn",
    });
    chips.push({
      label: "speed",
      value: fmtTokPerSecond(live.tokensPerSecond ?? undefined) ?? "0 tok/s",
      live: true,
      tone: "speed",
      hint: "Live generation rate — output tokens divided by model time",
    });
    const llm = fmtMs(live.llmTimeMs);
    if (llm) chips.push({ label: "llm", value: llm, hint: "Model generation time this turn" });
    if (live.toolTimeMs > 0) {
      const t = fmtMs(live.toolTimeMs);
      if (t) chips.push({ label: "tools", value: t, hint: "Tool execution time this turn, excluding approval waits" });
    }
    if (live.ttftMs != null) {
      const ttft = fmtMs(live.ttftMs);
      if (ttft) chips.push({ label: "ttft", value: ttft, hint: "Time from turn start to the first streamed token" });
    }
    const elapsed = fmtMs(live.elapsedMs);
    if (elapsed) chips.push({ label: "elapsed", value: elapsed, live: true, hint: "Wall-clock time since this turn started" });
  } else if (last) {
    // Idle — the LAST turn's final numbers, so the row agrees with the
    // "Worked for Xs" label on the bubble above. Falls through to the
    // session aggregate when no turn has completed in this app run.
    const inp = fmtTokens(last.inputTokens);
    if (inp) chips.push({ label: "in", value: inp, tone: "tokens", hint: "Input tokens of the last completed turn" });
    const out = fmtTokens(last.outputTokens) ?? "0 tok";
    chips.push({ label: "out", value: out, tone: "tokens", hint: "Output tokens of the last completed turn" });
    const llm = fmtMs(last.llmTimeMs);
    if (llm) chips.push({ label: "llm", value: llm, hint: "Model generation time of the last completed turn" });
    if (last.toolTimeMs > 0) {
      const t = fmtMs(last.toolTimeMs);
      if (t) chips.push({ label: "tools", value: t, hint: "Tool execution time of the last completed turn, excluding approval waits" });
    }
    const ttft = fmtMs(last.ttftMs ?? undefined);
    if (ttft) chips.push({ label: "ttft", value: ttft, hint: "Time to first token of the last completed turn" });
    const tokS = fmtTokPerSecond(last.tokensPerSecond ?? undefined);
    if (tokS) chips.push({ label: "speed", value: tokS, tone: "speed", hint: "Generation rate of the last completed turn" });
    const cache = fmtPct(last.cacheHitRate ?? undefined);
    if (cache) {
      chips.push({
        label: "cache",
        value: cache,
        tone: "cache",
        hint: `${cache} of the last turn's input tokens were served from the prompt cache`,
      });
    }
  } else if (agg) {
    // Idle — show session totals / averages.
    const inp = fmtTokens(agg.inputTokens);
    if (inp) chips.push({ label: "in", value: inp, tone: "tokens", hint: "Total input tokens sent across this session" });
    const out = fmtTokens(agg.outputTokens);
    if (out) chips.push({ label: "out", value: out, tone: "tokens", hint: "Total output tokens generated across this session" });
    const llm = fmtMs(agg.llmTimeMs ?? undefined);
    if (llm) chips.push({ label: "llm", value: llm, hint: "Total model generation time across this session" });
    if ((agg.toolTimeMs ?? 0) > 0) {
      const t = fmtMs(agg.toolTimeMs ?? undefined);
      if (t) chips.push({ label: "tools", value: t, hint: "Total tool execution time across this session, excluding approval waits" });
    }
    if (agg.ttftAvgMs != null) {
      const ttft = fmtMs(agg.ttftAvgMs ?? undefined);
      if (ttft) chips.push({ label: "ttft", value: ttft, hint: "Average time to first token across this session" });
    }
    const tokS = fmtTokPerSecond(agg.tokensPerSecond ?? undefined);
    if (tokS) chips.push({ label: "speed", value: tokS, tone: "speed", hint: "Average generation rate, weighted by output tokens" });
    const cache = fmtPct(agg.cacheHitRate ?? undefined);
    if (cache) {
      chips.push({
        label: "cache",
        value: cache,
        tone: "cache",
        hint: `${cache} of input tokens were served from the prompt cache`,
      });
    }
    if (agg.turnCount > 0) chips.push({ label: "turns", value: `${agg.turnCount}`, hint: "Completed turns in this session" });
  }

  // Always render the bar — even on a fresh chat or one with no data yet — so
  // the composer's height doesn't jump when the first turn starts. The
  // placeholders keep the same chip silhouette, just muted with an em-dash.
  if (chips.length === 0) {
    return (
      <div className={`${rowClass} is-empty`} role="status" aria-live="polite">
        <div className="composer-metrics-chips">
          <MetricChip label="in" value="—" hint="Input tokens sent — no turns yet" />
          <MetricChip label="out" value="—" hint="Output tokens generated — no turns yet" />
          <MetricChip label="llm" value="—" hint="Model generation time — no turns yet" />
          <MetricChip label="tools" value="—" hint="Tool execution time — no turns yet" />
          <MetricChip label="ttft" value="—" hint="Time to first token — no turns yet" />
          <MetricChip label="speed" value="—" hint="Generation rate — no turns yet" />
          <MetricChip label="cache" value="—" hint="Prompt cache hit rate — no turns yet" />
        </div>
        {contextMeter && (
          <div className="composer-metrics-context-wrap">
            <ContextMeter
              usedTokens={contextMeter.usedTokens}
              model={contextMeter.model}
              isLocal={contextMeter.isLocal}
              localCtx={contextMeter.localCtx}
              liveMaxTokens={contextMeter.liveMaxTokens}
              chatSessionId={contextMeter.chatSessionId}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={rowClass} role="status" aria-live="polite">
      <div className="composer-metrics-chips">
        {chips.map((c, i) => (
          <MetricChip key={`${c.label}-${i}`} {...c} />
        ))}
      </div>
      {contextMeter && (
        <div className="composer-metrics-context-wrap">
          <ContextMeter
            usedTokens={contextMeter.usedTokens}
            model={contextMeter.model}
            isLocal={contextMeter.isLocal}
            localCtx={contextMeter.localCtx}
            liveMaxTokens={contextMeter.liveMaxTokens}
            chatSessionId={contextMeter.chatSessionId}
          />
        </div>
      )}
    </div>
  );
}
