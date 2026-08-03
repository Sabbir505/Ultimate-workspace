// Circular context-window meter for the chat composer, sitting below the send
// button. An SVG ring fills proportionally to how much of the active model's
// context window the last turn consumed; the percentage shows in the center.
// On hover (title) the full "used / max" figures appear. Always rendered (even
// before the first turn, where it shows 0%) so the affordance is stable.
//
// Sizing:
//  - Local LLM (local_gguf): the cap is the context size from the composer's
//    Context slider (localCtx); 0/Auto falls back to a default.
//  - API/cloud models: a flat 256K cap.
//
// The "used" figure is the input_tokens of the last assistant turn (the full
// prompt size the provider counted), passed in from ChatView. 0 until the
// first turn completes.
import { contextWindowFor, formatTokens } from "../../lib/contextWindow";

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
}

const PCT_WARN = 0.7;
const PCT_CRIT = 0.9;

// Ring geometry (viewBox 36x36, stroke width 4 → radius 16, circumference ~100).
const R = 16;
const CIRC = 2 * Math.PI * R;

export function ContextMeter({ usedTokens, model, isLocal, localCtx, liveMaxTokens }: Props) {
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

  return (
    <div
      className={`context-meter-circle ${level}`}
      title={title}
      role="img"
      aria-label={`Context ${Math.round(pct * 100)}% used`}
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
      {/* Styled tooltip on hover */}
      <span className="context-meter-tooltip">{title}</span>
    </div>
  );
}
