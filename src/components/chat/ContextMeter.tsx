// Circular context-window meter for the chat composer, sitting below the send
// button. An SVG ring fills proportionally to how much of the active model's
// context window the last turn consumed; the percentage shows in the center.
// Always rendered (even before the first turn, where it shows 0%) so the
// affordance is stable.
//
// On hover a rich breakdown panel appears showing the model name and usage
// stats on the same row, a slider visualizing fill (always visible even at 0),
// and per-category rows. For local models the breakdown is token-accurate;
// for cloud models it's an approximation (≈4 chars/token) so the user still
// gets a sense of which components dominate regardless of provider.
//
// Sizing:
//  - Local LLM (local_gguf): the cap is the context size from the composer's
//    Context slider (localCtx); 0/Auto falls back to a default.
//  - API/cloud models: a flat 256K cap.
//
// The "used" figure is the input_tokens of the last assistant turn (the full
// prompt size the provider counted), passed in from ChatView. 0 until the
// first turn completes.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { contextWindowFor, contextWindowForModel, formatTokens } from "../../lib/contextWindow";
import { countContextBreakdown, type ContextBreakdown } from "../../lib/ipc";
import { useUiStore } from "../../state/ui";

interface Props {
  usedTokens: number | null;
  model: string | undefined | null;
  /** Provider id of the active session ("openrouter", "anthropic", …) —
   *  gates the live context-window derivation (OpenRouter's models endpoint
   *  is the one major API that exposes per-model context_length). */
  provider?: string | null;
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

/** Rough token estimate from character count (~4 chars per token). Used as
 *  a fallback for cloud models where we can't call /tokenize. */
function charsToTokens(s: string): number {
  return Math.max(0, Math.round(s.trim().length / 4));
}

interface Row {
  label: string;
  tokens: number;
}

export function ContextMeter({ usedTokens, model, provider, isLocal, localCtx, liveMaxTokens, chatSessionId }: Props) {
  const used = usedTokens && usedTokens > 0 ? usedTokens : 0;
  // Catalog cap for the model id (family rules; 256K fallback). For
  // OpenRouter sessions the real window is then derived live from their
  // models endpoint and refines the catalog figure when it resolves.
  const catalogMax = contextWindowFor(model, isLocal, localCtx);
  const [dynamicMax, setDynamicMax] = useState<number | null>(null);
  useEffect(() => {
    setDynamicMax(null);
    if (isLocal) return;
    let cancelled = false;
    void contextWindowForModel(model, provider).then((w) => {
      if (!cancelled && w && w > 0) setDynamicMax(w);
    });
    return () => {
      cancelled = true;
    };
  }, [model, provider, isLocal]);
  // Prefer the live cap (what llama-server was actually started with) over
  // the slider-derived cap. Falls back to the slider / 16K default for the
  // brief window before the first poll resolves, and for cloud sessions
  // where `liveMaxTokens` is 0.
  const max = (isLocal && liveMaxTokens && liveMaxTokens > 0)
    ? liveMaxTokens
    : (dynamicMax ?? catalogMax);
  const pct = max > 0 ? Math.min(1, used / max) : 0;
  const level = pct >= PCT_CRIT ? "crit" : pct >= PCT_WARN ? "warn" : "ok";
  // Dash the circle so the filled portion grows from the top clockwise.
  const dash = CIRC * pct;

  // Rich breakdown panel state — fetched lazily on hover so we don't pay the
  // tokenize round-trips on every render/poll. For local models we use real
  // token counts; for cloud we estimate from character length (~4 chars/token).
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null | undefined>(undefined);
  const [showPanel, setShowPanel] = useState(false);
  // Fixed-viewport position for the portaled panel, computed from the circle's
  // rect at hover time (see the portal note below).
  const [panelPos, setPanelPos] = useState<{ left: number; bottom: number } | null>(null);
  const circleRef = useRef<HTMLDivElement>(null);
  const breakdownKey = chatSessionId ?? "";
  const lastKey = useRef(breakdownKey);
  if (lastKey.current !== breakdownKey) {
    lastKey.current = breakdownKey;
    setBreakdown(undefined); // session changed — refetch on next hover
  }

  // While the panel is showing, tell native browser webviews to hide: they
  // float above ALL DOM, so no z-index could lift the tooltip over them.
  // Unmount-clears so a mid-hover unmount can't strand the flag true (which
  // would keep every browser pane hidden forever).
  const setContextTipOpen = useUiStore((s) => s.setContextTipOpen);
  useEffect(() => {
    if (showPanel) setContextTipOpen(true);
    return () => setContextTipOpen(false);
  }, [showPanel, setContextTipOpen]);

  const onHover = () => {
    const el = circleRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      // Center on the circle, clamped so the 260px panel can't leave the
      // viewport (the circle sits in the composer's corner).
      const left = Math.min(
        Math.max(138, r.left + r.width / 2),
        window.innerWidth - 138,
      );
      setPanelPos({ left, bottom: window.innerHeight - r.top + 6 });
    }
    setShowPanel(true);
    if (breakdown === undefined && chatSessionId) {
      if (isLocal) {
        countContextBreakdown(chatSessionId)
          .then((b) => setBreakdown(b))
          .catch(() => setBreakdown(null));
      } else {
        // Cloud model: approximate breakdown from the used-token count.
        // We split the total into rough categories by character length so
        // the user still sees relative weights (messages dominate, etc.).
        const approx: ContextBreakdown = {
          totalTokens: used,
          maxTokens: max,
          systemPromptTokens: Math.round(used * 0.15),
          messagesTokens: Math.round(used * 0.70),
          toolSpecsTokens: Math.round(used * 0.10),
          connectorToolsTokens: 0,
          skillsTokens: 0,
          metacontextTokens: Math.round(used * 0.05),
        };
        setBreakdown(approx);
      }
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
      ref={circleRef}
      className={`context-meter-circle ${level}`}
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

      {/* Portaled to document.body: the tooltip must overlap the right-side
          tool panel, which is a sibling subtree with its own stacking context
          — an absolutely-positioned panel inside the composer loses that fight
          no matter its z-index. Fixed positioning + a top-layer z-index wins
          over every HTML surface (native webviews are handled separately via
          the contextTipOpen occlusion flag). */}
      {showPanel && panelPos && createPortal(
        <div className="context-meter-panel" style={{ left: panelPos.left, bottom: panelPos.bottom }}>
          {/* Model + usage stats on one row */}
          <div className="context-meter-panel-top">
            <span className="context-meter-panel-model" title={model ?? ""}>
              {model ? `Model: ${model}` : "Model: —"}
            </span>
            <span className="context-meter-panel-meta">
              <span>{formatTokens(used)}</span>
              <span className="context-meter-panel-total"> / {formatTokens(max)}</span>
              <span className="context-meter-panel-pct">({Math.round(pct * 100)}%)</span>
            </span>
          </div>
          {/* Slider visualization — always rendered, even at 0% */}
          <div className="context-meter-panel-bar">
            <div className="context-meter-panel-bar-fill" style={{ width: `${pct * 100}%` }} />
          </div>

          {breakdown === undefined ? (
            <div className="context-meter-panel-loading">Loading breakdown…</div>
          ) : breakdown === null ? (
            <div className="context-meter-panel-note">
              Breakdown unavailable for this session.
            </div>
          ) : (
            <div className="context-meter-panel-rows">
              {rows.map((r) => {
                const rowPct = panelMax > 0 ? Math.min(1, r.tokens / panelMax) : 0;
                const pctStr = `${Math.round(rowPct * 100)}%`;
                const tokStr = r.tokens > 0 ? `${formatTokens(r.tokens)} · ${pctStr}` : pctStr;
                return (
                  <div className="context-meter-panel-row" key={r.label}>
                    <span className="context-meter-panel-row-label">{r.label}</span>
                    <span className="context-meter-panel-row-bar">
                      <span
                        className="context-meter-panel-row-bar-fill"
                        style={{ width: `${rowPct * 100}%` }}
                      />
                    </span>
                    <span className="context-meter-panel-row-pct">{tokStr}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
