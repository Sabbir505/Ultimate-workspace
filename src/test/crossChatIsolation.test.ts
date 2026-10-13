// Cross-chat isolation (2026-10-10): work from one chat must never show up in
// another. Three guards are covered here:
//
// 1. Buffer ownership on a chat switch: `selectSession` flips the active id
//    synchronously but replaces the transcript only after its three IPC reads
//    land. Before this round a FAILED read left activeChatSessionId = the new
//    chat while `messages` still held the outgoing chat's rows — ChatView
//    rendered that other conversation (artifact chips and turn-changes rows
//    included) until some later load happened to succeed. The fetch now
//    claims the buffer for the target session and empties it; ChatView's
//    guard renders "Opening chat…" instead.
// 2. `appendUserBubble` / `loadMessages` must not graft the outgoing chat's
//    optimistic rows onto the incoming chat's transcript.
// 3. Auto-opened artifact tabs are tagged with their chat and swept when the
//    active chat changes (the shared tool panel used to keep showing the
//    previous chat's file under the new chat).
import { beforeEach, describe, expect, it, vi } from "vitest";

const getChatMessagesMock = vi.fn();
const listChatArtifactsMock = vi.fn();
const listChatCheckpointsMock = vi.fn();
const listChatSessionsMock = vi.fn();
const touchChatSessionMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  getChatMessages: (...a: unknown[]) => getChatMessagesMock(...a),
  listChatArtifacts: (...a: unknown[]) => listChatArtifactsMock(...a),
  listChatCheckpoints: (...a: unknown[]) => listChatCheckpointsMock(...a),
  listChatSessions: (...a: unknown[]) => listChatSessionsMock(...a),
  touchChatSession: (...a: unknown[]) => touchChatSessionMock(...a),
  setChatSessionUnread: vi.fn().mockResolvedValue(undefined),
  toastError: (...a: unknown[]) => toastErrorMock(...a),
  // The store imports further members at module load; stub the rest so the
  // module evaluates without a Tauri runtime.
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn(),
  getChatConfig: vi.fn(),
  getChatSessionMetrics: vi.fn().mockResolvedValue(null),
  persistPartialChatMessage: vi.fn(),
  setChatSessionProject: vi.fn(),
  setChatSessionCwd: vi.fn(),
  deleteAllChatSessions: vi.fn(),
  setChatSessionStarred: vi.fn(),
  updateChatSessionAgent: vi.fn(),
  updateChatSessionModel: vi.fn(),
  updateChatSessionProvider: vi.fn(),
  updateChatSessionPolicies: vi.fn(),
  updateChatSessionTitle: vi.fn(),
  updateChatSessionWatchMode: vi.fn(),
  setChatSessionWorktree: vi.fn(),
  cancelAgentChatMessage: vi.fn(),
  cancelChatMessage: vi.fn(),
  safeListen: vi.fn(() => Promise.resolve(() => {})),
}));

import { useChatStore } from "../state/chat";
import { appendUserBubble } from "../state/chat/moduleState";
import { useUiStore } from "../state/ui";
import type { ChatMessageRecord, ChatSession } from "../lib/ipc";

const session = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    title: `chat ${id}`,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    createdAt: 1,
    lastActiveAt: 2,
    ...over,
  }) as ChatSession;

const row = (
  id: number,
  chatSessionId: string,
  content: string,
): ChatMessageRecord =>
  ({
    id,
    chatSessionId,
    role: "user",
    content,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt: 0,
    startedAt: null,
    completedAt: null,
  }) as ChatMessageRecord;

beforeEach(() => {
  vi.clearAllMocks();
  getChatMessagesMock.mockResolvedValue([]);
  listChatArtifactsMock.mockResolvedValue([]);
  listChatCheckpointsMock.mockResolvedValue([]);
  listChatSessionsMock.mockResolvedValue([]);
  touchChatSessionMock.mockResolvedValue(undefined);
  useChatStore.setState({
    sessions: [session("a"), session("b")],
    activeChatSessionId: "a",
    messages: [],
    messagesSessionId: null,
    chatPaneTree: null,
    focusedPaneId: null,
    focusedChatSessionId: null,
    paneBuffers: {},
    rememberedChatPaneState: null,
    streaming: {},
    chatStatus: {},
    error: null,
    errorCode: null,
  });
  useUiStore.setState({
    openTabs: [],
    nextTabId: 1,
    activeTabId: null,
    toolPanelTab: "terminal",
    toolPanelCollapsed: true,
    diffPanelFile: null,
    diffPanelCwd: null,
  });
});

describe("chat-switch buffer ownership", () => {
  it("claims the buffer for the target chat when the page fetch fails", async () => {
    useChatStore.setState({
      messages: [row(1, "a", "hello from chat a")],
      messagesSessionId: "a",
    });
    getChatMessagesMock.mockRejectedValueOnce(new Error("database is locked"));

    await useChatStore.getState().selectSession("b");

    const s = useChatStore.getState();
    expect(s.activeChatSessionId).toBe("b");
    // The outgoing chat's rows are gone AND the buffer is re-labelled, so
    // nothing downstream can render chat A under chat B's header.
    expect(s.messages).toEqual([]);
    expect(s.messagesSessionId).toBe("b");
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Couldn't open this chat",
      expect.any(Error),
    );
  });

  it("replaces the transcript with the target chat's page on success", async () => {
    useChatStore.setState({
      messages: [row(1, "a", "hello from chat a")],
      messagesSessionId: "a",
    });
    getChatMessagesMock.mockResolvedValueOnce([row(7, "b", "chat b history")]);

    await useChatStore.getState().selectSession("b");

    const s = useChatStore.getState();
    expect(s.activeChatSessionId).toBe("b");
    expect(s.messagesSessionId).toBe("b");
    expect(s.messages.map((m) => m.content)).toEqual(["chat b history"]);
  });

  it("loadMessages does not graft the outgoing chat's optimistic bubble", async () => {
    // Chat A has an in-flight (optimistic, negative-id) user bubble while the
    // user switches to B — B's page load must not carry it over.
    useChatStore.setState({
      activeChatSessionId: "b",
      messages: [row(-3, "a", "queued in chat a")],
      messagesSessionId: "a",
    });
    getChatMessagesMock.mockResolvedValueOnce([row(9, "b", "chat b history")]);

    await useChatStore.getState().loadMessages("b");

    const s = useChatStore.getState();
    expect(s.messages.map((m) => m.id)).toEqual([9]);
    expect(s.messagesSessionId).toBe("b");
  });

  it("appendUserBubble refuses to append onto another chat's buffer", () => {
    useChatStore.setState({
      activeChatSessionId: "b",
      messages: [row(1, "a", "hello from chat a")],
      messagesSessionId: "a",
    });
    const patch = appendUserBubble(
      useChatStore.getState(),
      "b",
      row(-1, "b", "just sent in chat b"),
    );
    expect(patch).toEqual({});
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual([1]);
  });
});

describe("auto-opened artifact tabs are scoped to their chat", () => {
  it("sweeps foreign auto tabs on a chat switch but keeps user-opened tabs", async () => {
    const ui = useUiStore.getState();
    // Tab auto-opened for chat A (a turn produced a viewable file).
    ui.openArtifactTab(
      { path: "C:/out/shot-a.png", filename: "shot-a.png" },
      { auto: true, chatSessionId: "a" },
    );
    const autoTab = useUiStore.getState().openTabs[0];
    // Tab the user opened deliberately from chat A.
    ui.openArtifactTab({ path: "C:/out/read-me.md", filename: "read-me.md" });
    const manualTab = useUiStore.getState().openTabs[1];

    await useChatStore.getState().selectSession("b");

    const tabs = useUiStore.getState().openTabs;
    expect(tabs.map((t) => t.instanceId)).toEqual([manualTab.instanceId]);
    expect(tabs.map((t) => t.instanceId)).not.toContain(autoTab.instanceId);
  });

  it("keeps the producing chat's auto tab when switching back to it", async () => {
    useUiStore
      .getState()
      .openArtifactTab(
        { path: "C:/out/shot-a.png", filename: "shot-a.png" },
        { auto: true, chatSessionId: "a" },
      );
    await useChatStore.getState().selectSession("a");
    expect(useUiStore.getState().openTabs).toHaveLength(1);
  });

  it("adopts an auto tab when the user re-opens it manually", async () => {
    const ui = useUiStore.getState();
    ui.openArtifactTab(
      { path: "C:/out/shot-a.png", filename: "shot-a.png" },
      { auto: true, chatSessionId: "a" },
    );
    // The user clicks the same artifact in the gallery — that is a deliberate
    // open, so the tab stops being swept on later switches.
    ui.openArtifactTab({ path: "C:/out/shot-a.png", filename: "shot-a.png" });

    await useChatStore.getState().selectSession("b");
    expect(useUiStore.getState().openTabs).toHaveLength(1);
  });
});
