// The "a turn is already running" report, hands-free edition: a send arriving
// while the agent has produced NOTHING yet (the pre-first-token thinking
// phase) must auto-cancel the silent turn and start the new one — queueing
// read as the app ignoring the send, and the backend rejects a second
// concurrent turn anyway. A turn with a VISIBLE partial keeps the queue: the
// user can see what it wrote and may genuinely want both, FIFO.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  sendChatMessage: vi.fn().mockResolvedValue(undefined),
  sendAgentChatMessage: vi.fn().mockResolvedValue(undefined),
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
  persistPartialChatMessage: vi.fn().mockResolvedValue(undefined),
  finishArtifactRuns: vi.fn().mockResolvedValue(0),
}));

import { cancelChatMessage, sendChatMessage } from "../lib/ipc";
import { useChatStore } from "../state/chat";

const id = "sess-voice";

function seed(streamingText: string | undefined) {
  useChatStore.setState({
    sessions: [
      { id, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never,
    ],
    activeChatSessionId: id,
    messages: [],
    streaming: streamingText === undefined ? {} : { [id]: streamingText },
    chatStatus: {},
    streamingChatSessionId: streamingText === undefined ? null : id,
    messageQueue: {},
    stoppedPartial: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendMessage vs a running turn", () => {
  it("auto-cancels a turn that has produced no output and sends the new one", async () => {
    seed(""); // the agent is "running" but has emitted nothing

    await useChatStore.getState().sendMessage("actually, do this instead");

    // The silent turn was cancelled, not queued.
    expect(cancelChatMessage).toHaveBeenCalledWith(id);
    // The new instruction went out as its own turn (exact arg spread varies
    // with send options; the session + content are the contract here).
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendChatMessage).mock.calls[0][0]).toBe(id);
    expect(vi.mocked(sendChatMessage).mock.calls[0][1]).toBe("actually, do this instead");
    // Nothing stacked.
    expect(useChatStore.getState().messageQueue[id] ?? []).toHaveLength(0);
  });

  it("queues behind a turn that already has a visible partial", async () => {
    seed("a partial reply the user can see");

    await useChatStore.getState().sendMessage("one more thing");

    expect(cancelChatMessage).not.toHaveBeenCalled();
    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().messageQueue[id]).toHaveLength(1);
    expect(useChatStore.getState().messageQueue[id][0].content).toBe("one more thing");
  });

  it("sends normally when no turn is running", async () => {
    seed(undefined);

    await useChatStore.getState().sendMessage("fresh message");

    expect(cancelChatMessage).not.toHaveBeenCalled();
    expect(sendChatMessage).toHaveBeenCalled();
  });
});
