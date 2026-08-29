import { afterEach, describe, expect, it } from "vitest";
import {
  API_CONTEXT_WINDOW,
  catalogContextWindow,
  contextWindowFor,
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

  it("matches model families — harness catalog ids and dated variants", () => {
    expect(catalogContextWindow("claude-opus-4-8")).toBe(200_000);
    expect(catalogContextWindow("claude-sonnet-4-5-20250929")).toBe(200_000);
    expect(catalogContextWindow("kimi-k3")).toBe(256_000);
    expect(catalogContextWindow("glm-5.2")).toBe(200_000);
    expect(catalogContextWindow("deepseek-v4-pro")).toBe(128_000);
    expect(catalogContextWindow("gemini-3-pro")).toBe(1_000_000);
    expect(catalogContextWindow("gpt-4.1-mini")).toBe(1_000_000);
  });

  it("unknown models keep the flat API default", () => {
    expect(catalogContextWindow("totally-unknown-model")).toBeNull();
    expect(contextWindowFor("totally-unknown-model", false, undefined)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined, false)).toBe(API_CONTEXT_WINDOW);
  });

  it("ignores a stale localCtx on an API/cloud session (slider is global UI state)", () => {
    // After dragging the Context slider on a local model, that value stays in
    // the global store when the user switches to an API session. It must not
    // bleed into the API meter — the auto-compact path is LocalGguf-only and
    // never reads this value, so honoring it here would just mislead the user.
    expect(contextWindowFor("claude-sonnet-4-5", false, 8192)).toBe(200_000);
    expect(contextWindowFor("totally-unknown-model", false, 131072)).toBe(API_CONTEXT_WINDOW);
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
