// Regression test: a queued message's user bubble must survive the queue
// drain. When the older turn finishes, onDone refetches messages from the DB
// (a snapshot taken BEFORE the queued message was persisted) and then
// drainQueue sends the queued message with an optimistic bubble. Any reload
// that lands after that append with stale rows wipes the bubble — the user
// sees the assistant reply to a message that never appeared.
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

describe("queue stack actions (steer / edit / move / delete)", () => {
  it("steer interrupts the running turn and sends the picked message NOW", async () => {
    let resolveSend: () => void = () => {};
    (sendChatMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => { resolveSend = r as () => void; }),
    );
    void useChatStore.getState().sendMessage("running turn");
    await Promise.resolve();
    await Promise.resolve();
    expect(useChatStore.getState().streaming.s1).toBeDefined();

    // Stack two follow-ups while the turn streams.
    await useChatStore.getState().sendMessage("first queued");
    await useChatStore.getState().sendMessage("second queued");
    const queue = useChatStore.getState().messageQueue.s1;
    expect(queue).toHaveLength(2);

    // STEER the SECOND one: it must jump the stack, the running turn must be
    // cancelled (streaming cleared), and the first must stay queued.
    (sendChatMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const steeredId = queue[1].id;
    await useChatStore.getState().steerQueuedMessage("s1", steeredId);
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();

    const after = useChatStore.getState();
    // The interrupted turn ended AND the steered message opened a NEW stream.
    expect(after.streaming.s1).toBeDefined();
    expect(after.messages.some((m) => m.role === "assistant" && m.content === "running turn")).toBe(false);
    // The steered message left the queue; the other one is still stacked.
    expect(after.messageQueue.s1.map((m) => m.content)).toEqual(["first queued"]);
    // The steered message was SENT (not re-queued).
    expect(after.messages.some((m) => m.role === "user" && m.content === "second queued")).toBe(true);
  });

  it("steer without a running turn just sends immediately", async () => {
    (sendChatMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    useChatStore.setState({
      messageQueue: {
        s1: [
          { id: 11, content: "solo" },
          { id: 12, content: "stays" },
        ],
      },
    } as never);
    await useChatStore.getState().steerQueuedMessage("s1", 11);
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    const after = useChatStore.getState();
    expect(after.messageQueue.s1.map((m) => m.content)).toEqual(["stays"]);
    expect(after.messages.some((m) => m.content === "solo")).toBe(true);
  });

  it("edit rewrites a queued message's text in place", () => {
    useChatStore.setState({
      messageQueue: { s1: [{ id: 21, content: "before" }] },
    } as never);
    useChatStore.getState().editQueuedMessage("s1", 21, "after");
    expect(useChatStore.getState().messageQueue.s1[0].content).toBe("after");
  });

  it("move reorders the stack and tolerates out-of-range indices", () => {
    useChatStore.setState({
      messageQueue: {
        s1: [
          { id: 1, content: "a" },
          { id: 2, content: "b" },
          { id: 3, content: "c" },
        ],
      },
    } as never);
    useChatStore.getState().moveQueuedMessage("s1", 0, 2);
    expect(useChatStore.getState().messageQueue.s1.map((m) => m.content)).toEqual(["b", "c", "a"]);
    // Out-of-range / same-index moves are no-ops.
    useChatStore.getState().moveQueuedMessage("s1", 5, 0);
    useChatStore.getState().moveQueuedMessage("s1", 1, 1);
    expect(useChatStore.getState().messageQueue.s1.map((m) => m.content)).toEqual(["b", "c", "a"]);
  });
});
