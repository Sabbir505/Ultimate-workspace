// Regression test (audit B-20): onDone's session-list refresh is best-effort.
// `listChatSessions` can reject transiently (safeInvoke — e.g. the DB briefly
// locked by the message write that just landed) and the rejection used to
// abort onDone BEFORE drainQueue and the goal-loop advance, stranding queued
// messages until the user manually sent.
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
}));

import { listChatSessions, sendChatMessage } from "../lib/ipc";
import { useChatStore } from "../state/chat";

function seed() {
  useChatStore.setState({
    sessions: [
      {
        id: "s1",
        title: "s1",
        provider: "openai",
        model: "m",
        createdAt: 0,
        lastActiveAt: 0,
      },
    ] as never,
    activeChatSessionId: "s1",
    messages: [],
    streaming: {},
    chatStatus: {},
    streamingChatSessionId: null,
    messageQueue: {
      s1: [{ id: 1, content: "queued while streaming" }],
    } as never,
    loopState: {},
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps factory implementations — reseed the defaults so a
  // rejection set by an earlier test cannot leak into the next one.
  (listChatSessions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (sendChatMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  seed();
});

describe("onDone relist failure (audit B-20)", () => {
  it("still drains the queue when listChatSessions rejects", async () => {
    (listChatSessions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("database is locked"));

    // Must resolve (no unhandled rejection) and reach the drain below.
    await useChatStore.getState().onDone("s1", 1, 1, 0, null, null, null, null, null);
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    await Promise.resolve();

    // The queued message left the queue and went out as the next turn.
    expect(useChatStore.getState().messageQueue.s1 ?? []).toHaveLength(0);
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    const call = (sendChatMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("s1");
    expect(call[1]).toBe("queued while streaming");
  });

  it("drains the queue when the relist succeeds (unchanged happy path)", async () => {
    await useChatStore.getState().onDone("s1", 1, 1, 0, null, null, null, null, null);
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    expect(useChatStore.getState().messageQueue.s1 ?? []).toHaveLength(0);
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });
});
