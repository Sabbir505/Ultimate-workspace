// A4 (ISSUES.md): onDone's post-turn refetch (getChatMessages) is wrapped in
// `catch { /* keep null */ }` — but the goal-loop advance then read the
// "last assistant reply" from the STALE in-store buffer (the previous turn's
// message) and fed it to advanceLoop. On a transient refetch failure the loop
// could advance on a reply it had already processed. The fix: skip the loop
// advance when the refetch failed.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  sendChatMessage: vi.fn(),
  sendAgentChatMessage: vi.fn(),
  cancelChatMessage: vi.fn().mockResolvedValue(undefined),
  cancelAgentChatMessage: vi.fn().mockResolvedValue(undefined),
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatSessions: vi.fn().mockResolvedValue([]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  listChatCheckpoints: vi.fn().mockResolvedValue([]),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn(),
  generateChatTitle: vi.fn().mockResolvedValue(null),
  getChatConfig: vi.fn(),
  getChatSessionMetrics: vi.fn().mockResolvedValue(null),
  setChatSessionUnread: vi.fn().mockResolvedValue(undefined),
  setChatSessionStarred: vi.fn(),
  setChatSessionProject: vi.fn(),
  updateChatSessionTitle: vi.fn(),
  updateChatSessionModel: vi.fn(),
  updateChatSessionProvider: vi.fn(),
  updateChatSessionAgent: vi.fn(),
  updateChatSessionWatchMode: vi.fn(),
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  deleteAllChatSessions: vi.fn().mockResolvedValue(0),
  deleteChatMessage: vi.fn(),
  persistPartialChatMessage: vi.fn().mockResolvedValue(undefined),
  setChatApiKey: vi.fn(),
  deleteChatApiKey: vi.fn(),
  readArtifactPreview: vi.fn(),
  loopSessionStart: vi.fn().mockResolvedValue(null),
  loopSessionAdvance: vi.fn().mockResolvedValue(undefined),
  loopSessionFinish: vi.fn().mockResolvedValue(undefined),
  finishArtifactRuns: vi.fn().mockResolvedValue(0),
}));

import { getChatMessages } from "../lib/ipc";
import { useChatStore } from "../state/chat";

const id = "sess-stale-refetch";

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    sessions: [{ id, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never],
    activeChatSessionId: id,
    messages: [],
    streaming: {},
    streamingChatSessionId: null,
    loopState: {},
    messageQueue: {},
  });
});

describe("A4: a failed post-turn refetch must not advance the goal loop", () => {
  it("issues no continuation turn when getChatMessages rejects", async () => {
    useChatStore.getState().startLoop("iterate this goal");
    // The in-store buffer still holds the PREVIOUS turn's reply with a
    // continue sentinel — exactly the stale data that must NOT drive the
    // loop when the refetch fails.
    useChatStore.setState({
      messages: [
        { id: 1, chatSessionId: id, role: "assistant", content: "old turn\nLOOP_STATUS: continue" } as never,
      ],
    });
    vi.mocked(getChatMessages).mockRejectedValue(new Error("ipc down"));

    const sendSpy = vi.spyOn(useChatStore.getState(), "sendMessage").mockResolvedValue(undefined);

    await useChatStore.getState().onDone(id, null, null, null);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendSpy).not.toHaveBeenCalled();
    // The loop stays armed at the same iteration — nothing was consumed.
    const loop = useChatStore.getState().loopState[id];
    expect(loop.active).toBe(true);
    expect(loop.iteration).toBe(0);

    sendSpy.mockRestore();
  });

  it("still advances on a continue reply when the refetch succeeds (no regression)", async () => {
    useChatStore.getState().startLoop("iterate this goal");
    vi.mocked(getChatMessages).mockResolvedValue([
      { id: 2, chatSessionId: id, role: "assistant", content: "did step\nLOOP_STATUS: continue" } as never,
    ]);
    const sendSpy = vi.spyOn(useChatStore.getState(), "sendMessage").mockResolvedValue(undefined);

    await useChatStore.getState().onDone(id, null, null, null);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0] as string).toContain("[loop iteration 1/");
    sendSpy.mockRestore();
  });
});
