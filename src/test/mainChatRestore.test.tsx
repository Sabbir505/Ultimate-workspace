// Regression: the Bots view renders the real ChatView on a bot session, which
// hijacks the shared activeChatSessionId. Toggling back to Chat must hand the
// main chat its own session back, not leave the bot session showing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";
import { useMainChatRestore } from "../hooks/useMainChatRestore";

function Harness() {
  useMainChatRestore();
  return null;
}

const mainSession = { id: "main-1", botId: null, botRole: null };
const botThread = { id: "bot-thread", botId: "b1", botRole: "thread" };

beforeEach(() => {
  useUiStore.setState({ baseView: "chat", activeView: "chat" });
});

afterEach(() => cleanup());

describe("useMainChatRestore", () => {
  it("restores the last main chat when leaving the bots view", () => {
    const selectSession = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      selectSession: selectSession as never,
      sessions: [mainSession, botThread] as never,
      activeChatSessionId: "main-1",
    });

    render(<Harness />); // remembers main-1

    // Enter Bots and open the bot's session (what BotsView does).
    act(() => useUiStore.setState({ baseView: "bots" }));
    act(() => useChatStore.setState({ activeChatSessionId: "bot-thread" }));

    // Toggle back to Chat.
    act(() => useUiStore.setState({ baseView: "chat" }));

    expect(selectSession).toHaveBeenCalledWith("main-1", { recordNav: false });
  });

  it("leaves an ordinary chat switch untouched", () => {
    const selectSession = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      selectSession: selectSession as never,
      sessions: [mainSession, botThread] as never,
      activeChatSessionId: "main-1",
    });
    render(<Harness />);
    act(() => useUiStore.setState({ baseView: "bots" }));
    // User picked a real chat from the sidebar while in Bots.
    act(() => useChatStore.setState({ activeChatSessionId: "main-1" }));
    act(() => useUiStore.setState({ baseView: "chat" }));
    expect(selectSession).not.toHaveBeenCalled();
  });
});
