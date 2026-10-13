// Composer predictions: the backend suggests the user's next message after a
// completed turn; the composer shows it as ghost text over an EMPTY draft, Tab
// fills the draft with it (never sends), Escape dismisses, and typing simply
// hides it. Also guards the precedence rules: an open slash/@ menu keeps Tab,
// and a live draft or an ↑/↓ recall walk is never clobbered by the ghost.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

import { ChatComposer } from "../components/chat/ChatComposer";
import { useChatStore } from "../state/chat";
import { useSettingsStore } from "../state/settings";

afterEach(cleanup);

beforeEach(() => {
  useSettingsStore.setState({ composerPredictions: true });
  // The stores are module-global and survive between tests — reset this
  // file's sessions so a draft typed in one test can't hide the next test's
  // ghost (or leak a suggestion into a test that expects none).
  for (const sid of [SID, "s-predict-recall"]) {
    useChatStore.getState().setComposerDraft(sid, "");
    useChatStore.getState().setComposerSuggestion(sid, null);
  }
});

const SID = "s-predict";

function renderComposer(sessionId: string = SID) {
  const onSend = vi.fn();
  const { container } = render(
    <ChatComposer
      sessionId={sessionId}
      onSend={onSend}
      streaming={false}
      onAgentModelPick={() => {}}
    />,
  );
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  return { onSend, container, ta };
}

const ghost = () => document.querySelector<HTMLElement>(".composer-ghost");

function setSuggestion(sessionId: string, text: string | null) {
  useChatStore.getState().setComposerSuggestion(sessionId, text);
}

describe("composer prediction ghost", () => {
  it("renders the suggestion over an empty composer and blanks the placeholder", () => {
    setSuggestion(SID, "Run the tests again");
    const { ta } = renderComposer();
    expect(ghost()?.textContent).toContain("Run the tests again");
    expect(ta.placeholder).toBe("");
  });

  it("is hidden when the draft already has text", () => {
    setSuggestion(SID, "Run the tests again");
    const { ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "wip" } });
    expect(ghost()).toBeNull();
  });

  it("is hidden when the feature is disabled in settings", () => {
    useSettingsStore.setState({ composerPredictions: false });
    setSuggestion(SID, "Run the tests again");
    renderComposer();
    expect(ghost()).toBeNull();
  });

  it("Tab accepts: fills the draft, clears the ghost, and never sends", () => {
    setSuggestion(SID, "Commit this with a clear message");
    const { onSend, ta } = renderComposer();
    fireEvent.keyDown(ta, { key: "Tab" });
    expect(ta.value).toBe("Commit this with a clear message");
    expect(ghost()).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    // The suggestion was consumed — a second Tab has nothing to accept.
    expect(useChatStore.getState().composerSuggestions[SID] ?? null).toBeNull();
  });

  it("Escape dismisses without touching the draft", () => {
    setSuggestion(SID, "Run the tests again");
    const { ta } = renderComposer();
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(ghost()).toBeNull();
    expect(ta.value).toBe("");
    expect(useChatStore.getState().composerSuggestions[SID] ?? null).toBeNull();
  });

  it("typing hides the ghost but keeps the suggestion for a cleared box", () => {
    setSuggestion(SID, "Run the tests again");
    const { ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "x" } });
    expect(ghost()).toBeNull();
    fireEvent.change(ta, { target: { value: "" } });
    expect(ghost()?.textContent).toContain("Run the tests again");
  });

  it("an open slash menu keeps Tab — the ghost never shadows it", () => {
    setSuggestion(SID, "Run the tests again");
    const { ta } = renderComposer();
    fireEvent.change(ta, { target: { value: "/res" } });
    expect(ghost()).toBeNull();
    fireEvent.keyDown(ta, { key: "Tab" });
    // The menu applied its highlighted item (the pill), not a ghost accept.
    expect(document.querySelector(".composer-token-command")?.textContent).toContain("Research");
    expect(ta.value).toBe("");
  });

  it("↑ recall is unaffected and its text is never replaced by the ghost", () => {
    const sid = "s-predict-recall";
    useChatStore.getState().pushPromptHistory(sid, "summarize the diff");
    setSuggestion(sid, "Run the tests again");
    const { ta } = renderComposer(sid);
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta.value).toBe("summarize the diff");
    expect(ghost()).toBeNull();
    // Tab over recalled text must not swap in the pending suggestion.
    fireEvent.keyDown(ta, { key: "Tab" });
    expect(ta.value).toBe("summarize the diff");
  });

  it("sending is still Enter — an accepted suggestion is not auto-sent", () => {
    setSuggestion(SID, "Run the tests again");
    const { onSend, ta } = renderComposer();
    fireEvent.keyDown(ta, { key: "Tab" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("Run the tests again", [], undefined);
  });
});
