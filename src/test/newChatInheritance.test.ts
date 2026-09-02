// newChat's project/folder inheritance (create path): starting a chat
// WITHOUT an explicit projectId adopts the previously ACTIVE chat's project
// binding — and stays independent when that chat has none — so "New Chat"
// keeps working in the same project/folder context. An explicit projectId
// (project-row "+") still wins. The empty-chat reuse path already adopted
// active.projectId; these tests pin the fresh-session path.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  // newChat's create path only touches createChatSession + getSetting
  // (worktree gate — "false" skips ensure entirely).
  createChatSession: vi.fn(),
  getSetting: vi.fn().mockResolvedValue("false"),
  listChatSessions: vi.fn().mockResolvedValue([]),
}));

import { createChatSession } from "../lib/ipc";
import { useChatStore } from "../state/chat";

function seedActiveChat(id: string, projectId: string | null) {
  useChatStore.setState({
    sessions: [
      {
        id,
        title: "t",
        provider: "openai_compatible",
        model: "m",
        createdAt: 0,
        lastActiveAt: 0,
        projectId,
      } as never,
    ],
    activeChatSessionId: id,
    // Non-empty buffer OWNED by the active session: with an empty buffer
    // newChat takes the reuse path instead of creating a session.
    messages: [{ id: 1, chatSessionId: id, role: "user", content: "hi" } as never],
    messagesSessionId: id,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    sessions: [],
    activeChatSessionId: null,
    messages: [],
    messagesSessionId: null,
    sessionProjects: {},
  });
});

describe("newChat project inheritance", () => {
  it("inherits the active chat's project when no projectId is passed", async () => {
    seedActiveChat("bound", "proj-1");
    vi.mocked(createChatSession).mockImplementation(async (_p, _m, projectId) => ({
      id: "fresh",
      title: null,
      provider: "openai_compatible",
      model: "m",
      createdAt: 0,
      lastActiveAt: 0,
      projectId,
    } as never));

    await useChatStore.getState().newChat("openai_compatible", "gpt-x");

    expect(createChatSession).toHaveBeenCalledWith("openai_compatible", "gpt-x", "proj-1");
    expect(useChatStore.getState().activeChatSessionId).toBe("fresh");
    expect(useChatStore.getState().sessions.find((s) => s.id === "fresh")?.projectId).toBe("proj-1");
  });

  it("stays independent when the active chat has no project", async () => {
    seedActiveChat("loose", null);
    vi.mocked(createChatSession).mockImplementation(async (_p, _m, projectId) => ({
      id: "fresh",
      title: null,
      provider: "openai_compatible",
      model: "m",
      createdAt: 0,
      lastActiveAt: 0,
      projectId,
    } as never));

    await useChatStore.getState().newChat("openai_compatible", "gpt-x");

    expect(createChatSession).toHaveBeenCalledWith("openai_compatible", "gpt-x", null);
    expect(useChatStore.getState().sessions.find((s) => s.id === "fresh")?.projectId ?? null).toBeNull();
  });

  it("an explicit projectId still wins over the active chat's binding", async () => {
    seedActiveChat("bound", "proj-1");
    vi.mocked(createChatSession).mockImplementation(async (_p, _m, projectId) => ({
      id: "fresh",
      title: null,
      provider: "openai_compatible",
      model: "m",
      createdAt: 0,
      lastActiveAt: 0,
      projectId,
    } as never));

    await useChatStore.getState().newChat("openai_compatible", "gpt-x", "proj-2");

    expect(createChatSession).toHaveBeenCalledWith("openai_compatible", "gpt-x", "proj-2");
    expect(useChatStore.getState().sessions.find((s) => s.id === "fresh")?.projectId).toBe("proj-2");
  });
});
