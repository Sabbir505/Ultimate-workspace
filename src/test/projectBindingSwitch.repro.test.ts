// Repro for "selecting through projects crashes the app": exercises the
// per-chat project binding (sessionProjects), the projects→chat subscriber,
// and selectSession's project-restore sync with the REAL stores, counting
// state updates to catch a runaway loop (renderer freeze / white screen).
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
  updateChatSessionWatchMode: vi.fn(),
  cancelChatMessage: vi.fn(),
}));

import { useChatStore } from "../state/chat";
import { useProjectsStore } from "../state/projects";

function seedChat(id: string) {
  useChatStore.setState({
    sessions: [
      { id, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never,
    ],
    activeChatSessionId: id,
    // Non-empty so selectSession's "delete the outgoing empty chat" cleanup
    // doesn't tombstone the chat we're switching away from.
    messages: [{ id: 1, chatSessionId: id, role: "user", content: "hi" } as never],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    sessions: [],
    activeChatSessionId: null,
    messages: [],
    streaming: {},
    streamingChatSessionId: null,
    sessionProjects: {},
    cwdOverrides: {},
  });
  useProjectsStore.setState({
    projects: [
      { id: "pA", name: "A", path: "D:/a" } as never,
      { id: "pB", name: "B", path: "D:/b" } as never,
    ],
    selectedProjectId: null,
  });
});

describe("project switching with per-chat bindings", () => {
  it("rapid project clicks + chat switches settle without an update storm", async () => {
    let chatSets = 0;
    let projectSets = 0;
    const unsub1 = useChatStore.subscribe(() => {
      chatSets += 1;
      if (chatSets > 200) throw new Error("chat store update storm");
    });
    const unsub2 = useProjectsStore.subscribe(() => {
      projectSets += 1;
      if (projectSets > 200) throw new Error("projects store update storm");
    });

    seedChat("chat-1");
    const projects = useProjectsStore.getState();

    // Click through projects repeatedly (Sidebar handleProjectClick's
    // selectProject half) — each click should rebind the active chat once.
    for (let i = 0; i < 10; i++) {
      projects.selectProject(i % 2 === 0 ? "pA" : "pB");
    }
    expect(useChatStore.getState().sessionProjects["chat-1"]).toBe("pB");

    // Bind a second chat to pA, then switch between the two chats —
    // selectSession's sync moves the global selection each time.
    useChatStore.setState((s) => ({
      sessionProjects: { ...s.sessionProjects, "chat-2": "pA" },
    }));
    seedChat("chat-1"); // active chat-1 (bound pB)
    for (let i = 0; i < 6; i++) {
      await useChatStore.getState().selectSession(i % 2 === 0 ? "chat-2" : "chat-1");
    }

    // Final state is coherent: active chat-1, global selection follows it.
    expect(useChatStore.getState().activeChatSessionId).toBe("chat-1");
    expect(useProjectsStore.getState().selectedProjectId).toBe("pB");
    expect(chatSets).toBeLessThan(200);
    expect(projectSets).toBeLessThan(200);
    unsub1();
    unsub2();
  });
});
