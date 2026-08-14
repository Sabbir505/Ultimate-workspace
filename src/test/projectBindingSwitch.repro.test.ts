// Tests the per-chat project binding (sessionProjects) and selectSession's
// project-restore sync, using the REAL stores. Two invariants:
//   1. Browsing a project (selectProject) must NOT rebind the active chat
//      to it — a chat's binding changes only via explicit actions (newChat
//      with a projectId, "New chat for project", or unbindProject).
//   2. Opening a chat pushes its binding into the global selection
//      (binding → selection), so switching between two bound chats moves
//      the sidebar highlight. State-update counts guard against runaway
//      loops (renderer freeze / white screen).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  listChatSessions: vi.fn().mockResolvedValue([]),
  // Non-empty so selectSession's "delete the outgoing empty chat" cleanup
  // doesn't tombstone the chat we're switching away from mid-test.
  getChatMessages: vi.fn().mockResolvedValue([
    { id: 1, chatSessionId: "x", role: "user", content: "hi" },
  ]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  // selectSession → loadSessionMetrics fetches these on every chat open.
  getChatSessionMetrics: vi.fn().mockResolvedValue(null),
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
  it("browsing a project does NOT rebind the active chat to it", async () => {
    // An independent chat (no project binding) is active.
    seedChat("chat-1");
    const projects = useProjectsStore.getState();

    // User browses projects repeatedly in the sidebar / command palette.
    // This must only change selectedProjectId, never sessionProjects.
    for (let i = 0; i < 10; i++) {
      projects.selectProject(i % 2 === 0 ? "pA" : "pB");
    }

    // The active chat's binding is unchanged — still unbound.
    expect(useChatStore.getState().sessionProjects["chat-1"]).toBeUndefined();
    // Global selection does follow the last browse (that's the browse UX).
    expect(useProjectsStore.getState().selectedProjectId).toBe("pB");

    // Even a chat that is ALREADY bound to pA must not jump to pB when the
    // user browses pB.
    useChatStore.setState((s) => ({
      sessionProjects: { ...s.sessionProjects, "chat-1": "pA" },
    }));
    projects.selectProject("pB");
    expect(useChatStore.getState().sessionProjects["chat-1"]).toBe("pA");
  });

  it("opening a chat syncs the global selection to its binding (no storm)", async () => {
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

    // Two chats, each explicitly bound to a project.
    useChatStore.setState({
      sessions: [
        { id: "chat-1", title: "t1", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0, projectId: "pB" } as never,
        { id: "chat-2", title: "t2", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0, projectId: "pA" } as never,
      ],
      activeChatSessionId: "chat-1",
      messages: [{ id: 1, chatSessionId: "chat-1", role: "user", content: "hi" } as never],
      sessionProjects: { "chat-1": "pB", "chat-2": "pA" },
    });

    // Switch between the two chats — selectSession's sync moves the global
    // selection to the opened chat's binding each time.
    for (let i = 0; i < 6; i++) {
      await useChatStore.getState().selectSession(i % 2 === 0 ? "chat-2" : "chat-1");
    }

    // Final state is coherent: active chat-1, global selection follows it.
    expect(useChatStore.getState().activeChatSessionId).toBe("chat-1");
    expect(useProjectsStore.getState().selectedProjectId).toBe("pB");
    // No chat's binding was altered by switching.
    expect(useChatStore.getState().sessionProjects).toEqual({ "chat-1": "pB", "chat-2": "pA" });
    expect(chatSets).toBeLessThan(200);
    expect(projectSets).toBeLessThan(200);
    unsub1();
    unsub2();
  });
});
