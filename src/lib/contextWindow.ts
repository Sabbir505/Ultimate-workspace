// Context-window sizing for the chat context meter.
//
// Three paths:
//  - Local LLM (local_gguf): the cap is the context size the user picked on
//    the composer's Context slider (`localCtx`). That's the sidecar's real -c
//    ceiling. 0 means "Auto" — fall back to a sane default.
//  - API / cloud models (incl. CLI-harness sessions): flat 500k, period.
//    Product decision (2026-09): every cloud/harness meter shows the same
//    500k ceiling regardless of model id. Harness ids, custom provider
//    names, and dated ids all collapse to the same number — the underlying
//    window is the provider's business, not ours to approximate (a
//    remapped relay setup makes any per-family guess a lie anyway).
//  - OpenRouter is the one exception: their public /api/v1/models endpoint
//    publishes `context_length` per model id, so the REAL window is derived
//    live (cached in localStorage for 24h) and capped at the 500k product
//    ceiling. OpenAI, Anthropic etc. publish windows only in docs, not on
//    any API the key can query — those stay on the flat default.
//
// The "used" figure (passed in by the meter consumer) is the input_tokens of
// the last assistant turn — the full prompt size the provider counted.

/** Flat context-window cap (tokens) shown for every API/cloud and
 *  CLI-harness model (2026-09 product decision). OpenRouter's live
 *  derivation is capped here too, so the meter never exceeds it. */
export const API_CONTEXT_WINDOW = 500_000;

/** Default context window for a local model when the slider is at "Auto" (0). */
export const LOCAL_DEFAULT_CONTEXT = 16_384;

// ---- Runtime instrumentation -----------------------------------------------------
//
// The on-screen cap is resolved through three layers (ContextMeter →
// contextWindowFor / contextWindowForModel → family catalog | OpenRouter live
// | defaults). When the meter doesn't show the number someone expects, the
// devtools log has to say WHICH layer decided it. Everything under the shared
// "[context]" console prefix:
//   [context] window:     catalog/default resolution (contextWindowFor)
//   [context] openrouter: live window derivation (contextWindowForModel)
//   [context] meter:      the final cap the ring is drawn against
// plus, in the backend console, the per-turn provider/harness usage that
// feeds the meter's "used" figure. Messages are deduped per channel — the
// meter recomputes on every render, so only CHANGES are printed.

const lastLogged: Record<string, string> = {};

/** Print a context-chain trace line, but only when `msg` differs from the
 *  previous message on the same channel (dedupe per-render recomputation). */
export function debugContext(channel: string, msg: string): void {
  if (lastLogged[channel] === msg) return;
  lastLogged[channel] = msg;
  console.info(`[context] ${channel}: ${msg}`);
}

/** Resolve the max context window (tokens) for the active model.
 *  - isLocal true, localCtx > 0: the slider value (the sidecar's real -c).
 *  - isLocal true, slider at Auto (0/undefined): LOCAL_DEFAULT_CONTEXT.
 *  - isLocal false: the flat API_CONTEXT_WINDOW for every cloud/harness
 *    model id. A stale `localCtx` from a previous local session is
 *    intentionally ignored — the slider is global UI state, not per-session. */
export function contextWindowFor(
  model: string | undefined | null,
  isLocal: boolean,
  localCtx?: number,
): number {
  if (isLocal) {
    if (localCtx && localCtx > 0) {
      debugContext("window", `local slider → ${localCtx} (model '${model ?? "—"}')`);
      return localCtx;
    }
    debugContext("window", `local auto → ${LOCAL_DEFAULT_CONTEXT} (model '${model ?? "—"}')`);
    return LOCAL_DEFAULT_CONTEXT;
  }
  // Cloud/harness: flat 500k for every model id — the window is the
  // provider's business. The OpenRouter live refinement (contextWindowForModel)
  // may lower it afterwards for that one provider.
  debugContext("window", `cloud '${model ?? "—"}' → ${API_CONTEXT_WINDOW} (flat product default)`);
  return API_CONTEXT_WINDOW;
}

// ---- OpenRouter live derivation ------------------------------------------------

const OR_CACHE_KEY = "conduit.openrouterContextWindows";
const OR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

interface OpenRouterCache {
  ts: number;
  /** model id → context_length (tokens). */
  windows: Record<string, number>;
}

function readCache(): OpenRouterCache | null {
  try {
    const raw = localStorage.getItem(OR_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OpenRouterCache;
    if (!parsed || typeof parsed.ts !== "number" || Date.now() - parsed.ts > OR_CACHE_TTL_MS) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(windows: Record<string, number>) {
  try {
    localStorage.setItem(
      OR_CACHE_KEY,
      JSON.stringify({ ts: Date.now(), windows } satisfies OpenRouterCache),
    );
  } catch {
    /* storage full/blocked — the meter just stays on the catalog */
  }
}

/** Fetch OpenRouter's public model list and cache id → context_length.
 *  Public endpoint — the API key is NOT required (and not sent). Returns the
 *  cached/fetched table, or null when offline/blocked/stale-cache-miss. */
export async function openRouterContextWindows(): Promise<Record<string, number> | null> {
  const cached = readCache();
  if (cached) return cached.windows;
  try {
    const resp = await fetch(OPENROUTER_MODELS_URL, { headers: { Accept: "application/json" } });
    if (!resp.ok) return null;
    const body = (await resp.json()) as {
      data?: { id?: string; context_length?: number }[];
    };
    const windows: Record<string, number> = {};
    for (const m of body.data ?? []) {
      if (m.id && typeof m.context_length === "number" && m.context_length > 0) {
        windows[m.id.toLowerCase()] = m.context_length;
      }
    }
    if (Object.keys(windows).length > 0) writeCache(windows);
    return Object.keys(windows).length > 0 ? windows : null;
  } catch {
    return null;
  }
}

/** Live refinement for OpenRouter sessions: derive the window from
 *  OpenRouter's models endpoint (exact id match, falling back to the
 *  model's bare suffix — a session id like "deepseek/deepseek-v4" matches
 *  "deepseek-v4" too). Returns null for every other provider/miss, in which
 *  case the flat API_CONTEXT_WINDOW stands. Capped at API_CONTEXT_WINDOW so
 *  the meter never shows more than the product's 500k cloud ceiling even
 *  when a model advertises 1M+. */
export async function contextWindowForModel(
  model: string | undefined | null,
  provider: string | undefined | null,
): Promise<number | null> {
  if ((provider ?? "").toLowerCase() !== "openrouter") return null;
  const m = (model ?? "").toLowerCase();
  if (!m) return null;
  const windows = await openRouterContextWindows();
  if (!windows) {
    debugContext("openrouter", `'${model}' → no live table (offline/no cache), flat default stands`);
    return null;
  }
  const cap = (n: number) => Math.min(n, API_CONTEXT_WINDOW);
  if (windows[m]) {
    debugContext(
      "openrouter",
      `'${model}' → live ${windows[m]} → capped ${cap(windows[m])} (exact id match)`,
    );
    return cap(windows[m]);
  }
  const bare = m.includes("/") ? m.split("/").pop()! : m;
  if (windows[bare]) {
    debugContext(
      "openrouter",
      `'${model}' → live ${windows[bare]} → capped ${cap(windows[bare])} (bare-suffix match '${bare}')`,
    );
    return cap(windows[bare]);
  }
  // Suffix match for dated/distilled ids ("vendor/model-v4-0815").
  const hit = Object.entries(windows).find(
    ([id]) => id.endsWith(`/${bare}`) || bare.startsWith(id) || id.startsWith(bare),
  );
  if (hit) {
    debugContext(
      "openrouter",
      `'${model}' → live ${hit[1]} → capped ${cap(hit[1])} (fuzzy match '${hit[0]}')`,
    );
    return cap(hit[1]);
  }
  debugContext("openrouter", `'${model}' → no live entry, flat default stands`);
  return null;
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
