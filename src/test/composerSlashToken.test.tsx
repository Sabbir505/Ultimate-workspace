// Slash-menu completion: applying an item replaces the partial token with
// the FULL slug inline in the draft ("/rese" → "/research ") — Discord/Slack
// style — so the slug rides the sent message (the user bubble shows the
// command that ran) and no partial text is ever left behind.
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

describe("slash menu completes the token inline", () => {
  it("completes /rese to '/research ' when picked with Enter", () => {
    const { ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "/rese" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(ta.value).toBe("/research ");
  });

  it("completes with the mouse too", () => {
    const { container, ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "/res" } });
    const item = container.querySelector<HTMLElement>(".composer-slash-item")!;
    fireEvent.mouseDown(item);
    expect(ta.value).toBe("/research ");
  });

  it("keeps surrounding text when the token is mid-sentence", () => {
    const { container, ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "hey /res" } });
    const item = container.querySelector<HTMLElement>(".composer-slash-item")!;
    fireEvent.mouseDown(item);
    expect(ta.value).toBe("hey /research ");
  });

  it("sends the slug with the message — the bubble shows the command that ran", async () => {
    // Full user story: complete the slug, type the topic, send. The menu
    // closing after completion is browser-verified (jsdom's caret-event
    // timing keeps it mounted here, harmlessly).
    const { onSend, ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "/rese" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    fireEvent.change(ta, { target: { value: "/research about cancer" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledWith("/research about cancer", [], undefined);
  });
});
