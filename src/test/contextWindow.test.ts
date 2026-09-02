import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_CONTEXT_WINDOW,
  contextWindowFor,
  contextWindowForModel,
  debugContext,
  formatTokens,
  LOCAL_DEFAULT_CONTEXT,
  registryWindowFor,
} from "../lib/contextWindow";

afterEach(() => {
  localStorage.clear();
});

describe("contextWindowFor", () => {
  it("uses the slider value for a local model when localCtx > 0", () => {
    expect(contextWindowFor("Llama-3-8B-Instruct-Q4_K_M.gguf", true, 8192)).toBe(8192);
    expect(contextWindowFor("anything", true, 131072)).toBe(131072);
  });

  it("falls back to LOCAL_DEFAULT_CONTEXT for a local model at Auto (0)", () => {
    expect(contextWindowFor("Qwen2.5-7B-Instruct-Q4_K_M", true, 0)).toBe(LOCAL_DEFAULT_CONTEXT);
    expect(contextWindowFor("Qwen2.5-7B-Instruct-Q4_K_M", true, undefined)).toBe(
      LOCAL_DEFAULT_CONTEXT,
    );
  });

  it("resolves cloud/harness models through the per-model registry", () => {
    // The old "flat 500k for everything" rule showed a 200k-window Claude at
    // ~40% when actually full, so warn/crit could never fire before a real
    // overflow. The registry mirrors the backend's context_windows.rs table.
    expect(contextWindowFor("claude-sonnet-4-5-20250929", false)).toBe(200_000);
    expect(contextWindowFor("claude-opus-4-8", false)).toBe(200_000);
    expect(contextWindowFor("gpt-5", false)).toBe(400_000);
    expect(contextWindowFor("openai/gpt-5-mini", false)).toBe(400_000);
    expect(contextWindowFor("gpt-4.1-mini", false)).toBe(1_000_000);
    expect(contextWindowFor("gemini-2.5-pro", false)).toBe(1_000_000);
    expect(contextWindowFor("deepseek-v4-pro", false)).toBe(128_000);
    expect(contextWindowFor("kimi-k3", false)).toBe(256_000);
    expect(contextWindowFor("glm-5.2", false)).toBe(200_000);
    // Most-specific rule wins: gpt-4.1 must not be swallowed by gpt-4.
    expect(contextWindowFor("gpt-4.1", false)).not.toBe(contextWindowFor("gpt-4o", false));
  });

  it("falls back to the flat 500k default for unknown ids", () => {
    expect(contextWindowFor("totally-unknown-model", false)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined, false)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor("   ", false)).toBe(API_CONTEXT_WINDOW);
  });

  it("applies the user's context-limit override as a cap-only min()", () => {
    // A cap shrinks the window (cost control / remapped backends that serve
    // less than the model id suggests); it never RAISES a model above its
    // real capacity. Mirrors the backend's effective_cloud_window.
    expect(contextWindowFor("claude-sonnet-4-5", false, undefined, 100_000)).toBe(100_000);
    // Cap above the model's window → the model's own window wins.
    expect(contextWindowFor("claude-sonnet-4-5", false, undefined, 400_000)).toBe(200_000);
    // Unknown models: the flat fallback gets capped too.
    expect(contextWindowFor("unknown-model", false, undefined, 50_000)).toBe(50_000);
    // 0/undefined = auto.
    expect(contextWindowFor("claude-sonnet-4-5", false, undefined, 0)).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-4-5", false, undefined, undefined)).toBe(200_000);
  });

  it("ignores a stale localCtx on an API/cloud session (slider is global UI state)", () => {
    // After dragging the Context slider on a local model, that value stays in
    // the global store when the user switches to an API session. It must not
    // bleed into the API meter — the registry (or its fallback) decides the
    // cap, never the slider.
    expect(contextWindowFor("claude-sonnet-4-5", false, 8192)).toBe(200_000);
    expect(contextWindowFor("totally-unknown-model", false, 131072)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined, false, 4096)).toBe(API_CONTEXT_WINDOW);
  });
});

describe("registryWindowFor", () => {
  it("returns null for unknown ids so callers can apply their own fallback", () => {
    expect(registryWindowFor("totally-unknown-model")).toBeNull();
    expect(registryWindowFor("")).toBeNull();
    expect(registryWindowFor(null)).toBeNull();
  });

  it("matches case- and vendor-insensitively", () => {
    expect(registryWindowFor("Claude-Sonnet-4-5")).toBe(200_000);
    expect(registryWindowFor("ANTHROPIC/claude-opus-4-8")).toBe(200_000);
  });
});

describe("contextWindowForModel (OpenRouter live)", () => {
  it("returns the provider's own context_length without the 500k cap", async () => {
    // A model that really has >500k tokens must show its real window — the
    // old cap made a 1M OpenRouter model lie about its own capacity.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "some-vendor/big-window-model", context_length: 1_048_576 }] }),
        { status: 200 },
      ),
    );
    try {
      localStorage.clear();
      const w = await contextWindowForModel("some-vendor/big-window-model", "openrouter");
      expect(w).toBe(1_048_576);
      expect(w!).toBeGreaterThan(API_CONTEXT_WINDOW);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("returns null for non-OpenRouter providers", async () => {
    expect(await contextWindowForModel("claude-sonnet-4-5", "anthropic")).toBeNull();
  });
});

describe("debugContext (context-chain instrumentation)", () => {
  it("prints a deduped [context] line per channel", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      debugContext("meter", "cap=500000");
      debugContext("meter", "cap=500000"); // same message — deduped
      debugContext("meter", "cap=200000"); // changed — printed
      debugContext("window", "cap=500000"); // other channel — printed
      expect(info).toHaveBeenCalledTimes(3);
      expect(info.mock.calls.every((c) => String(c[0]).startsWith("[context]"))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });
});

describe("formatTokens", () => {
  it("formats thousands compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(128000)).toBe("128k");
  });

  it("formats millions compactly", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(10_000_000)).toBe("10M");
  });
});
