// Circular context-window meter for the chat composer, sitting below the send
// button. An SVG ring fills proportionally to how much of the active model's
// context window the last turn consumed; the percentage shows in the center.
// Always rendered (even before the first turn, where it shows 0%) so the
// affordance is stable.
//
// On hover a rich breakdown panel appears (for local models) showing the model
// name, the used/max window with percentage, a slider bar visualizing fill,
// and per-category rows (messages, system prompt, tools, MCP tools, skills,
// metacontext), each with its own mini bar + percentage.
//
// Sizing:
//  - Local LLM (local_gguf): the cap is the context size from the composer's
//    Context slider (localCtx); 0/Auto falls back to a default.
//  - API/cloud models: a flat 256K cap.
//
// The "used" figure is the input_tokens of the last assistant turn (the full
// prompt size the provider counted), passed in from ChatView. 0 until the
// first turn completes.
import { useRef, useState } from "react";
import { contextWindowFor, formatTokens } from "../../lib/contextWindow";
import { countContextBreakdown, type ContextBreakdown } from "../../lib/ipc";

interface Props {
  usedTokens: number | null;
  model: string | undefined | null;
  isLocal: boolean;
  localCtx?: number;
  /** Live context-window cap from the running llama-server. Takes precedence
   *  over the slider-derived cap for local sessions so the meter matches
   *  what the model actually has — the slider value only changes after a
   *  model restart, so without this we'd be showing a stale cap whenever
   *  the user moves the slider but hasn't yet restarted. */
  liveMaxTokens?: number;
  /** Active chat session, used to fetch the per-category token breakdown. */
  chatSessionId?: string | null;
}

const PCT_WARN = 0.7;
const PCT_CRIT = 0.9;

// Ring geometry (viewBox 36x36, stroke width 4 → radius 16, circumference ~100).
const R = 16;
const CIRC = 2 * Math.PI * R;

interface Row {
  label: string;
  tokens: number;
}

export function ContextMeter({ usedTokens, model, isLocal, localCtx, liveMaxTokens, chatSessionId }: Props) {
  const used = usedTokens && usedTokens > 0 ? usedTokens : 0;
  // Prefer the live cap (what llama-server was actually started with) over
  // the slider-derived cap. Falls back to the slider / 16K default for the
  // brief window before the first poll resolves, and for cloud sessions
  // where `liveMaxTokens` is 0.
  const max = (isLocal && liveMaxTokens && liveMaxTokens > 0)
    ? liveMaxTokens
    : contextWindowFor(model, isLocal, localCtx);
  const pct = max > 0 ? Math.min(1, used / max) : 0;
  const level = pct >= PCT_CRIT ? "crit" : pct >= PCT_WARN ? "warn" : "ok";
  // Dash the circle so the filled portion grows from the top clockwise.
  const dash = CIRC * pct;
  const title = used > 0
    ? `Context: ${formatTokens(used)} of ${formatTokens(max)} tokens (${Math.round(pct * 100)}%)`
    : `Context window: ${formatTokens(max)} — updates after the first reply`;

  // Rich breakdown panel state — fetched lazily on hover so we don't pay the
  // tokenize round-trips on every render/poll.
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null | undefined>(undefined);
  const [showPanel, setShowPanel] = useState(false);
  const breakdownKey = chatSessionId ?? "";
  const lastKey = useRef(breakdownKey);
  if (lastKey.current !== breakdownKey) {
    lastKey.current = breakdownKey;
    setBreakdown(undefined); // session changed — refetch on next hover
  }

  const onHover = () => {
    setShowPanel(true);
    if (breakdown === undefined && chatSessionId) {
      countContextBreakdown(chatSessionId)
        .then((b) => setBreakdown(b))
        .catch(() => setBreakdown(null));
    }
  };

  const rows: Row[] = breakdown
    ? [
        { label: "Messages", tokens: breakdown.messagesTokens },
        { label: "System Prompt", tokens: breakdown.systemPromptTokens },
        { label: "Tools", tokens: breakdown.toolSpecsTokens },
        { label: "MCP Tools", tokens: breakdown.connectorToolsTokens },
        { label: "Skills", tokens: breakdown.skillsTokens },
        { label: "Metacontext", tokens: breakdown.metacontextTokens },
      ]
    : [];

  const panelMax = breakdown ? breakdown.maxTokens : max;

  return (
    <div
      className={`context-meter-circle ${level}`}
      title={title}
      role="img"
      aria-label={`Context ${Math.round(pct * 100)}% used`}
      onMouseEnter={onHover}
      onMouseLeave={() => setShowPanel(false)}
    >
      <svg viewBox="0 0 36 36" className="context-meter-ring">
        <circle
          className="context-meter-track"
          cx="18"
          cy="18"
          r={R}
          fill="none"
          strokeWidth="4"
        />
        <circle
          className="context-meter-progress"
          cx="18"
          cy="18"
          r={R}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRC}`}
          // Rotate -90deg so the fill starts at the top (12 o'clock).
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span className="context-meter-pct">{Math.round(pct * 100)}</span>

      {showPanel && (
        <div className="context-meter-panel">
          <div className="context-meter-panel-model" title={model ?? ""}>
            {model ? `Model: ${model}` : "Model: —"}
          </div>
          <div className="context-meter-panel-meta">
            <span>{formatTokens(used)}</span>
            <span className="context-meter-panel-total"> / {formatTokens(max)}</span>
            <span className="context-meter-panel-pct">({Math.round(pct * 100)}%)</span>
          </div>
          <div className="context-meter-panel-bar">
            <div className="context-meter-panel-bar-fill" style={{ width: `${pct * 100}%` }} />
          </div>

          {breakdown === undefined ? (
            <div className="context-meter-panel-loading">Loading breakdown…</div>
          ) : breakdown === null ? (
            <div className="context-meter-panel-note">
              {isLocal
                ? "Breakdown unavailable — no local model running."
                : "Per-category breakdown is for local models only."}
            </div>
          ) : (
            <div className="context-meter-panel-rows">
              {rows.map((r) => {
                const rowPct = panelMax > 0 ? Math.min(1, r.tokens / panelMax) : 0;
                return (
                  <div className="context-meter-panel-row" key={r.label}>
                    <span className="context-meter-panel-row-label">{r.label}</span>
                    <span className="context-meter-panel-row-bar">
                      <span
                        className="context-meter-panel-row-bar-fill"
                        style={{ width: `${rowPct * 100}%` }}
                      />
                    </span>
                    <span className="context-meter-panel-row-pct">
                      {formatTokens(r.tokens)} · {Math.round(rowPct * 100)}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
