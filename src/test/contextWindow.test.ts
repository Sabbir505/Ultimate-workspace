import { describe, expect, it } from "vitest";
import {
  API_CONTEXT_WINDOW,
  contextWindowFor,
  formatTokens,
  LOCAL_DEFAULT_CONTEXT,
} from "../lib/contextWindow";

describe("contextWindowFor (two-path sizing)", () => {
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

  it("uses the flat 256K cap for API/cloud models regardless of model id", () => {
    expect(contextWindowFor("claude-sonnet-4-5", false, undefined)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor("gpt-4o", false, 0)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor("some-unknown-model", false, undefined)).toBe(API_CONTEXT_WINDOW);
  });

  it("ignores a stale localCtx on an API/cloud session (slider is global UI state)", () => {
    // After dragging the Context slider on a local model, that value stays in
    // the global store when the user switches to an API session. It must not
    // bleed into the API meter — the auto-compact path is LocalGguf-only and
    // never reads this value, so honoring it here would just mislead the user.
    expect(contextWindowFor("claude-sonnet-4-5", false, 8192)).toBe(API_CONTEXT_WINDOW);
    expect(contextWindowFor("gpt-4o", false, 131072)).toBe(API_CONTEXT_WINDOW);
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
