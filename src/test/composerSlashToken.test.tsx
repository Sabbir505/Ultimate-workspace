// Slash-menu token consumption: picking an item (keyboard or mouse) must
// REPLACE the typed token — the applied pill may never sit next to the
// partial "/res" text it stands for. Regression: a selection landing in a
// handler whose view of the draft was a keystroke behind left "/res" in the
// box with the Research pill applied.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

import { ChatComposer } from "../components/chat/ChatComposer";

afterEach(cleanup);

function renderComposer() {
  const onSend = vi.fn();
  const { container } = render(
    <ChatComposer
      sessionId="s1"
      onSend={onSend}
      streaming={false}
      onAgentModelPick={() => {}}
    />,
  );
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  return { onSend, container, ta };
}

describe("slash menu consumes the typed token", () => {
  it("clears the token when a command is picked with Enter", () => {
    const { ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "/res" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(ta.value).toBe("");
    expect(screen.getByText("Research")).toBeTruthy();
  });

  it("clears the token when a command is picked with the mouse", () => {
    const { container, ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "/res" } });
    const item = container.querySelector<HTMLElement>(".composer-slash-item")!;
    fireEvent.mouseDown(item);
    expect(ta.value).toBe("");
  });

  it("keeps surrounding text when the token is mid-sentence", () => {
    const { container, ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "hey /res" } });
    const item = container.querySelector<HTMLElement>(".composer-slash-item")!;
    fireEvent.mouseDown(item);
    expect(ta.value).toBe("hey ");
  });

  it("routes a /research send through research mode with the token stripped", () => {
    const { onSend, ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "/research the evolution of CPUs" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledWith("the evolution of CPUs", [], true);
  });
});
