// Composer predictions — the TRIGGER. onDone's tail asks the backend for a
// suggested next message only when: the feature is on, the finished turn is
// the session the user is viewing, the post-turn refetch succeeded, and
// nothing else claimed the composer. These guards are the difference between
// a neat feature and surprise token spend, so they get their own file (the
// ghost/interaction side lives in composerPredictions.test.tsx).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  sendChatMessage: vi.fn(),
  sendAgentChatMessage: vi.fn(),
  cancelChatMessage: vi.fn(),
  cancelAgentChatMessage: vi.fn(),
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatSessions: vi.fn().mockResolvedValue([]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn(),
  generateChatTitle: vi.fn().mockResolvedValue(null),
  generateChatSuggestion: vi.fn().mockResolvedValue(null),
  getChatConfig: vi.fn(),
  getChatSessionMetrics: vi.fn(),
  setChatSessionUnread: vi.fn().mockResolvedValue(undefined),
  setChatSessionStarred: vi.fn(),
  setChatSessionProject: vi.fn(),
  updateChatSessionTitle: vi.fn(),
  updateChatSessionModel: vi.fn(),
  updateChatSessionProvider: vi.fn(),
  updateChatSessionAgent: vi.fn(),
  updateChatSessionWatchMode: vi.fn(),
  deleteChatSession: vi.fn(),
  deleteAllChatSessions: vi.fn(),
  deleteChatMessage: vi.fn(),
  persistPartialChatMessage: vi.fn(),
  setChatApiKey: vi.fn(),
  deleteChatApiKey: vi.fn(),
  readArtifactPreview: vi.fn(),
  emitMobileSessionChatEvent: vi.fn(),
  loopSessionStart: vi.fn().mockResolvedValue(null),
  loopSessionAdvance: vi.fn().mockResolvedValue(undefined),
  loopSessionFinish: vi.fn().mockResolvedValue(undefined),
  finishArtifactRuns: vi.fn().mockResolvedValue(0),
}));

import { useChatStore } from "../state/chat";
import { useSettingsStore } from "../state/settings";

const SID = "sess-predict-trigger";

function seedStore(active: string | null = SID) {
  useChatStore.setState({
    sessions: [
      { id: SID, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never,
    ],
    activeChatSessionId: active,
    messages: [],
    streaming: {},
    streamingChatSessionId: null,
    loopState: {},
    messageQueue: {},
    composerSuggestions: {},
    turnGeneration: {},
  });
}

/** onDone re-reads messages through getChatMessages — seed it with the
 *  just-finished assistant turn (needed by the `messages !== null` guard). */
async function seedFinishedTurn() {
  const ipc = await import("../lib/ipc");
  vi.mocked(ipc.getChatMessages).mockResolvedValue([
    {
      id: 1,
      chatSessionId: SID,
      role: "assistant",
      content: "done",
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      createdAt: 0,
      startedAt: null,
      completedAt: null,
    } as never,
  ]);
  return ipc;
}

describe("onDone composer-prediction trigger", () => {
  beforeEach(() => {
    useSettingsStore.setState({ composerPredictions: true, composerPredictionsModel: "" });
    seedStore();
    vi.clearAllMocks();
  });

  it("asks for a suggestion after a completed turn in the viewed session", async () => {
    const ipc = await seedFinishedTurn();
    vi.mocked(ipc.generateChatSuggestion).mockResolvedValue("Run the tests again");

    await useChatStore.getState().onDone(SID, null, null, null);

    expect(ipc.generateChatSuggestion).toHaveBeenCalledWith(SID);
    await vi.waitFor(() =>
      expect(useChatStore.getState().composerSuggestions[SID]).toBe("Run the tests again"),
    );
  });

  it("stays silent when the feature is disabled in settings", async () => {
    useSettingsStore.setState({ composerPredictions: false });
    const ipc = await seedFinishedTurn();

    await useChatStore.getState().onDone(SID, null, null, null);

    expect(ipc.generateChatSuggestion).not.toHaveBeenCalled();
  });

  it("stays silent for a turn in a session the user is not viewing", async () => {
    seedStore("some-other-session");
    const ipc = await seedFinishedTurn();

    await useChatStore.getState().onDone(SID, null, null, null);

    expect(ipc.generateChatSuggestion).not.toHaveBeenCalled();
  });

  it("stays silent for a watched automation-run turn", async () => {
    const ipc = await seedFinishedTurn();

    // `chat:done` carries source:"automation" for scheduler runs — the
    // suggestion belongs to conversations the user is steering, not runs.
    await useChatStore
      .getState()
      .onDone(SID, null, null, null, null, null, null, null, null, "automation");

    expect(ipc.generateChatSuggestion).not.toHaveBeenCalled();
  });

  it("survives a rejected suggestion call without surfacing an error", async () => {
    const ipc = await seedFinishedTurn();
    vi.mocked(ipc.generateChatSuggestion).mockRejectedValue(new Error("provider down"));

    await expect(useChatStore.getState().onDone(SID, null, null, null)).resolves.toBeUndefined();
    expect(useChatStore.getState().composerSuggestions[SID] ?? null).toBeNull();
  });

  it("drops a suggestion that arrives after a new turn has started", async () => {
    const ipc = await seedFinishedTurn();
    let resolveSuggestion!: (text: string | null) => void;
    vi.mocked(ipc.generateChatSuggestion).mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveSuggestion = resolve;
        }),
    );

    await useChatStore.getState().onDone(SID, null, null, null);
    expect(ipc.generateChatSuggestion).toHaveBeenCalledTimes(1);

    // The user sends again before the backend answers — the next turn bumps
    // the session's generation, so the late result must be discarded.
    useChatStore.setState((s) => ({
      turnGeneration: { ...s.turnGeneration, [SID]: (s.turnGeneration[SID] ?? 0) + 1 },
    }));
    resolveSuggestion("stale suggestion");
    await Promise.resolve();
    await Promise.resolve();

    expect(useChatStore.getState().composerSuggestions[SID] ?? null).toBeNull();
  });
});
