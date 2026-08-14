// Regression tests for chat streaming-state lifecycle fixes (Round 2 audit):
//  - A3: cancelStream must clear the per-session streaming/chatStatus keys —
//    the backend's builtin cancel is handle.abort(), so NO terminal chat:done
//    / chat:error event ever arrives to clear them; the sidebar "working"
//    dot would stick forever.
//  - A4: deleting a chat (or all chats) mid-turn must cancel the backend
//    stream (builtin AND harness) — otherwise orphaned chat:token events
//    recreate state for a session whose rows no longer exist.
//  - C5: drainQueue uses the per-session streaming key, so a queued message
//    on session A still drains when A finishes even if session B is
//    streaming concurrently (B owns the shared streamingChatSessionId scalar).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  sendChatMessage: vi.fn(),
  sendAgentChatMessage: vi.fn(),
  cancelChatMessage: vi.fn().mockResolvedValue(undefined),
  cancelAgentChatMessage: vi.fn().mockResolvedValue(undefined),
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatSessions: vi.fn().mockResolvedValue([]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
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
  deleteAllChatSessions: vi.fn().mockResolvedValue(2),
  deleteChatMessage: vi.fn(),
  persistPartialChatMessage: vi.fn().mockResolvedValue(undefined),
  setChatApiKey: vi.fn(),
  deleteChatApiKey: vi.fn(),
  readArtifactPreview: vi.fn(),
}));

import { cancelChatMessage, cancelAgentChatMessage } from "../lib/ipc";
import { useChatStore } from "../state/chat";

function seed(sessions: { id: string; agent?: string }[]) {
  useChatStore.setState({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.id,
      provider: "openai",
      model: "m",
      createdAt: 0,
      lastActiveAt: 0,
      agent: s.agent,
    })) as never,
    messages: [],
    streaming: {},
    chatStatus: {},
    streamingChatSessionId: null,
    messageQueue: {},
    loopState: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed([]);
});

describe("A3: cancelStream clears per-session state", () => {
  it("deletes streaming + chatStatus keys for the cancelled session", async () => {
    seed([{ id: "s1" }]);
    useChatStore.setState({
      streaming: { s1: "partial reply" },
      chatStatus: { s1: { kind: "notice", message: "loading" } } as never,
      streamingChatSessionId: "s1",
    });

    await useChatStore.getState().cancelStream();

    const s = useChatStore.getState();
    expect(s.streamingChatSessionId).toBeNull();
    expect("s1" in s.streaming).toBe(false);
    expect("s1" in s.chatStatus).toBe(false);
  });
});

describe("A4: deleting a streaming chat cancels the backend stream", () => {
  it("cancels a builtin stream via cancelChatMessage", async () => {
    seed([{ id: "s1" }]);
    useChatStore.setState({
      streaming: { s1: "mid-turn" },
      streamingChatSessionId: "s1",
    });

    await useChatStore.getState().deleteChat("s1");

    expect(cancelChatMessage).toHaveBeenCalledWith("s1");
    expect("s1" in useChatStore.getState().streaming).toBe(false);
  });

  it("cancels a harness stream via cancelAgentChatMessage", async () => {
    seed([{ id: "s1", agent: "harness:claude_code" }]);
    useChatStore.setState({
      streaming: { s1: "mid-turn" },
      streamingChatSessionId: "s1",
    });

    await useChatStore.getState().deleteChat("s1");

    expect(cancelAgentChatMessage).toHaveBeenCalledWith("s1");
    expect(cancelChatMessage).not.toHaveBeenCalled();
  });

  it("deleteAllChats cancels every in-flight stream", async () => {
    seed([{ id: "s1" }, { id: "s2", agent: "harness:kimi_code" }]);
    useChatStore.setState({
      streaming: { s1: "a", s2: "b" },
      streamingChatSessionId: "s1",
    });

    await useChatStore.getState().deleteAllChats();

    expect(cancelChatMessage).toHaveBeenCalledWith("s1");
    expect(cancelAgentChatMessage).toHaveBeenCalledWith("s2");
    expect(Object.keys(useChatStore.getState().streaming)).toHaveLength(0);
  });
});

describe("C5: drainQueue is per-session", () => {
  it("does not strand A's queue while B streams concurrently", () => {
    seed([{ id: "a" }, { id: "b" }]);
    const send = vi.fn();
    // sendMessage is store-internal; spy via the store's own action slot.
    useChatStore.setState({
      activeChatSessionId: "a",
      messageQueue: {
        a: [{ id: 1, content: "next on A" } as never],
      },
      // B owns the shared scalar; A itself has NO streaming key anymore.
      streaming: { b: "…" },
      streamingChatSessionId: "b",
      sendMessage: send as never,
    });

    useChatStore.getState().drainQueue("a");

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("next on A");
  });

  it("keeps waiting when the session itself is still streaming", () => {
    seed([{ id: "a" }]);
    const send = vi.fn();
    useChatStore.setState({
      activeChatSessionId: "a",
      messageQueue: { a: [{ id: 1, content: "queued" } as never] },
      streaming: { a: "…" },
      streamingChatSessionId: "a",
      sendMessage: send as never,
    });

    useChatStore.getState().drainQueue("a");

    expect(send).not.toHaveBeenCalled();
  });
});
