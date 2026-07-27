// Regression test for the deleted-chat-still-showing bug: when you delete a
// chat and switch sessions, background session-list refreshes (which race
// the DELETE over IPC) used to resurrect the deleted chat in the sidebar.
// The store now tombstones deleted sessions for the rest of the app run so
// stale IPC payloads can't bring them back.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  listChatSessions: vi.fn().mockResolvedValue([]),
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn(),
  generateChatTitle: vi.fn(),
  getChatConfig: vi.fn(),
  sendChatMessage: vi.fn(),
  setChatApiKey: vi.fn(),
  deleteChatApiKey: vi.fn(),
  setChatSessionStarred: vi.fn(),
  setChatSessionUnread: vi.fn(),
  updateChatSessionModel: vi.fn(),
  updateChatSessionTitle: vi.fn(),
  updateChatSessionPermissionMode: vi.fn(),
  updateChatSessionWatchMode: vi.fn(),
  resolveToolAction: vi.fn(),
  cancelChatMessage: vi.fn(),
}));

import { listChatSessions, deleteChatSession } from "../lib/ipc";
import { useChatStore } from "../state/chat";

function seed(id: string) {
  useChatStore.setState({
    sessions: [
      { id, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never,
    ],
    activeChatSessionId: id,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    sessions: [],
    activeChatSessionId: null,
    streaming: {},
    streamingChatSessionId: null,
    pendingApprovals: {},
    fullAutoConfirmingFor: null,
  });
});

describe("deleteChat tombstone", () => {
  it("filters a stale listChatSessions payload that still contains the deleted id", async () => {
    const id = "sess-A";
    seed(id);
    await useChatStore.getState().deleteChat(id);

    // Simulate a background refresh whose IPC call started BEFORE the delete
    // committed — so it still returns the deleted session.
    vi.mocked(listChatSessions).mockResolvedValueOnce([
      { id, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never,
    ]);
    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().sessions.find((s) => s.id === id)).toBeUndefined();
    expect(deleteChatSession).toHaveBeenCalledWith(id);
  });

  it("ignores selectSession for a tombstoned chat (no message load)", async () => {
    const id = "sess-B";
    seed(id);
    await useChatStore.getState().deleteChat(id);

    // selectSession must bail before setting activeChatSessionId or loading
    // messages for a deleted session.
    await useChatStore.getState().selectSession(id);
    expect(useChatStore.getState().activeChatSessionId).toBeNull();
  });
});
