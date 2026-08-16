// Worktree-per-session default (roadmap P0 §3.1.1):
//  - newChat gives a chat on a git project its own isolated worktree (async,
//    best-effort) and patches the session row when the path resolves;
//  - send cwd resolution prefers the worktree over the project root
//    (custom-folder override still wins);
//  - toggleSessionWorktree isolates / joins-the-main-tree;
//  - unbind clears the worktree pointer locally;
//  - the one-time migration nudge banner shows for users with existing chats,
//    persists dismissal, and can isolate the active chat.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const createChatSessionMock = vi.fn();
const ensureChatSessionWorktreeMock = vi.fn();
const setChatSessionWorktreeMock = vi.fn();
const setChatSessionProjectMock = vi.fn();
const getSettingMock = vi.fn();
const setSettingMock = vi.fn();
const sendChatMessageMock = vi.fn();
const sendAgentChatMessageMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    createChatSession: (...a: unknown[]) => createChatSessionMock(...a),
    ensureChatSessionWorktree: (...a: unknown[]) => ensureChatSessionWorktreeMock(...a),
    setChatSessionWorktree: (...a: unknown[]) => setChatSessionWorktreeMock(...a),
    setChatSessionProject: (...a: unknown[]) => setChatSessionProjectMock(...a),
    getSetting: (...a: unknown[]) => getSettingMock(...a),
    setSetting: (...a: unknown[]) => setSettingMock(...a),
    sendChatMessage: (...a: unknown[]) => sendChatMessageMock(...a),
    sendAgentChatMessage: (...a: unknown[]) => sendAgentChatMessageMock(...a),
  };
});

import { useChatStore } from "../state/chat";
import { useProjectsStore } from "../state/projects";
import { WorktreeNudgeBanner } from "../components/onboarding/WorktreeNudgeBanner";
import type { ChatSession } from "../lib/ipc";

const session = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    title: "t",
    provider: "openai",
    model: "m",
    createdAt: 1,
    lastActiveAt: 2,
    ...over,
  }) as ChatSession;

const project = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    path: `D:/proj/${id}`,
    isGitRepo: true,
    createdAt: 1,
    lastOpenedAt: null,
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  getSettingMock.mockResolvedValue(null); // default ON
  setSettingMock.mockResolvedValue(undefined);
  createChatSessionMock.mockResolvedValue(null);
  ensureChatSessionWorktreeMock.mockResolvedValue(null);
  setChatSessionWorktreeMock.mockResolvedValue(undefined);
  setChatSessionProjectMock.mockResolvedValue(undefined);
  sendChatMessageMock.mockResolvedValue(undefined);
  sendAgentChatMessageMock.mockResolvedValue(undefined);
  useChatStore.setState({
    sessions: [],
    activeChatSessionId: null,
    messages: [],
    streaming: {},
    chatStatus: {},
    streamingChatSessionId: null,
    messageQueue: {},
    pendingArtifacts: {},
    sessionProjects: {},
    cwdOverrides: {},
    loopState: {},
  });
  useProjectsStore.setState({ projects: [], selectedProjectId: null });
});

describe("newChat: worktree-per-session default", () => {
  it("fires ensure for a new chat on a git project and patches state", async () => {
    useProjectsStore.setState({ projects: [project("p1")] });
    createChatSessionMock.mockResolvedValue(session("s1", { projectId: "p1" }));
    ensureChatSessionWorktreeMock.mockResolvedValue("D:/proj/p1-conduit-abc12345");

    await useChatStore.getState().newChat("openai", "m", "p1");

    // maybeEnsureWorktree is fire-and-forget — the ensure call lands in a
    // later microtask, so wait for the spy.
    await waitFor(() => expect(ensureChatSessionWorktreeMock).toHaveBeenCalledWith("s1"));
    await waitFor(() => {
      expect(useChatStore.getState().sessions[0]?.worktreePath).toBe("D:/proj/p1-conduit-abc12345");
    });
  });

  it("skips ensure when the global default is off (worktrees.defaultEnabled=false)", async () => {
    useProjectsStore.setState({ projects: [project("p1")] });
    createChatSessionMock.mockResolvedValue(session("s1", { projectId: "p1" }));
    getSettingMock.mockResolvedValue("false");

    await useChatStore.getState().newChat("openai", "m", "p1");

    expect(ensureChatSessionWorktreeMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions[0]?.worktreePath).toBeUndefined();
  });

  it("skips ensure for an unbound chat", async () => {
    createChatSessionMock.mockResolvedValue(session("s1", { projectId: null }));

    await useChatStore.getState().newChat("openai", "m", null);

    expect(ensureChatSessionWorktreeMock).not.toHaveBeenCalled();
  });

  it("skips ensure when the bound project is not a git repo", async () => {
    useProjectsStore.setState({ projects: [project("p1", { isGitRepo: false })] });
    createChatSessionMock.mockResolvedValue(session("s1", { projectId: "p1" }));

    await useChatStore.getState().newChat("openai", "m", "p1");

    expect(ensureChatSessionWorktreeMock).not.toHaveBeenCalled();
  });

  it("does not re-fire ensure for a session that already has a worktree", async () => {
    useProjectsStore.setState({ projects: [project("p1")] });
    createChatSessionMock.mockResolvedValue(
      session("s1", { projectId: "p1", worktreePath: "D:/proj/p1-conduit-xyz" }),
    );

    await useChatStore.getState().newChat("openai", "m", "p1");

    expect(ensureChatSessionWorktreeMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions[0]?.worktreePath).toBe("D:/proj/p1-conduit-xyz");
  });
});

describe("send cwd resolution prefers the worktree", () => {
  it("sends a harness turn with the worktree as cwd", async () => {
    useProjectsStore.setState({ projects: [project("p1")], selectedProjectId: null });
    useChatStore.setState({
      sessions: [session("s1", { projectId: "p1", worktreePath: "D:/proj/p1-conduit-abc", agent: "harness:claude_code" })],
      activeChatSessionId: "s1",
      messages: [],
      sessionProjects: { s1: "p1" },
    });

    await useChatStore.getState().sendMessage("run tests");

    expect(sendAgentChatMessageMock).toHaveBeenCalledWith(
      "s1", "run tests", "claude_code", "m", "D:/proj/p1-conduit-abc", undefined,
    );
  });

  it("custom-folder override still wins over the worktree", async () => {
    useProjectsStore.setState({ projects: [project("p1")], selectedProjectId: null });
    useChatStore.setState({
      sessions: [session("s1", { projectId: "p1", worktreePath: "D:/proj/p1-conduit-abc", agent: "harness:claude_code" })],
      activeChatSessionId: "s1",
      messages: [],
      sessionProjects: { s1: "p1" },
      cwdOverrides: { s1: "D:/custom" },
    });

    await useChatStore.getState().sendMessage("run tests");

    expect(sendAgentChatMessageMock).toHaveBeenCalledWith(
      "s1", "run tests", "claude_code", "m", "D:/custom", undefined,
    );
  });

  it("broadcast background sessions use their worktree as cwd", async () => {
    useProjectsStore.setState({ projects: [project("p1")], selectedProjectId: null });
    useChatStore.setState({
      sessions: [
        session("a"),
        session("b", { projectId: "p1", worktreePath: "D:/proj/p1-conduit-b", agent: "harness:kimi_code" }),
      ],
      activeChatSessionId: "a",
      messages: [],
      sessionProjects: { b: "p1" },
    });

    await useChatStore.getState().broadcastToSessions(["b"], "hello");

    expect(sendAgentChatMessageMock).toHaveBeenCalledWith(
      "b", "hello", "kimi_code", "m", "D:/proj/p1-conduit-b", undefined,
    );
  });
});

describe("toggleSessionWorktree", () => {
  it("joins the main working tree when isolated", async () => {
    useChatStore.setState({
      sessions: [session("s1", { projectId: "p1", worktreePath: "D:/proj/p1-conduit-abc" })],
    });

    await useChatStore.getState().toggleSessionWorktree("s1");

    expect(setChatSessionWorktreeMock).toHaveBeenCalledWith("s1", null);
    expect(useChatStore.getState().sessions[0]?.worktreePath).toBeNull();
  });

  it("isolates when not yet isolated", async () => {
    useProjectsStore.setState({ projects: [project("p1")] });
    useChatStore.setState({ sessions: [session("s1", { projectId: "p1" })] });
    ensureChatSessionWorktreeMock.mockResolvedValue("D:/proj/p1-conduit-abc");

    await useChatStore.getState().toggleSessionWorktree("s1");

    expect(ensureChatSessionWorktreeMock).toHaveBeenCalledWith("s1");
    await waitFor(() => {
      expect(useChatStore.getState().sessions[0]?.worktreePath).toBe("D:/proj/p1-conduit-abc");
    });
  });
});

describe("unbind clears the worktree locally", () => {
  it("drops projectId AND worktreePath from the session row", async () => {
    useChatStore.setState({
      sessions: [session("s1", { projectId: "p1", worktreePath: "D:/proj/p1-conduit-abc" })],
      sessionProjects: { s1: "p1" },
      cwdOverrides: { s1: "D:/proj/p1-conduit-abc" },
    });

    useChatStore.getState().unbindProject("s1");

    expect(setChatSessionProjectMock).toHaveBeenCalledWith("s1", null);
    const s = useChatStore.getState().sessions[0];
    expect(s?.projectId).toBeNull();
    expect(s?.worktreePath).toBeNull();
  });
});

describe("WorktreeNudgeBanner (migration nudge)", () => {
  it("shows for users with existing chats and persists dismissal", async () => {
    getSettingMock.mockImplementation((key: string) =>
      key === "worktrees.nudgeSeen" ? Promise.resolve(null) : Promise.resolve(null),
    );
    useChatStore.setState({ sessions: [session("old1")] });

    render(<WorktreeNudgeBanner />);

    expect(await screen.findByText(/isolated worktrees/i)).toBeTruthy();

    // Dismiss persists the KV flag.
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    dismiss.click();
    await waitFor(() => expect(setSettingMock).toHaveBeenCalledWith("worktrees.nudgeSeen", "1"));
  });

  it("is hidden once the nudge has been seen", async () => {
    getSettingMock.mockImplementation((key: string) =>
      key === "worktrees.nudgeSeen" ? Promise.resolve("1") : Promise.resolve(null),
    );
    useChatStore.setState({ sessions: [session("old1")] });

    render(<WorktreeNudgeBanner />);
    await waitFor(() => {
      expect(screen.queryByText(/isolated worktrees/i)).toBeNull();
    });
  });

  it("is hidden when there are no chats yet", async () => {
    render(<WorktreeNudgeBanner />);
    await waitFor(() => {
      expect(screen.queryByText(/isolated worktrees/i)).toBeNull();
    });
  });

  it("'Isolate this chat' isolates the active chat and dismisses", async () => {
    getSettingMock.mockImplementation((key: string) =>
      key === "worktrees.nudgeSeen" ? Promise.resolve(null) : Promise.resolve(null),
    );
    useProjectsStore.setState({ projects: [project("p1")] });
    useChatStore.setState({
      sessions: [session("old1", { projectId: "p1" })],
      activeChatSessionId: "old1",
    });
    ensureChatSessionWorktreeMock.mockResolvedValue("D:/proj/p1-conduit-old1");

    render(<WorktreeNudgeBanner />);
    const isolate = await screen.findByRole("button", { name: "Isolate this chat" });
    isolate.click();

    await waitFor(() => expect(ensureChatSessionWorktreeMock).toHaveBeenCalledWith("old1"));
    await waitFor(() => expect(setSettingMock).toHaveBeenCalledWith("worktrees.nudgeSeen", "1"));
  });
});
