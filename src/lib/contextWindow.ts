// Context-window sizing for the chat context meter.
//
// Two paths:
//  - Local LLM (local_gguf): the cap is the context size the user picked on
//    the composer's Context slider (`localCtx`). That's the sidecar's real -c
//    ceiling. 0 means "Auto" — fall back to a sane default.
//  - API / cloud models: a flat 256K cap, per product decision (the meter is a
//    rough usage indicator, not a per-model spec; 256K is the common modern
//    ceiling and keeps the math simple across providers).
//
// The "used" figure (passed in by the meter consumer) is the input_tokens of
// the last assistant turn — the full prompt size the provider counted.

/** Fixed context-window cap for API/cloud models, in tokens. */
export const API_CONTEXT_WINDOW = 256_000;

/** Default context window for a local model when the slider is at "Auto" (0). */
export const LOCAL_DEFAULT_CONTEXT = 16_384;

/** Resolve the max context window (tokens) for the active model.
 *  - isLocal true, localCtx > 0: the slider value (the sidecar's real -c).
 *  - isLocal true, slider at Auto (0/undefined): LOCAL_DEFAULT_CONTEXT.
 *  - isLocal false: API_CONTEXT_WINDOW. A stale `localCtx` from a previous
 *    local session is intentionally ignored here — the slider is global UI
 *    state, not per-session, and the auto-compact path (gated on LocalGguf)
 *    never reads this value anyway, so leaking it onto an API session's
 *    meter would just mislead the user. (`_model` is reserved for future
 *    per-model refinement; sizing is currently flat per the two-path
 *    decision above.) */
export function contextWindowFor(
  _model: string | undefined | null,
  isLocal: boolean,
  localCtx?: number,
): number {
  if (isLocal) {
    if (localCtx && localCtx > 0) return localCtx;
    return LOCAL_DEFAULT_CONTEXT;
  }
  return API_CONTEXT_WINDOW;
}

/** Format a token count compactly: 1234 -> "1.2k", 128000 -> "128k",
 *  1500000 -> "1.5M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 10 ? Math.round(v) : v.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const v = n / 1000;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)}k`;
  }
  return String(n);
}
