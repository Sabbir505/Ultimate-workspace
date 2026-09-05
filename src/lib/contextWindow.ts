// Context-window sizing for the chat context meter.
//
// Three paths:
//  - Local LLM (local_gguf): the cap is the context size the user picked on
//    the composer's Context slider (`localCtx`). That's the sidecar's real -c
//    ceiling. 0 means "Auto" — fall back to a sane default.
//  - API / cloud + CLI-harness models: resolved through the per-model
//    REGISTRY below (same table the backend send path uses, mirrored in
//    src-tauri/src/chat/context_windows.rs). Unknown ids fall back to the
//    500k default. The old "flat 500k for everything" rule was retired: a
//    200k-window Claude showed ~40% when actually full, so the warn/crit
//    levels could never fire before a real overflow.
//  - OpenRouter is refined live: their public /api/v1/models endpoint
//    publishes `context_length` per model id, cached in localStorage for
//    24h. The live figure wins over the registry (it's the provider's own
//    number) and is no longer capped at 500k — a model that really has 1M
//    tokens should show 1M.
//
// The "used" figure (passed in by the meter consumer) combines the
// backend's live estimate with the input_tokens of the last assistant turn.

/** Fallback context window (tokens) for model ids the registry doesn't
 *  recognize. Mirrors the backend's DEFAULT_CLOUD_WINDOW. */
export const API_CONTEXT_WINDOW = 500_000;

/** Default context window for a local model when the slider is at "Auto" (0). */
export const LOCAL_DEFAULT_CONTEXT = 16_384;

// ---- Per-model registry ----------------------------------------------------------
//
// `(substring of the model id, window)`, most-specific first — matching is a
// lowercase substring scan so dated ids ("claude-sonnet-4-5-20250929"),
// vendor-qualified ids ("openai/gpt-5-mini"), and harness-reported ids all
// resolve without enumerating aliases. Keep in sync with the backend table
// (src-tauri/src/chat/context_windows.rs).
const MODEL_CONTEXT_RULES: ReadonlyArray<readonly [string, number]> = [
  ["claude", 200_000],
  ["gpt-5", 400_000],
  ["gpt-4.1", 1_000_000],
  ["o1-mini", 128_000],
  ["o3", 200_000],
  ["o4-mini", 200_000],
  ["o1", 200_000],
  ["gpt-4o", 128_000],
  ["gpt-4", 128_000],
  ["gemini", 1_000_000],
  ["grok-4", 256_000],
  ["grok", 131_072],
  ["deepseek", 128_000],
  ["qwen", 131_072],
  ["kimi", 256_000],
  ["llama-4", 1_000_000],
  ["llama-3", 131_072],
  ["mistral", 131_072],
  ["glm-5", 200_000],
  ["glm", 128_000],
  ["command-a", 256_000],
  ["command", 128_000],
];

/** Registry lookup for a cloud/harness model id. `null` when the id matches
 *  no rule — the caller applies the flat fallback. */
export function registryWindowFor(model: string | undefined | null): number | null {
  const m = (model ?? "").trim().toLowerCase();
  if (!m) return null;
  for (const [needle, window] of MODEL_CONTEXT_RULES) {
    if (m.includes(needle)) return window;
  }
  return null;
}

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
 *  - isLocal false: the per-model registry, falling back to the flat
 *    API_CONTEXT_WINDOW for unknown ids, then capped by `overrideLimit`
 *    when set (a user cap only SHRINKS the window — it never raises a
 *    model above its real capacity). Mirrors the backend's
 *    `effective_cloud_window` so the meter and the compaction trigger can
 *    never disagree. A stale `localCtx` from a previous local session is
 *    intentionally ignored — the slider is global UI state, not
 *    per-session. */
export function contextWindowFor(
  model: string | undefined | null,
  isLocal: boolean,
  localCtx?: number,
  overrideLimit?: number,
): number {
  if (isLocal) {
    if (localCtx && localCtx > 0) {
      debugContext("window", `local slider → ${localCtx} (model '${model ?? "—"}')`);
      return localCtx;
    }
    debugContext("window", `local auto → ${LOCAL_DEFAULT_CONTEXT} (model '${model ?? "—"}')`);
    return LOCAL_DEFAULT_CONTEXT;
  }
  const registered = registryWindowFor(model) ?? API_CONTEXT_WINDOW;
  const effective =
    overrideLimit && overrideLimit > 0
      ? Math.min(registered, overrideLimit)
      : registered;
  if (effective !== registered) {
    debugContext(
      "window",
      `cloud '${model ?? "—"}' → ${effective} (registry ${registered}, user cap ${overrideLimit})`,
    );
  } else {
    debugContext("window", `cloud '${model ?? "—"}' → ${effective} (registry)`);
  }
  return effective;
}

// ---- OpenRouter live derivation ------------------------------------------------

const OR_CACHE_KEY = "relay.openrouterContextWindows";
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

// ---- Anthropic live derivation --------------------------------------------------

const ANTHROPIC_CACHE_KEY = "relay.anthropicContextWindows";
const ANTHROPIC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function readGenericCache(key: string, ttlMs: number): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number; windows: Record<string, number> };
    if (!parsed || typeof parsed.ts !== "number" || Date.now() - parsed.ts > ttlMs) {
      return null;
    }
    return parsed.windows;
  } catch {
    return null;
  }
}

function writeGenericCache(key: string, windows: Record<string, number>) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), windows }));
  } catch {
    /* storage full/blocked — the meter just stays on the catalog */
  }
}

/** Anthropic's live model table, fetched through the backend (it holds the
 *  API key — the webview never does) and cached in localStorage for 24h,
 *  same contract as the OpenRouter table. Null when the provider has no key
 *  or the fetch failed with no stale cache. */
export async function anthropicContextWindows(): Promise<Record<string, number> | null> {
  const cached = readGenericCache(ANTHROPIC_CACHE_KEY, ANTHROPIC_CACHE_TTL_MS);
  if (cached) return cached;
  try {
    const { fetchProviderModelWindows } = await import("./ipc");
    const windows = await fetchProviderModelWindows("anthropic");
    if (windows && Object.keys(windows).length > 0) {
      writeGenericCache(ANTHROPIC_CACHE_KEY, windows);
      return windows;
    }
    return null;
  } catch {
    return null;
  }
}

/** Match a model id against a live id→window table: exact id, then bare
 *  suffix ("vendor/model-v4" matches "model-v4"), then fuzzy prefix/suffix
 *  for dated/distilled ids. Shared by the OpenRouter and Anthropic paths. */
function matchLiveWindow(
  windows: Record<string, number>,
  m: string,
): number | null {
  if (windows[m]) return windows[m];
  const bare = m.includes("/") ? m.split("/").pop()! : m;
  if (windows[bare]) return windows[bare];
  const hit = Object.entries(windows).find(
    ([id]) => id.endsWith(`/${bare}`) || bare.startsWith(id) || id.startsWith(bare),
  );
  return hit ? hit[1] : null;
}

/** Live refinement for cloud sessions: derive the window from the
 *  provider's own models API — OpenRouter's public endpoint (fetched
 *  directly) or Anthropic's keyed one (fetched via the backend, cached).
 *  Exact id match, falling back to the model's bare suffix. Returns null
 *  for providers without live data, in which case the registry (or its
 *  flat fallback) stands. The live figure is NOT capped here: it's the
 *  provider's own number. The user's context-limit override is applied on
 *  top by the caller (see `contextWindowFor`). */
export async function contextWindowForModel(
  model: string | undefined | null,
  provider: string | undefined | null,
): Promise<number | null> {
  const p = (provider ?? "").toLowerCase();
  const m = (model ?? "").toLowerCase();
  if (!m) return null;
  if (p === "openrouter") {
    const windows = await openRouterContextWindows();
    if (!windows) {
      debugContext("openrouter", `'${model}' → no live table (offline/no cache), registry stands`);
      return null;
    }
    const hit = matchLiveWindow(windows, m);
    if (hit != null) {
      debugContext("openrouter", `'${model}' → live ${hit}`);
      return hit;
    }
    debugContext("openrouter", `'${model}' → no live entry, registry stands`);
    return null;
  }
  if (p === "anthropic" || p === "anthropic_compatible") {
    const windows = await anthropicContextWindows();
    if (!windows) {
      debugContext("anthropic", `'${model}' → no live table (no key/offline), registry stands`);
      return null;
    }
    const hit = matchLiveWindow(windows, m);
    if (hit != null) {
      debugContext("anthropic", `'${model}' → live ${hit}`);
      return hit;
    }
    debugContext("anthropic", `'${model}' → no live entry, registry stands`);
    return null;
  }
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
