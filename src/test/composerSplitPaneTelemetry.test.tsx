// B2 (ISSUES.md): in split view each pane has its own composer, but the
// telemetry HUD (ComposerMetrics) and the context meter resolved their session
// from the GLOBAL active pointer (`activeChatSessionId`) instead of the pane's
// `sessionId` prop — so the split-pane composer rendered the MAIN session's
// perf chips and context breakdown. Both must use `effectiveSessionId`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatComposer } from "../components/chat/ChatComposer";
import { useChatStore } from "../state/chat";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listConnectors: vi.fn(async () => []),
  mcpGalleryList: vi.fn(async () => ({ installed: [] })),
  listSessionConnectors: vi.fn(async () => []),
  listChatSkills: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
  // The context meter's hover breakdown — the session id it receives is the
  // contract under test.
  countContextBreakdown: vi.fn(async () => null),
}));

import { countContextBreakdown } from "../lib/ipc";

const breakdownMock = vi.mocked(countContextBreakdown);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useChatStore.setState({ activeChatSessionId: null, sessionMetrics: {}, livePerf: {}, lastTurnPerf: {} });
});

function seedStores() {
  useChatStore.setState({
    // The MAIN view shows session main-1; the pane's composer targets split-1.
    activeChatSessionId: "main-1",
    livePerf: {},
    lastTurnPerf: {},
    sessionMetrics: {
      "split-1": {
        chatSessionId: "split-1",
        inputTokens: 7700,
        outputTokens: 1200,
        llmTimeMs: 4200,
        toolTimeMs: 100,
        ttftAvgMs: 300,
        tokensPerSecond: 40,
        cacheHitRate: 0.4,
        turnCount: 2,
      },
    },
  });
}

function renderSplitPaneComposer() {
  render(
    <ChatComposer
      sessionId="split-1"
      onSend={vi.fn()}
      streaming={false}
      onAgentModelPick={vi.fn()}
    />,
  );
}

describe("split-pane composer telemetry resolves the pane's session", () => {
  it("feeds ComposerMetrics from the pane's session aggregate, not the active one", () => {
    seedStores();
    renderSplitPaneComposer();
    // 7700 tokens → "7.7k tok" on the `in` chip. With the bug the HUD read
    // main-1 (no data) and rendered em-dashes instead.
    expect(screen.getByText("7.7k tok")).toBeTruthy();
    expect(screen.getByText("1.2k tok")).toBeTruthy();
  });

  it("asks the context-meter breakdown for the pane's session on hover", async () => {
    seedStores();
    renderSplitPaneComposer();
    const circle = document.querySelector(".context-meter-circle") as HTMLElement;
    expect(circle).not.toBeNull();
    fireEvent.mouseEnter(circle);
    await vi.waitFor(() => {
      expect(breakdownMock).toHaveBeenCalledWith("split-1");
    });
  });
});
