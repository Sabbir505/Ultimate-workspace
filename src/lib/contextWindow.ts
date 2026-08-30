// Context-window sizing for the chat context meter.
//
// Three paths:
//  - Local LLM (local_gguf): the cap is the context size the user picked on
//    the composer's Context slider (`localCtx`). That's the sidecar's real -c
//    ceiling. 0 means "Auto" — fall back to a sane default.
//  - API / cloud models: matched against a per-model catalog below (family
//    rules on the model id — harness ids, custom provider names, and dated
//    ids all normalize). Unknown models keep the flat 256K default.
//  - OpenRouter additionally derives the REAL window live from their public
//    /api/v1/models endpoint (`context_length` per model id) — the one major
//    endpoint that exposes it. Cached in localStorage for 24h. OpenAI,
//    Anthropic etc. publish windows only in docs, not on any API the key can
//    query, so those stay on the catalog.
//
// The "used" figure (passed in by the meter consumer) is the input_tokens of
// the last assistant turn — the full prompt size the provider counted.

/** Fixed context-window cap for API/cloud (and CLI-harness) models with no
 *  better answer. 500k is the product default for the meter: unknown cloud
 *  models and harness sessions show a 500k ring; the family table below
 *  carries the known smaller exceptions (Claude 200k, GPT-4o 128k, DeepSeek
 *  128k, Kimi 256k, …), which stay truthful. */
export const API_CONTEXT_WINDOW = 500_000;

/** Default context window for a local model when the slider is at "Auto" (0). */
export const LOCAL_DEFAULT_CONTEXT = 16_384;

/** Ordered most-specific-first family rules on the lowercased model id.
 *  Values are approximate windows per model family (tokens) — the meter is a
 *  usage indicator; a family-level number beats a flat 256K lie. */
const FAMILY_WINDOWS: [needle: string, tokens: number][] = [
  // Anthropic (200k across opus/sonnet/haiku 3.5–5; 1M exists only as beta)
  ["claude", 200_000],
  // OpenAI
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  // (plain "gpt-4" is intentionally absent: the contains rule would swallow
  // gpt-4.1/gpt-4o; the rare legacy id falls to the 1M default and the
  // OpenRouter derivation prices it correctly where available)
  ["o1", 200_000],
  ["o3", 200_000],
  ["o4", 200_000],
  // (gpt-4.1 / gpt-5 and anything newer are 1M/400k+ — the 1M default below
  // already covers them)
  // Google
  ["gemini-1.0", 32_768],
  // (gemini 1.5/2.x/3 are 1M — covered by the default)
  // DeepSeek
  ["deepseek", 128_000],
  // Zhipu GLM (4.6+ ships 200k; older 4.x 128k)
  ["glm-4.6", 200_000],
  ["glm-5", 200_000],
  ["glm-4", 128_000],
  // Moonshot Kimi
  ["kimi", 256_000],
  // Qwen (open ids are 128k-ish; commercial plus/max are 1M — default covers)
  ["qwen2.5", 128_000],
  ["qwen-2.5", 128_000],
  // Others with documented smaller windows
  ["llama-2", 4_096],
  ["llama-3", 128_000],
  ["mistral", 131_072],
  ["mixtral", 32_768],
  ["grok-3", 131_072],
  ["phi", 128_000],
];

/** Resolve the max context window (tokens) for the active model.
 *  - isLocal true, localCtx > 0: the slider value (the sidecar's real -c).
 *  - isLocal true, slider at Auto (0/undefined): LOCAL_DEFAULT_CONTEXT.
 *  - isLocal false: the per-model catalog, else API_CONTEXT_WINDOW. A stale
 *    `localCtx` from a previous local session is intentionally ignored — the
 *    slider is global UI state, not per-session. */
export function contextWindowFor(
  model: string | undefined | null,
  isLocal: boolean,
  localCtx?: number,
): number {
  if (isLocal) {
    if (localCtx && localCtx > 0) return localCtx;
    return LOCAL_DEFAULT_CONTEXT;
  }
  return catalogContextWindow(model) ?? API_CONTEXT_WINDOW;
}

/** Catalog lookup on the model id (lowercased substring rules). Harness ids
 *  ("claude-sonnet-4-5", "glm-5.2", "kimi-k3"), custom provider names, and
 *  dated ids ("claude-sonnet-4-5-20250929") all normalize through the same
 *  lowercase-contains matching the backend's pricing uses. */
export function catalogContextWindow(model: string | undefined | null): number | null {
  const m = (model ?? "").toLowerCase();
  if (!m) return null;
  for (const [needle, tokens] of FAMILY_WINDOWS) {
    if (m.includes(needle)) return tokens;
  }
  return null;
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

/** Async refinement over the sync catalog: for OpenRouter sessions whose
 *  model has no catalog entry, derive the window from OpenRouter's models
 *  endpoint (exact id match, falling back to the model's bare suffix —
 *  a session id like "deepseek/deepseek-v4" matches "deepseek-v4" too).
 *  Capped at API_CONTEXT_WINDOW so the meter never shows more than the
 *  product's 500k cloud ceiling even when a model advertises 1M+. */
export async function contextWindowForModel(
  model: string | undefined | null,
  provider: string | undefined | null,
): Promise<number | null> {
  if ((provider ?? "").toLowerCase() !== "openrouter") return null;
  const m = (model ?? "").toLowerCase();
  if (!m) return null;
  const windows = await openRouterContextWindows();
  if (!windows) return null;
  const cap = (n: number) => Math.min(n, API_CONTEXT_WINDOW);
  if (windows[m]) return cap(windows[m]);
  const bare = m.includes("/") ? m.split("/").pop()! : m;
  if (windows[bare]) return cap(windows[bare]);
  // Suffix match for dated/distilled ids ("vendor/model-v4-0815").
  const hit = Object.entries(windows).find(
    ([id]) => id.endsWith(`/${bare}`) || bare.startsWith(id) || id.startsWith(bare),
  );
  return hit ? cap(hit[1]) : null;
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
