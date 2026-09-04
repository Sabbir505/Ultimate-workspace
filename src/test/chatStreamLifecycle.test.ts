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
  // Self-improving artifacts telemetry (P0) — loop persistence + turn runs.
  loopSessionStart: vi.fn().mockResolvedValue(null),
  loopSessionAdvance: vi.fn().mockResolvedValue(undefined),
  loopSessionFinish: vi.fn().mockResolvedValue(undefined),
  finishArtifactRuns: vi.fn().mockResolvedValue(0),
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
  deleteAllChatSessions: vi.fn().mockResolvedValue(2),
  deleteChatMessage: vi.fn(),
  persistPartialChatMessage: vi.fn().mockResolvedValue(undefined),
  setChatApiKey: vi.fn(),
  deleteChatApiKey: vi.fn(),
  readArtifactPreview: vi.fn(),
}));

import { cancelChatMessage, cancelAgentChatMessage } from "../lib/ipc";
import { useChatStore } from "../state/chat";

// C5 spies replace the store's sendMessage via setState; capture the real
// action so seed() can restore it for later suites (H2).
const realSendMessage = useChatStore.getState().sendMessage;

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
    sendMessage: realSendMessage as never,
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
      activeChatSessionId: "s1",
      streaming: { s1: "partial reply" },
      chatStatus: { s1: { kind: "notice", message: "loading" } } as never,
      streamingChatSessionId: "s1",
    });

    // Stop acts on the session the user is VIEWING (audit M1) — s1 is
    // active, so it is the one cancelled and cleared.
    await useChatStore.getState().cancelStream();

    const s = useChatStore.getState();
    expect(s.streamingChatSessionId).toBeNull();
    expect("s1" in s.streaming).toBe(false);
    expect("s1" in s.chatStatus).toBe(false);
  });

  it("M1: with two concurrent streams, Stop cancels the ACTIVE session only", async () => {
    seed([{ id: "a" }, { id: "b" }]);
    useChatStore.setState({
      activeChatSessionId: "b",
      // Legacy scalar points at the background session — exactly the case
      // that used to cancel the wrong turn.
      streaming: { a: "bg turn", b: "viewed turn" },
      streamingChatSessionId: "a",
    });

    await useChatStore.getState().cancelStream();

    const s = useChatStore.getState();
    expect("b" in s.streaming).toBe(false); // viewed session cancelled
    expect("a" in s.streaming).toBe(true); // background stream untouched
    expect(cancelChatMessage).toHaveBeenCalledWith("b");
    expect(cancelChatMessage).not.toHaveBeenCalledWith("a");
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

describe("H2: sendMessage double-send guard is per-session", () => {
  it("queues when the ACTIVE session streams, even though the scalar names another", async () => {
    seed([{ id: "a" }, { id: "b" }]);
    useChatStore.setState({
      activeChatSessionId: "a",
      // Both stream concurrently; the legacy scalar last flipped to B.
      streaming: { a: "turn in flight", b: "background turn" },
      streamingChatSessionId: "b",
    });

    await useChatStore.getState().sendMessage("second message while a streams");

    // Must NOT have started a second turn in A — the message is queued.
    const state = useChatStore.getState();
    expect((state.messageQueue.a ?? []).length).toBe(1);
    expect(state.messageQueue.a?.[0]?.content).toBe("second message while a streams");
    // sendChatMessage is only called when a turn actually starts — A already
    // streams and B is background, so no new send may fire.
    const { sendChatMessage } = await import("../lib/ipc");
    expect(sendChatMessage).not.toHaveBeenCalled();
  });
});

describe("H1: rapid session switch must not delete a chat with history", () => {
  it("does not treat the outgoing chat as empty when the buffer belongs to another session", async () => {
    seed([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const { getChatMessages, deleteChatSession } = await import("../lib/ipc");
    // B HAS history on disk…
    (getChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, chatSessionId: "b", role: "user", content: "hi" },
    ]);
    // …and the user already clicked into B (active=B), but B's fetch hasn't
    // committed — the buffer still shows A's empty page. Clicking C now makes
    // B the OUTGOING session; the old code read the bare empty buffer and
    // deleted B's whole history.
    useChatStore.setState({
      activeChatSessionId: "b",
      messages: [],
      messagesSessionId: "a",
    });

    await useChatStore.getState().selectSession("c");

    expect(deleteChatSession).not.toHaveBeenCalledWith("b");
  });
});
