// Catalog pin for the provider kinds — the frontend mirror of the Rust
// `every_kind_resolves_through_every_seam` test. Every kind must survive
// `providerKindOf` (bare AND as a named endpoint id), reach the shared picker
// catalog, and carry the right per-family behavior. A kind wired into one
// surface but missed in another previously failed only at runtime — a pane
// that stayed empty, or a cache figure counted the Anthropic way.
import { describe, expect, it } from "vitest";
import { providerKindOf } from "../lib/providerKind";
import { normalizeBaseUrl } from "../lib/providerBaseUrl";
import { CLOUD_PROVIDER_IDS } from "../lib/agents";
import { PROVIDER_INPUT_INCLUDES_CACHE } from "../lib/ipc/localModels";
import { effortAppliesTo } from "../lib/modelCapabilities";

/** Kept in lockstep with the Rust `ChatProviderId` catalog. */
const KINDS = [
  "anthropic",
  "openai",
  "openai_chat",
  "openai_responses",
  "openrouter",
  "anthropic_compatible",
  "openai_compatible",
  "local_gguf",
] as const;

describe("provider kind catalog", () => {
  it("resolves every kind, bare and as a named endpoint", () => {
    for (const kind of KINDS) {
      expect(providerKindOf(kind)).toBe(kind);
      expect(providerKindOf(`${kind}-x7f2`)).toBe(kind);
    }
  });

  it("keeps both API-style kinds in the shared cloud catalog", () => {
    // Drives every provider picker (composer rail, automations, subagents,
    // memory extraction, wiki sources, artifact proposals).
    expect(CLOUD_PROVIDER_IDS).toContain("openai_chat");
    expect(CLOUD_PROVIDER_IDS).toContain("openai_responses");
  });

  it("counts both API-style kinds as OpenAI-family cache accounting", () => {
    // Their input_tokens include the cached slice (mirrors the backend's
    // ChatProviderId::input_includes_cache).
    expect(PROVIDER_INPUT_INCLUDES_CACHE.has("openai_chat")).toBe(true);
    expect(PROVIDER_INPUT_INCLUDES_CACHE.has("openai_responses")).toBe(true);
  });

  it("gates the effort slider on the resolved model for both wires", () => {
    expect(effortAppliesTo("openai_chat", "gpt-5")).toBe(true);
    expect(effortAppliesTo("openai_responses", "gpt-5-codex")).toBe(true);
    expect(effortAppliesTo("openai_chat", "gpt-4o")).toBe(false);
    expect(effortAppliesTo("openai_responses", "deepseek-chat")).toBe(false);
  });
});

// Mirrors the Rust `providers::normalize_base_url` tests — the two
// implementations must agree, or the form would show one base while the
// backend calls another.
describe("provider base URL canonicalization", () => {
  it("strips a pasted /v1 suffix and trailing slashes", () => {
    // The reported failure: the provider's documented endpoint pasted in as
    // the base. Every request builder appends `/v1/...` itself, so the
    // suffix had to go or every call hit `…/v1/v1/…` (404).
    expect(normalizeBaseUrl("https://api.commandcode.ai/provider/v1")).toBe(
      "https://api.commandcode.ai/provider",
    );
    expect(normalizeBaseUrl("  https://api.commandcode.ai/provider/v1/  ")).toBe(
      "https://api.commandcode.ai/provider",
    );
    expect(normalizeBaseUrl("https://relay.example.com/")).toBe("https://relay.example.com");
    expect(normalizeBaseUrl("https://relay.example.com/v1")).toBe("https://relay.example.com");
  });

  it("leaves lookalikes alone and is idempotent", () => {
    for (const unchanged of [
      "https://api.openai.com",
      "https://host/api/v1beta",
      "https://host/v10",
      "https://openrouter.ai/api",
      "https://host/api/v1/segment",
      "",
      "/v1",
    ]) {
      expect(normalizeBaseUrl(unchanged)).toBe(unchanged);
    }
    // The migration re-runs on every DB open.
    const once = normalizeBaseUrl("https://host/api/v1");
    expect(normalizeBaseUrl(once)).toBe(once);
  });
});
