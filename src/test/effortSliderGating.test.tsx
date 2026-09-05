// The effort slider renders ONLY where it maps to a real model control:
// builtin sessions on reasoning models (reasoning_effort) or Claude
// (extended-thinking budget). Harness/ACP sessions have no effort parameter
// on their CLI send path, and non-reasoning models ignore the field — the
// slider must be hidden rather than pretend.
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
  it("shows for a builtin session on a reasoning model (openai pane)", () => {
    renderPicker({ model: "gpt-5" });
    expect(slider()).toBeTruthy();
  });

  it("shows for a builtin Claude session on the anthropic provider (thinking budget)", () => {
    renderPicker({ model: "claude-sonnet-4-5", provider: "anthropic" });
    expect(slider()).toBeTruthy();
  });

  it("hides for a builtin session on a non-reasoning model", () => {
    renderPicker({ model: "gpt-4o" });
    expect(slider()).toBeNull();
    renderPicker({ model: "glm-5.3", provider: "openai_compatible" });
    expect(slider()).toBeNull();
  });

  it("hides for harness sessions — the CLI send path has no effort parameter", () => {
    renderPicker({
      agent: "harness:claude_code",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
    });
    expect(slider()).toBeNull();
  });

  it("hides for local sessions", () => {
    renderPicker({
      agent: "local",
      model: "Qwen3-8B-Q4_K_M.gguf",
      provider: "local_gguf",
    });
    expect(slider()).toBeNull();
  });

  it("auto sessions: shows on the resolved model, hides on the unresolved placeholder", () => {
    renderPicker({ provider: "auto", model: "gpt-5" });
    expect(slider()).toBeTruthy();
    cleanup();
    renderPicker({ provider: "auto", model: "auto" });
    expect(slider()).toBeNull();
  });

  it("changing the session model flips visibility live", () => {
    const view = renderPicker({ model: "gpt-4o" });
    expect(slider()).toBeNull();
    view.rerender(
      <AgentModelPicker
        agent="builtin"
        model="o3"
        provider="openai"
        effort=""
        onEffortChange={() => {}}
        onPick={() => {}}
      />,
    );
    expect(slider()).toBeTruthy();
  });
});
