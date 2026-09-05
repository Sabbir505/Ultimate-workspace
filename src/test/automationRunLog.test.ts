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
const deleteChatSessionMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  listChatSessions: (...a: unknown[]) => listChatSessionsMock(...a),
  getChatMessages: (...a: unknown[]) => getChatMessagesMock(...a),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  listChatCheckpoints: vi.fn().mockResolvedValue([]),
  getChatSessionMetrics: vi.fn().mockResolvedValue(null),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  setChatSessionUnread: vi.fn().mockResolvedValue(undefined),
  deleteChatSession: (...a: unknown[]) => deleteChatSessionMock(...a),
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
const RUN_SESSION_B = {
  id: "run-log-2",
  title: "⚙ weekly",
  provider: "claude_code",
  model: "",
  createdAt: 0,
  lastActiveAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  listChatSessionsMock.mockResolvedValue([RUN_SESSION, RUN_SESSION_B]);
  // run-log-2 is the "empty run log" fixture; scratch-chat the "empty
  // builtin chat" one — neither has messages written yet.
  getChatMessagesMock.mockImplementation((id: string) =>
    Promise.resolve(
      id === "run-log-2" || id === "scratch-chat"
        ? []
        : [{ id: 1, chatSessionId: id, role: "user", content: `prompt for ${id}` }],
    ),
  );
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

  it("opening a SECOND automation's log switches to that session", async () => {
    await useChatStore.getState().loadSessions();

    // First open: automations → chat A.
    await useChatStore.getState().selectSession("run-log-1");
    useUiStore.getState().setActiveView("chat");
    expect(useChatStore.getState().activeChatSessionId).toBe("run-log-1");

    // Back to the Automations view, open the other automation's log.
    useUiStore.getState().setActiveView("automations");
    await useChatStore.getState().selectSession("run-log-2");
    useUiStore.getState().setActiveView("chat");

    expect(useChatStore.getState().activeChatSessionId).toBe("run-log-2");
    // run-log-2's run hasn't written yet — an empty page is expected.
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().messagesSessionId).toBe("run-log-2");
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

describe("empty run-log chats survive switch-away", () => {
  it("an empty harness session is not deleted on leave, so gallery/open clicks keep working", async () => {
    // Run-log chats are agent-tagged and often still empty when first opened.
    const emptyRunLog = { ...RUN_SESSION_B, agent: "harness:claude_code" };
    listChatSessionsMock.mockResolvedValue([RUN_SESSION, emptyRunLog]);
    await useChatStore.getState().loadSessions();

    // Open the empty run log, then switch away to the other chat.
    await useChatStore.getState().selectSession("run-log-2");
    await useChatStore.getState().selectSession("run-log-1");
    // Flush microtasks so the fire-and-forget empty-outgoing cleanup (a
    // void deleteChat) would have landed here if it were still firing.
    await new Promise((r) => setTimeout(r, 0));

    // Pre-fix, the empty-outgoing cleanup deleteChat()ed run-log-2 and
    // tombstoned it — this second open silently no-op'ed and the chat
    // view kept showing run-log-1 (the artifact-gallery bug report).
    await useChatStore.getState().selectSession("run-log-2");
    expect(useChatStore.getState().activeChatSessionId).toBe("run-log-2");
    expect(
      useChatStore.getState().sessions.some((s) => s.id === "run-log-2"),
    ).toBe(true);
  });

  it("an empty builtin chat is still cleaned up on switch-away", async () => {
    const emptyBuiltin = {
      id: "scratch-chat",
      title: null,
      provider: "openai",
      model: "gpt",
      createdAt: 0,
      lastActiveAt: 0,
    };
    listChatSessionsMock.mockResolvedValue([RUN_SESSION, emptyBuiltin]);
    await useChatStore.getState().loadSessions();

    await useChatStore.getState().selectSession("scratch-chat");
    await useChatStore.getState().selectSession("run-log-1");
    await new Promise((r) => setTimeout(r, 0));

    // Original purpose preserved: no empty builtin row left behind.
    expect(deleteChatSessionMock).toHaveBeenCalledWith("scratch-chat");
    expect(
      useChatStore.getState().sessions.some((s) => s.id === "scratch-chat"),
    ).toBe(false);
  });
});
