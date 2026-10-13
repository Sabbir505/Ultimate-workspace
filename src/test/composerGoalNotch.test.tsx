// The active-goal notch above the composer card: a session pursuing a /goal
// or /loop shows "Pursuing goal" + the goal text fused to the card's top
// seam; with no loop armed — or once the loop goes inactive (complete /
// blocked / stop) — the notch is gone. The notch is scoped to the composer's
// OWN session (split view renders one composer per pane), not to the globally
// active session.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatComposer } from "../components/chat/ChatComposer";
import { useChatStore } from "../state/chat";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listConnectors: vi.fn(async () => []),
  mcpGalleryList: vi.fn(async () => ({ installed: [] })),
  listSessionConnectors: vi.fn(async () => []),
  listChatSkills: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
}));

afterEach(() => {
  cleanup();
  useChatStore.setState({ activeChatSessionId: null, loopState: {} });
});

const SESSION = "goal-notch-test";

const loop = (active: boolean) => ({
  goal: "Ship the notch",
  iteration: active ? 1 : 3,
  max: 10,
  active,
  startedAt: Date.now(),
});

function renderComposer(sessionId: string) {
  render(
    <ChatComposer
      sessionId={sessionId}
      onSend={vi.fn()}
      streaming={false}
      onAgentModelPick={vi.fn()}
    />,
  );
}

describe("composer goal notch", () => {
  it("announces the active goal on the composer's own session", () => {
    useChatStore.setState({
      activeChatSessionId: SESSION,
      loopState: { [SESSION]: loop(true) },
    });
    renderComposer(SESSION);
    expect(document.querySelector(".composer-goal-notch")).toBeTruthy();
    expect(screen.getByText("Pursuing goal")).toBeTruthy();
    expect(screen.getByText("Ship the notch")).toBeTruthy();
  });

  it("shows how long the goal has been running", () => {
    useChatStore.setState({
      activeChatSessionId: SESSION,
      loopState: { [SESSION]: { ...loop(true), startedAt: Date.now() - 90_000 } },
    });
    renderComposer(SESSION);
    expect(screen.getByText("1m 30s")).toBeTruthy();
  });

  it("hides the notch when the loop is no longer active", () => {
    useChatStore.setState({
      activeChatSessionId: SESSION,
      loopState: { [SESSION]: loop(false) },
    });
    renderComposer(SESSION);
    expect(document.querySelector(".composer-goal-notch")).toBeNull();
  });

  it("shows the pane's goal even when another session is globally active (split view)", () => {
    useChatStore.setState({
      activeChatSessionId: "some-other-session",
      loopState: { [SESSION]: loop(true) },
    });
    renderComposer(SESSION);
    expect(screen.getByText("Pursuing goal")).toBeTruthy();
  });

  it("never shows another session's goal", () => {
    useChatStore.setState({
      activeChatSessionId: SESSION,
      loopState: { "some-other-session": loop(true) },
    });
    renderComposer(SESSION);
    expect(document.querySelector(".composer-goal-notch")).toBeNull();
  });
});
