// Reconnect UX (chat/reconnect.rs): a dropped connection is re-dialed with a
// "Reconnecting… (n/10)" line under the assistant bubble, and the answer
// RESTARTS when a retry lands. Three store contracts keep that honest:
//
// 1. "reconnecting" is display-only — the partial the user watched stays on
//    screen while the ladder backs off.
// 2. "reconnect_restart" empties the live buffer (or the restarted answer
//    would append to the old one) but parks that text in `supersededPartial`.
// 3. If the ladder ultimately gives up, onError must persist the SUPERSEDED
//    text when the restarted attempt produced none of its own — the user
//    watched it, so it cannot vanish with the buffer.
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

import { persistPartialChatMessage } from "../lib/ipc";
import { clearStreamState, useChatStore } from "../state/chat";

const id = "sess-reconnect";
const WATCHED = "Half an answer the user had already read";

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    sessions: [
      { id, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never,
    ],
    activeChatSessionId: id,
    messages: [],
    streaming: { [id]: WATCHED },
    chatStatus: {},
    supersededPartial: {},
    streamingChatSessionId: id,
    messageQueue: {},
    loopState: {},
    stoppedPartial: {},
  });
});

describe("reconnect notices", () => {
  it("keeps the partial visible while the ladder backs off", () => {
    useChatStore.getState().onStatus(id, "reconnecting", "Reconnecting… (1/10)");

    const s = useChatStore.getState();
    expect(s.streaming[id]).toBe(WATCHED);
    expect(s.supersededPartial[id]).toBeUndefined();
    expect(s.chatStatus[id]).toEqual({
      reason: "reconnecting",
      message: "Reconnecting… (1/10)",
    });
  });

  it("drops the live buffer on restart but keeps the text aside", () => {
    useChatStore.getState().onStatus(id, "reconnecting", "Reconnecting… (2/10)");
    useChatStore.getState().onStatus(id, "reconnect_restart", "Reconnecting… (2/10)");

    const s = useChatStore.getState();
    // Empty, so the restarted answer streams into a clean buffer…
    expect(s.streaming[id]).toBe("");
    // …and the text that was on screen is still recoverable for the error path.
    expect(s.supersededPartial[id]).toBe(WATCHED);
    // The line stays up: the retry is in flight, not done.
    expect(s.chatStatus[id]?.reason).toBe("reconnect_restart");
  });

  it("clears the line when the recovered stream starts producing tokens", () => {
    useChatStore.getState().onStatus(id, "reconnect_restart", "Reconnecting… (3/10)");

    useChatStore.getState().onToken(id, "the answer");

    const s = useChatStore.getState();
    expect(s.chatStatus[id]).toBeUndefined();
    expect(s.streaming[id]).toBe("the answer");
  });

  it("a terminal reconnected notice retires the line on its own", () => {
    useChatStore.getState().onStatus(id, "reconnect_restart", "Reconnecting… (3/10)");

    useChatStore.getState().onStatus(id, "reconnected", "Reconnected on attempt (3/10)");

    expect(useChatStore.getState().chatStatus[id]).toBeUndefined();
  });
});

describe("a ladder that gives up", () => {
  it("persists the superseded partial when the restarted attempt produced nothing", async () => {
    useChatStore.getState().onStatus(id, "reconnect_restart", "Reconnecting… (4/10)");
    expect(useChatStore.getState().streaming[id]).toBe("");

    useChatStore.getState().onError(id, "stream stalled: connection lost", null);
    await Promise.resolve();

    expect(persistPartialChatMessage).toHaveBeenCalledWith(id, WATCHED);
    const s = useChatStore.getState();
    expect(s.stoppedPartial[id]).toBe(WATCHED);
    // The stash is spent once the turn has ended.
    expect(s.supersededPartial[id]).toBeUndefined();
  });

  it("prefers the restarted attempt's own text when it has some", async () => {
    useChatStore.getState().onStatus(id, "reconnect_restart", "Reconnecting… (4/10)");
    useChatStore.getState().onToken(id, "Second, complete answer");

    useChatStore.getState().onError(id, "stream stalled: connection lost", null);
    await Promise.resolve();

    expect(persistPartialChatMessage).toHaveBeenCalledWith(id, "Second, complete answer");
    expect(useChatStore.getState().supersededPartial[id]).toBeUndefined();
  });
});

describe("stream cleanup", () => {
  it("drops the stashed partial with the session's stream state", () => {
    const patch = clearStreamState(
      { ...useChatStore.getState(), supersededPartial: { [id]: WATCHED } },
      id,
    );
    expect(patch.supersededPartial).toEqual({});
  });
});
