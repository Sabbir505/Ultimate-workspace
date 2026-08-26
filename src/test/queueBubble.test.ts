// Regression test: a queued message's user bubble must survive the queue
// drain. When the older turn finishes, onDone refetches messages from the DB
// (a snapshot taken BEFORE the queued message was persisted) and then
// drainQueue sends the queued message with an optimistic bubble. Any reload
// that lands after that append with stale rows wipes the bubble — the user
// sees the assistant reply to a message that never appeared.
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

import { getChatMessages, sendChatMessage } from "../lib/ipc";
import { useChatStore } from "../state/chat";

const realSendMessage = useChatStore.getState().sendMessage;

function seed() {
  useChatStore.setState({
    sessions: [
      {
        id: "s1",
        title: "s1",
        provider: "local_gguf",
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
    messageQueue: {},
    loopState: {},
    sendMessage: realSendMessage as never,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("queued message bubble", () => {
  it("survives onDone's refetch + queue drain", async () => {
    // Hold the first send in flight (simulates a streaming turn).
    let resolveSend: () => void = () => {};
    (sendChatMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveSend = r as () => void; }),
    );
    void useChatStore.getState().sendMessage("first");
    await Promise.resolve();
    await Promise.resolve();
    expect(useChatStore.getState().streaming.s1).toBeDefined();

    // Queue a second message while the turn streams.
    await useChatStore.getState().sendMessage("queued");
    expect(useChatStore.getState().messageQueue.s1).toHaveLength(1);
    // The queued message must NOT show a bubble yet.
    expect(useChatStore.getState().messages.some((m) => m.content === "queued")).toBe(false);

    // First turn completes: onDone refetches (mock returns [] — a snapshot
    // without the queued message), then drains the queue.
    (sendChatMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    resolveSend();
    await useChatStore.getState().onDone("s1", 1, 1, 0, null, null, null, null, null);
    // Flush microtasks + the drainQueue send chain.
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    await Promise.resolve();

    const msgs = useChatStore.getState().messages;
    expect(
      msgs.some((m) => m.role === "user" && m.content === "queued"),
    ).toBe(true);
  });

  it("cancel-path refetch (snapshot predating the persist) keeps the drained bubble", async () => {
    // Turn 1 streams; a message is queued; the user hits Stop.
    let resolveSend: () => void = () => {};
    (sendChatMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveSend = r as () => void; }),
    );
    void useChatStore.getState().sendMessage("first");
    await Promise.resolve();
    await Promise.resolve();
    await useChatStore.getState().sendMessage("queued");

    // Stop: cancelStream drains the queue (optimistic bubble appended) and
    // THEN refetches — the snapshot below predates the queued send's persist,
    // which is exactly the shape that used to wipe the bubble.
    (sendChatMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (getChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 1,
        chatSessionId: "s1",
        role: "user",
        content: "first",
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        createdAt: 1,
        startedAt: null,
        completedAt: null,
      },
    ]);
    void useChatStore.getState().cancelStream();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    await Promise.resolve();

    const msgs = useChatStore.getState().messages;
    expect(msgs.some((m) => m.role === "user" && m.content === "queued")).toBe(true);
    // The persisted "first" row is intact too (no duplication).
    expect(msgs.filter((m) => m.content === "first")).toHaveLength(1);
  });
});
