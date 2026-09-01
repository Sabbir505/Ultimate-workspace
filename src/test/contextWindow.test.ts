import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_CONTEXT_WINDOW,
  contextWindowFor,
  debugContext,
  formatTokens,
  LOCAL_DEFAULT_CONTEXT,
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

  it("every cloud/harness model resolves to the flat 500k product default", () => {
    // 2026-09 product decision: the window is the provider's business — no
    // per-family guessing. Dated ids, harness aliases, relay-remapped names,
    // and unknowns all show the same ceiling.
    expect(contextWindowFor("claude-sonnet-4-5-20250929", false)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor("glm-5.2", false)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor("kimi-k3", false)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor("gpt-4o", false)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor("deepseek-v4-pro", false)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor("totally-unknown-model", false)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined, false)).toBe(API_CONTEXT_WINDOW);
  });

  it("ignores a stale localCtx on an API/cloud session (slider is global UI state)", () => {
    // After dragging the Context slider on a local model, that value stays in
    // the global store when the user switches to an API session. It must not
    // bleed into the API meter — the auto-compact path is LocalGguf-only and
    // never reads this value, so honoring it here would just mislead the user.
    expect(contextWindowFor("claude-sonnet-4-5", false, 8192)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor("totally-unknown-model", false, 131072)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined, false, 4096)).toBe(API_CONTEXT_WINDOW);
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
