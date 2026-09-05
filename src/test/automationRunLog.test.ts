// Regression tests for automation run-log UX:
//   1. "Open run log" must actually swap to the chat view. selectSession's
//      recordChatNav rewrites the top view-history entry to {view:"chat"}
//      while the user is still on Automations, and setActiveView's old
//      top-based guard treated that as "already there" — the click switched
//      chats but the app stayed on the Automations view.
//   2. A backend-initiated run must stream into the chat: beginRemoteTurn
//      pre-creates the streaming entry (onToken drops tokens otherwise),
//      endRemoteTurn clears it and refetches the persisted reply (provider
//      one-shots never emit chat:done).
import { beforeEach, describe, expect, it, vi } from "vitest";

const listChatSessionsMock = vi.fn();
const getChatMessagesMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  listChatSessions: (...a: unknown[]) => listChatSessionsMock(...a),
  getChatMessages: (...a: unknown[]) => getChatMessagesMock(...a),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  listChatCheckpoints: vi.fn().mockResolvedValue([]),
  getChatSessionMetrics: vi.fn().mockResolvedValue(null),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  setChatSessionUnread: vi.fn().mockResolvedValue(undefined),
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
}));

import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";

const RUN_SESSION = {
  id: "run-log-1",
  title: "⚙ nightly",
  provider: "claude_code",
  model: "",
  createdAt: 0,
  lastActiveAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  listChatSessionsMock.mockResolvedValue([RUN_SESSION]);
  getChatMessagesMock.mockResolvedValue([
    { id: 1, chatSessionId: "run-log-1", role: "user", content: "automation prompt" },
  ]);
  useChatStore.setState({
    sessions: [],
    activeChatSessionId: null,
    messages: [],
    messagesSessionId: null,
    streaming: {},
    streamingChatSessionId: null,
    sessionProjects: {},
  });
  // Mirror the app: boot on the chat view, then navigate to Automations
  // through the real action so viewHistory matches production shape.
  useUiStore.setState({
    activeView: "chat",
    viewHistory: [{ view: "chat", chatSessionId: null }],
    viewIndex: 0,
  });
  useUiStore.getState().setActiveView("automations");
});

describe("open run log from the Automations view", () => {
  it("swaps to the chat view and shows the run-log session", async () => {
    await useChatStore.getState().loadSessions();
    await useChatStore.getState().selectSession("run-log-1");
    useUiStore.getState().setActiveView("chat");

    expect(useChatStore.getState().activeChatSessionId).toBe("run-log-1");
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useUiStore.getState().activeView).toBe("chat");
  });
});

describe("backend-initiated run streaming", () => {
  it("beginRemoteTurn lets run tokens through the straggler guard", () => {
    useChatStore.getState().beginRemoteTurn("run-log-1");
    expect(useChatStore.getState().streaming["run-log-1"]).toBe("");

    // chat:token from the run — must NOT be dropped (pre-fix it returned
    // early because sendMessage never pre-created this entry).
    useChatStore.getState().onToken("run-log-1", "hello ");
    useChatStore.getState().onToken("run-log-1", "world");
    expect(useChatStore.getState().streaming["run-log-1"]).toBe("hello world");

    // An entry that already exists (user send) is never clobbered.
    useChatStore.setState({ streaming: { other: "keep" } });
    useChatStore.getState().beginRemoteTurn("other");
    expect(useChatStore.getState().streaming["other"]).toBe("keep");
  });

  it("endRemoteTurn clears the entry and refetches for an active viewer", async () => {
    await useChatStore.getState().loadSessions();
    await useChatStore.getState().selectSession("run-log-1");
    useChatStore.getState().beginRemoteTurn("run-log-1");

    // Provider one-shot: the finished reply only exists in the DB.
    getChatMessagesMock.mockResolvedValue([
      { id: 1, chatSessionId: "run-log-1", role: "user", content: "automation prompt" },
      { id: 2, chatSessionId: "run-log-1", role: "assistant", content: "run output" },
    ]);

    await useChatStore.getState().endRemoteTurn("run-log-1");

    expect(useChatStore.getState().streaming["run-log-1"]).toBeUndefined();
    const messages = useChatStore.getState().messages;
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.content).toBe("run output");
  });

  it("endRemoteTurn marks a background session unread without refetch churn", async () => {
    useChatStore.getState().beginRemoteTurn("run-log-1");
    // No active session — the refetch path must be skipped entirely.
    await useChatStore.getState().endRemoteTurn("run-log-1");
    expect(getChatMessagesMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().streaming["run-log-1"]).toBeUndefined();
  });
});
