// Slash-menu selection: picking an item APPLIES it — the typed token is
// consumed, the pill is the visible selection, and the slug serializes back
// into the sent message ("/research about cancer"). Regression guard for the
// stale-caret race that used to leave the partial "/rese" sitting next to
// the applied pill.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

import { ChatComposer } from "../components/chat/ChatComposer";
import { parseAttachments } from "../components/chat/MessageAttachments";

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

const pill = () => document.querySelector<HTMLElement>(".composer-token-command");

describe("slash menu applies the picked command", () => {
  it("consumes the token and shows the pill when picked with Enter", () => {
    const { ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "/res" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(ta.value).toBe("");
    expect(pill()?.textContent).toContain("Research");
  });

  it("consumes the token when picked with the mouse", () => {
    const { container, ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "/res" } });
    const item = container.querySelector<HTMLElement>(".composer-slash-item")!;
    fireEvent.mouseDown(item);
    expect(ta.value).toBe("");
    expect(pill()?.textContent).toContain("Research");
  });

  it("keeps surrounding text when the token is mid-sentence", () => {
    const { container, ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "hey /res" } });
    const item = container.querySelector<HTMLElement>(".composer-slash-item")!;
    fireEvent.mouseDown(item);
    expect(ta.value).toBe("hey ");
    expect(pill()?.textContent).toContain("Research");
  });

  it("serializes the pill slug into the sent message", () => {
    const { onSend, ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "/res" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    fireEvent.change(ta, { target: { value: "about cancer" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledWith("/research about cancer", [], undefined);
  });
});

describe("parseAttachments — connector marker", () => {
  it("extracts [Connected: …] names and strips the marker from the text", () => {
    const out = parseAttachments("check my emails\n\n[Connected: Gmail, Google Drive]");
    expect(out.connectors).toEqual(["Gmail", "Google Drive"]);
    expect(out.text).toBe("check my emails");
  });

  it("returns no connectors for plain messages", () => {
    const out = parseAttachments("just a normal message");
    expect(out.connectors).toEqual([]);
    expect(out.text).toBe("just a normal message");
  });
});
