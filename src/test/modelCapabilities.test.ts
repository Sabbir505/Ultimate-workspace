// The effort slider must map to REAL model controls: reasoning_effort on
// OpenAI-style wires (reasoning models only), the extended-thinking budget
// for Claude, and nothing — hence no slider — for harness/ACP/local sessions
// and non-reasoning models.
import { describe, expect, it } from "vitest";
import { effortAppliesTo, supportsReasoningEffort } from "../lib/modelCapabilities";

describe("supportsReasoningEffort", () => {
  it("matches the OpenAI reasoning families, vendor prefixes included", () => {
    expect(supportsReasoningEffort("o3")).toBe(true);
    expect(supportsReasoningEffort("o1-mini")).toBe(true);
    expect(supportsReasoningEffort("o4-mini")).toBe(true);
    expect(supportsReasoningEffort("gpt-5")).toBe(true);
    expect(supportsReasoningEffort("gpt-5-mini")).toBe(true);
    expect(supportsReasoningEffort("openai/gpt-5-codex")).toBe(true);
    expect(supportsReasoningEffort("openai/o3")).toBe(true);
  });

  it("rejects non-reasoning models", () => {
    expect(supportsReasoningEffort("gpt-4o")).toBe(false);
    expect(supportsReasoningEffort("gpt-4.1-mini")).toBe(false);
    expect(supportsReasoningEffort("claude-sonnet-4-5")).toBe(false);
    expect(supportsReasoningEffort("deepseek-chat")).toBe(false);
    expect(supportsReasoningEffort("glm-5.3")).toBe(false);
    expect(supportsReasoningEffort("openrouter/deepseek/deepseek-r1")).toBe(false);
  });
});

describe("effortAppliesTo", () => {
  it("applies to every Claude model on the Anthropic wires (thinking-budget mapping)", () => {
    expect(effortAppliesTo("anthropic", "claude-sonnet-4-5")).toBe(true);
    expect(effortAppliesTo("anthropic", "claude-haiku-4-5")).toBe(true);
    expect(effortAppliesTo("anthropic_compatible", "claude-opus-4-8")).toBe(true);
  });

  it("applies on OpenAI-style wires only for reasoning models", () => {
    expect(effortAppliesTo("openai", "o3")).toBe(true);
    expect(effortAppliesTo("openrouter", "openai/gpt-5")).toBe(true);
    expect(effortAppliesTo("openai_compatible", "o4-mini")).toBe(true);
    expect(effortAppliesTo("openai", "gpt-4o")).toBe(false);
    expect(effortAppliesTo("openai_compatible", "glm-5.3")).toBe(false);
  });

  it("auto sessions gate on the resolved model id", () => {
    expect(effortAppliesTo("auto", "gpt-5")).toBe(true);
    expect(effortAppliesTo("auto", "claude-sonnet-4-5")).toBe(true);
    expect(effortAppliesTo("auto", "glm-5.3")).toBe(false);
    // Unresolved placeholder — nothing to judge yet.
    expect(effortAppliesTo("auto", "auto")).toBe(false);
  });

  it("never applies to local or unknown providers", () => {
    expect(effortAppliesTo("local_gguf", "gpt-5")).toBe(false);
    expect(effortAppliesTo(null, "gpt-5")).toBe(false);
    expect(effortAppliesTo("openai", null)).toBe(false);
    expect(effortAppliesTo("openai", "")).toBe(false);
  });
});
