// The effort slider shows on every pane the wire can carry it AND that
// doesn't already own a slider: provider rails and local (local_gguf rides
// the OpenAI body, so reasoning_effort is sent — ignored by servers that
// don't use it, and "" filters to nothing at the send boundary). The Auto
// pane keeps only its routing-bias slider; harness/ACP panes stay
// slider-free: the CLI/agent owns its own reasoning config and its send
// path has no effort channel.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

import { AgentModelPicker } from "../components/chat/AgentModelPicker";

const openPicker = (container: HTMLElement) => {
  fireEvent.click(container.querySelector<HTMLElement>(".agent-chip")!);
};

function renderPicker(props: Partial<Parameters<typeof AgentModelPicker>[0]> = {}) {
  const view = render(
    <AgentModelPicker
      agent="builtin"
      model="gpt-4o"
      provider="openai"
      effort=""
      onEffortChange={() => {}}
      onPick={() => {}}
      {...props}
    />,
  );
  openPicker(view.container);
  return view;
}

const slider = () => screen.queryByRole("slider", { name: "Reasoning effort" });

afterEach(cleanup);

describe("effort slider gating", () => {
  it("shows on the openai pane for every model — reasoning or not", () => {
    renderPicker({ model: "gpt-5" });
    expect(slider()).toBeTruthy();
    cleanup();
    renderPicker({ model: "gpt-4o" });
    expect(slider()).toBeTruthy();
  });

  it("shows on openai_compatible panes for vendor models (glm, deepseek, …)", () => {
    renderPicker({ model: "glm-5.3", provider: "openai_compatible" });
    expect(slider()).toBeTruthy();
    cleanup();
    renderPicker({ model: "deepseek-v4", provider: "openrouter" });
    expect(slider()).toBeTruthy();
  });

  it("shows for a builtin Claude session on the anthropic provider (thinking budget)", () => {
    renderPicker({ model: "claude-sonnet-4-5", provider: "anthropic" });
    expect(slider()).toBeTruthy();
  });

  it("hides on the Auto pane — the bias slider owns that pane", () => {
    // A manual effort is ambiguous in auto mode (the model changes per
    // message), and stacking it under the routing-bias slider read as
    // clutter. Auto keeps a single slider.
    renderPicker({ provider: "auto", model: "gpt-5" });
    expect(slider()).toBeNull();
    expect(screen.queryByRole("slider", { name: "Auto routing bias" })).toBeNull();
    cleanup();
    renderPicker({ provider: "auto", model: "auto" });
    expect(slider()).toBeNull();
  });

  it("stays visible across model changes — visibility is pane-scoped now", () => {
    const view = renderPicker({ model: "gpt-4o" });
    expect(slider()).toBeTruthy();
    view.rerender(
      <AgentModelPicker
        agent="builtin"
        model="glm-5.3"
        provider="openai_compatible"
        effort=""
        onEffortChange={() => {}}
        onPick={() => {}}
      />,
    );
    expect(slider()).toBeTruthy();
  });

  it("hides on harness panes — the CLI send path has no effort parameter", () => {
    renderPicker({
      agent: "harness:claude_code",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
    });
    expect(slider()).toBeNull();
  });

  it("shows on the local pane — local_gguf rides the OpenAI wire", () => {
    // reasoning_effort is sent with the request body; llama-server ignores
    // unknown fields and vLLM/LM Studio-class servers accept it. The slider
    // also makes pre-set effort visible instead of flowing in invisibly.
    renderPicker({
      agent: "local",
      model: "Qwen3-8B-Q4_K_M.gguf",
      provider: "local_gguf",
    });
    expect(slider()).toBeTruthy();
  });

  it("hides on ACP panes — the agent picks its own model and reasoning", () => {
    renderPicker({ agent: "acp:zed", model: "", provider: undefined });
    expect(slider()).toBeNull();
  });

  it("hides when the chat didn't wire an effort callback", () => {
    renderPicker({ onEffortChange: undefined });
    expect(slider()).toBeNull();
  });
});
