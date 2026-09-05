// Model capability heuristics for the composer's effort slider.
//
// The slider maps to DIFFERENT real controls depending on the wire:
// - Anthropic / Anthropic-compatible: extended thinking with a token budget
//   (effort tiers → budget tiers; see chat/providers.rs
//   `anthropic_thinking_for`) — applies to every Claude model.
// - OpenAI-style wires (openai / openrouter / openai-compatible): the
//   `reasoning_effort` request parameter — honored by reasoning models
//   (OpenAI o-series, GPT-5 family; OpenRouter maps it further), silently
//   ignored by everything else.
// - Harness CLIs, ACP agents, local GGUF: nothing consumes it — the slider
//   must stay hidden there rather than pretend.

/** OpenAI-style reasoning models that honor `reasoning_effort`. OpenRouter
 *  ids carry a vendor prefix ("openai/o3"), so match on the bare id. */
export function supportsReasoningEffort(modelId: string): boolean {
  const id = modelId.toLowerCase();
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return /^(o1|o3|o4)([-.\d]|$)/.test(bare) || bare.startsWith("gpt-5");
}

/** Whether the effort slider has a real effect for this session's
 *  provider+model combination. `provider: "auto"` gates on the resolved
 *  model id: Claude models get the thinking-budget mapping, OpenAI
 *  reasoning models the wire parameter; an unresolved "auto" placeholder
 *  hides the slider (nothing resolved to judge yet). */
export function effortAppliesTo(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  if (!model || model === "auto") return false;
  const p = (provider ?? "").toLowerCase();
  if (p === "anthropic" || p === "anthropic_compatible") return true;
  if (p === "openai" || p === "openrouter" || p === "openai_compatible") {
    return supportsReasoningEffort(model);
  }
  if (p === "auto") {
    return supportsReasoningEffort(model) || model.toLowerCase().includes("claude");
  }
  return false;
}
