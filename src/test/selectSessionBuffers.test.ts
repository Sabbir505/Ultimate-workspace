// Audit 2026-09-14 #3/#4 regressions: selectSession's buffer write must
// (a) keep THIS session's still-optimistic rows instead of snapping back to a
// pre-persist snapshot — WITHOUT dragging the outgoing session's optimistic
// bubbles into the new transcript (mergeOptimistic, session-scoped), and
// (b) merge/prune checkpoint chips scoped to the opened session's message ids
// instead of replacing the whole map (which wiped the other pane's chips).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
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

import { getChatMessages, listChatCheckpoints } from "../lib/ipc";
import type { ChatMessageRecord, ChatCheckpoint } from "../lib/ipc";
import { useChatStore } from "../state/chat";

const row = (id: number, chatSessionId: string, role: "user" | "assistant", content: string): ChatMessageRecord => ({
  id,
  chatSessionId,
  role,
  content,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  createdAt: 1,
  startedAt: null,
  completedAt: null,
});

const chip = (id: number, messageId: number | null): ChatCheckpoint => ({
  id,
  chatSessionId: "s1",
  messageId,
  label: `cp-${id}`,
  createdAt: 1,
} as never);

function session(id: string) {
  return { id, title: id, provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (listChatCheckpoints as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  useChatStore.setState({
    sessions: [session("s0"), session("s1")],
    activeChatSessionId: "s0",
    messages: [],
    messagesSessionId: "s0",
    chatPaneTree: null,
    paneBuffers: {},
    streaming: {},
    chatStatus: {},
    messageQueue: {},
    checkpointsByMessage: {},
  } as never);
});

describe("selectSession message buffer (audit #3)", () => {
  it("keeps the opened session's in-flight optimistic row from a pre-persist snapshot", async () => {
    // The user re-opens s1 while s1's just-sent message is still optimistic;
    // the refetch snapshot predates the DB persist.
    (getChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      row(10, "s1", "user", "older"),
    ]);
    useChatStore.setState({
      activeChatSessionId: "s1",
      messages: [row(-1, "s1", "user", "just sent")],
      messagesSessionId: "s1",
    } as never);

    await useChatStore.getState().selectSession("s1");

    const msgs = useChatStore.getState().messages;
    expect(msgs.some((m) => m.id === 10)).toBe(true);
    expect(msgs.some((m) => m.id === -1)).toBe(true);
  });

  it("does not drag the OUTGOING session's optimistic bubbles into the new transcript", async () => {
    (getChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      row(10, "s1", "user", "s1 history"),
    ]);
    // Viewing s0 with an in-flight optimistic send; now clicking s1.
    useChatStore.setState({
      activeChatSessionId: "s0",
      messages: [row(-2, "s0", "user", "s0 in flight")],
      messagesSessionId: "s0",
    } as never);

    await useChatStore.getState().selectSession("s1");

    const msgs = useChatStore.getState().messages;
    expect(msgs.some((m) => m.id === 10)).toBe(true);
    expect(msgs.some((m) => m.chatSessionId === "s0")).toBe(false);
  });
});

describe("selectSession checkpoint chips (audit #4)", () => {
  it("merges the opened session's chips without wiping OTHER sessions' chips", async () => {
    (getChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      row(10, "s1", "assistant", "work"),
    ]);
    (listChatCheckpoints as ReturnType<typeof vi.fn>).mockResolvedValue([
      chip(1, 10),
    ]);
    // A chip belonging to another session's message must survive the open.
    useChatStore.setState({ checkpointsByMessage: { 999: [chip(7, 999)] } } as never);

    await useChatStore.getState().selectSession("s1");

    const byMessage = useChatStore.getState().checkpointsByMessage;
    expect(byMessage[10]?.map((c) => c.id)).toEqual([1]);
    expect(byMessage[999]?.map((c) => c.id)).toEqual([7]);
  });

  it("replaces stale chips for this session's reloaded message ids", async () => {
    (getChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      row(10, "s1", "assistant", "work"),
    ]);
    (listChatCheckpoints as ReturnType<typeof vi.fn>).mockResolvedValue([
      chip(2, 10),
    ]);
    useChatStore.setState({ checkpointsByMessage: { 10: [chip(1, 10)] } } as never);

    await useChatStore.getState().selectSession("s1");

    const byMessage = useChatStore.getState().checkpointsByMessage;
    expect(byMessage[10]?.map((c) => c.id)).toEqual([2]);
  });
});
