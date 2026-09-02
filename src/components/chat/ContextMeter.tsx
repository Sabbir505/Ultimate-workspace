// Circular context-window meter for the chat composer, sitting below the send
// button. An SVG ring fills proportionally to how much of the active model's
// context window the last turn consumed; the percentage shows in the center.
// Always rendered (even before the first turn, where it shows 0%) so the
// affordance is stable.
//
// On hover a rich breakdown panel appears showing the model name and usage
// stats on the same row, a slider visualizing fill (always visible even at 0),
// and per-category rows. For local models the breakdown is token-accurate
// (/tokenize); for cloud/harness models the backend estimates each category
// from the actual content (~4 chars/token) — real proportions, not constants.
//
// Sizing:
//  - Local LLM (local_gguf): the cap is the context size from the composer's
//    Context slider (localCtx); 0/Auto falls back to a default.
//  - API/cloud + harness models: resolved through the per-model registry
//    (lib/contextWindow, mirrored backend-side in
//    chat/context_windows.rs), refined live by OpenRouter where the
//    provider publishes the real window. The final decision — which layer
//    won and the value in use — is traced under the console "[context]
//    meter" channel.
//
// The "used" figure combines the backend's live estimate (polled by
// useContextMeter — fresh after every sent message or compaction) with the
// input_tokens of the last assistant turn (the full prompt size the
// provider counted), taking the larger. 0 until the first turn completes.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  contextWindowFor,
  contextWindowForModel,
  debugContext,
  formatTokens,
  registryWindowFor,
} from "../../lib/contextWindow";
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
  /** User's cloud context-limit cap (tokens, 0/undefined = auto). Caps the
   *  EFFECTIVE window below the model's own — the same figure the backend's
   *  compaction trigger uses, so meter and trigger agree. */
  contextLimitOverride?: number;
  /** The active model's PINNED window (Settings → Model list) —
   *  authoritative. When set it REPLACES the registry/live figure entirely
   *  (it may raise a model above the registry's guess, e.g. a 1M glm on a
   *  remapped endpoint); the live refinement is skipped. */
  pinnedWindow?: number;
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

export function ContextMeter({
  usedTokens,
  model,
  provider,
  isLocal,
  localCtx,
  liveMaxTokens,
  chatSessionId,
  contextLimitOverride,
  pinnedWindow,
}: Props) {
  const used = usedTokens && usedTokens > 0 ? usedTokens : 0;
  // Cloud/harness sessions resolve through the per-model registry (falling
  // back to the flat default for unknown ids). For OpenRouter sessions the
  // real window is then derived live from their models endpoint and refines
  // that figure when it resolves.
  const pinned = pinnedWindow && pinnedWindow > 0 ? pinnedWindow : null;
  const baseMax = pinned ?? contextWindowFor(model, isLocal, localCtx, contextLimitOverride);
  const [dynamicMax, setDynamicMax] = useState<number | null>(null);
  useEffect(() => {
    setDynamicMax(null);
    if (isLocal) return;
    // A pinned window IS the answer — no live refinement can override it.
    if (pinned) return;
    let cancelled = false;
    void contextWindowForModel(model, provider).then((w) => {
      if (!cancelled && w && w > 0) {
        // The user's cap shrinks the live figure too — same min() contract
        // as the registry path (a cap never RAISES a window).
        setDynamicMax(
          contextLimitOverride && contextLimitOverride > 0
            ? Math.min(w, contextLimitOverride)
            : w,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [model, provider, isLocal, contextLimitOverride, pinned]);
  // Prefer the live cap (what llama-server was actually started with) over
  // the slider-derived cap. Falls back to the slider / 16K default for the
  // brief window before the first poll resolves, and for cloud sessions
  // where `liveMaxTokens` is 0.
  const liveSidecar = !!(isLocal && liveMaxTokens && liveMaxTokens > 0);
  const max = liveSidecar ? liveMaxTokens! : (dynamicMax ?? baseMax);
  // Which layer produced `max` — logged on change and shown in the hover
  // panel so the actual limit in use is visible without devtools.
  const capSource: string = liveSidecar
    ? "sidecar-live"
    : pinned != null
      ? "pinned"
      : dynamicMax != null
        ? "openrouter-live"
        : isLocal
          ? "local-default"
          : registryWindowFor(model) != null
            ? "registry"
            : "registry-fallback";
  const pct = max > 0 ? Math.min(1, used / max) : 0;
  const level = pct >= PCT_CRIT ? "crit" : pct >= PCT_WARN ? "warn" : "ok";
  // Dash the circle so the filled portion grows from the top clockwise.
  const dash = CIRC * pct;

  // Trace the final cap decision (deduped — prints only when it changes).
  useEffect(() => {
    debugContext(
      "meter",
      `cap=${max} (${capSource}) used=${used} model='${model ?? "—"}' provider='${provider ?? "—"}' isLocal=${isLocal}`,
    );
  }, [max, capSource, used, model, provider, isLocal]);

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
      // Every provider resolves through the backend now: local sessions
      // return exact /tokenize counts, cloud/harness sessions return a
      // char-based estimate per category (system prompt, history, tool
      // schema — whatever that path actually sends).
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
