// ProjectsSidebar (second panel beside the main sidebar): pins the user-
// facing behaviors — expand-to-reveal nested chats, the 5-at-a-time chat
// cap with Show more/Show less, per-project New Chat binding, stash-to-
// bottom, and chat pinning via the same starred flag Chat History uses.
// The chat/projects/ui stores are replaced with real zustand stores seeded
// per test (the full chat store drags in the whole IPC surface); the
// projectsSidebar store is the REAL one so its localStorage persistence is
// exercised too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { ipc, chatActions, uiActions } = vi.hoisted(() => ({
  ipc: {
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    exportChatZip: vi.fn(),
  },
  chatActions: {
    // Resolving spies — the component's handlers chain .catch/.then on these.
    selectSession: vi.fn().mockResolvedValue(undefined),
    newChat: vi.fn().mockResolvedValue(null),
    deleteChat: vi.fn().mockResolvedValue(undefined),
    renameChat: vi.fn().mockResolvedValue(undefined),
    setStarred: vi.fn().mockResolvedValue(undefined),
    setUnread: vi.fn().mockResolvedValue(undefined),
    loadSessions: vi.fn().mockResolvedValue(undefined),
    openChatSplit: vi.fn().mockResolvedValue(undefined),
  },
  uiActions: {
    setActiveView: vi.fn(),
  },
}));

vi.mock("../lib/ipc", async () => {
  // agentIcons (pulled in via ChatSessionRow) imports providerKindOf through
  // lib/ipc — pass the real pure implementation through.
  const { providerKindOf } = await import("../lib/providerKind");
  return { ...ipc, providerKindOf };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("../state/ui", async () => {
  const { create } = await import("zustand");
  const useUiStore = create(() => ({
    activeView: "chat",
    setActiveView: uiActions.setActiveView,
  }));
  return { useUiStore };
});

vi.mock("../state/projects", async () => {
  const { create } = await import("zustand");
  const useProjectsStore = create(() => ({
    projects: [] as { id: string; name: string; path: string }[],
    gitStatuses: {} as Record<string, { branch?: string }>,
    expanded: {} as Record<string, boolean>,
    selectedProjectId: null as string | null,
    // Real behaviors so expand/select can be driven from the test.
    toggleExpanded: (projectId: string) =>
      useProjectsStore.setState((s) => ({
        expanded: { ...s.expanded, [projectId]: !s.expanded[projectId] },
      })),
    selectProject: (projectId: string | null) =>
      useProjectsStore.setState({ selectedProjectId: projectId }),
    addProjectAtPath: vi.fn(),
  }));
  return { useProjectsStore };
});

vi.mock("../state/chat", async () => {
  const { create } = await import("zustand");
  const useChatStore = create(() => ({
    sessions: [],
    sessionProjects: {} as Record<string, string>,
    cwdOverrides: {} as Record<string, string>,
    streaming: {} as Record<string, unknown>,
    activeChatSessionId: null as string | null,
    lastSelection: null,
    config: { provider: null, model: null },
    loaded: true,
    ...chatActions,
  }));
  return { useChatStore };
});

import { useChatStore } from "../state/chat";
import { useProjectsStore } from "../state/projects";
import { useProjectsSidebarStore } from "../state/projectsSidebar";
import { ProjectsSidebar } from "../components/sidebar/ProjectsSidebar";
import type { ChatSession } from "../lib/ipc";
import type { Project } from "../types";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/tmp/${name.toLowerCase()}`,
    isGitRepo: true,
    createdAt: 1,
    lastOpenedAt: 1,
  };
}

function session(id: string, over: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    title: `Chat ${id}`,
    provider: "anthropic",
    model: "m",
    createdAt: 1,
    lastActiveAt: 1,
    starred: false,
    unread: false,
    projectId: "p1",
    agent: null,
    worktreePath: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useProjectsSidebarStore.setState({ open: true, stashed: [] });
  useProjectsStore.setState({
    projects: [project("p1", "Alpha"), project("p2", "Beta")],
    gitStatuses: {
      p1: { isRepo: true, branch: "main", dirty: false, ahead: 0, behind: 0 },
    },
    expanded: {},
    selectedProjectId: null,
  });
  useChatStore.setState({
    sessions: [],
    sessionProjects: {},
    streaming: {},
    activeChatSessionId: null,
    lastSelection: null,
    config: { provider: null, baseUrl: null, model: null, hasKey: false },
    loaded: true,
  });
  chatActions.newChat.mockResolvedValue({ id: "new-1" });
});

afterEach(cleanup);

function expandProject(name: string) {
  fireEvent.click(screen.getByText(name));
}

describe("ProjectsSidebar", () => {
  it("renders every project and expands to its nested chats", () => {
    useChatStore.setState({
      sessions: [session("c1", { title: "Design review" })],
    });
    render(<ProjectsSidebar />);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    // Nested chats stay hidden until the project row is clicked.
    expect(screen.queryByText("Design review")).toBeNull();
    expandProject("Alpha");
    expect(screen.getByText("Design review")).toBeTruthy();
  });

  it("opens the clicked chat and switches to the chat view", () => {
    useChatStore.setState({
      sessions: [session("c1", { title: "Design review" })],
      activeChatSessionId: "c1",
    });
    render(<ProjectsSidebar />);
    expandProject("Alpha");
    fireEvent.click(screen.getByText("Design review"));
    expect(chatActions.selectSession).toHaveBeenCalledWith("c1");
    expect(uiActions.setActiveView).toHaveBeenCalledWith("chat");
  });

  it("pins a nested chat through the same starred flag as Chat History", () => {
    useChatStore.setState({
      sessions: [session("c1")],
    });
    render(<ProjectsSidebar />);
    expandProject("Alpha");
    fireEvent.click(screen.getByLabelText("Pin chat"));
    expect(chatActions.setStarred).toHaveBeenCalledWith("c1", true);
  });

  it("caps each project at 5 recent chats, revealing 5 more per click", () => {
    const chats = ["a", "b", "c", "d", "e", "f", "g"].map((n, i) =>
      session(`c-${n}`, { title: `Chat ${n}`, lastActiveAt: 1000 - i }),
    );
    useChatStore.setState({ sessions: chats });
    render(<ProjectsSidebar />);
    expandProject("Alpha");
    for (const n of ["a", "b", "c", "d", "e"]) {
      expect(screen.getByText(`Chat ${n}`)).toBeTruthy();
    }
    expect(screen.queryByText("Chat f")).toBeNull();
    expect(screen.getByText("Show more")).toBeTruthy();

    fireEvent.click(screen.getByText("Show more"));
    expect(screen.getByText("Chat f")).toBeTruthy();
    expect(screen.getByText("Chat g")).toBeTruthy();
    // Everything is visible now — the button flips to "Show less".
    expect(screen.getByText("Show less")).toBeTruthy();

    fireEvent.click(screen.getByText("Show less"));
    expect(screen.queryByText("Chat f")).toBeNull();
  });

  it("floats pinned (starred) chats above the recent ones", () => {
    const chats = [
      session("c-old", { title: "Old pinned", starred: true, lastActiveAt: 10 }),
      session("c-new", { title: "New unpinned", lastActiveAt: 20 }),
    ];
    useChatStore.setState({ sessions: chats });
    render(<ProjectsSidebar />);
    expandProject("Alpha");
    const titles = Array.from(
      document.querySelectorAll(".chat-session-title-text"),
    ).map((el) => el.textContent);
    expect(titles).toEqual(["Old pinned", "New unpinned"]);
  });

  it("binds a project's New Chat to that project id", async () => {
    render(<ProjectsSidebar />);
    expandProject("Alpha");
    fireEvent.click(screen.getByLabelText("New chat in Alpha"));
    // Seeded from the (empty) last pick, with the explicit project binding.
    expect(chatActions.newChat).toHaveBeenCalledWith(
      "openai_compatible",
      "",
      "p1",
      null,
    );
    // The view flip follows the store's async resolution.
    await waitFor(() =>
      expect(uiActions.setActiveView).toHaveBeenCalledWith("chat"),
    );
  });

  it("stashes a project to the bottom of the list and persists it", () => {
    useChatStore.setState({ sessions: [session("c1")] });
    render(<ProjectsSidebar />);
    expandProject("Alpha");

    const namesOrder = () =>
      Array.from(document.querySelectorAll(".sidebar-project-name")).map(
        (el) => el.textContent,
      );
    expect(namesOrder()).toEqual(["Alpha", "Beta"]);

    fireEvent.click(screen.getByLabelText("Stash Alpha"));
    expect(namesOrder()).toEqual(["Beta", "Alpha"]);
    expect(
      useProjectsSidebarStore.getState().stashed,
    ).toEqual(["p1"]);
    expect(
      JSON.parse(localStorage.getItem("relay.projectsSidebar.v1") ?? "{}").stashed,
    ).toEqual(["p1"]);

    // Unstash restores the original order.
    fireEvent.click(screen.getByLabelText("Unstash Alpha"));
    expect(namesOrder()).toEqual(["Alpha", "Beta"]);
  });

  it("rehydrates open + stash state from localStorage", async () => {
    localStorage.setItem(
      "relay.projectsSidebar.v1",
      JSON.stringify({ open: true, stashed: ["p2"] }),
    );
    vi.resetModules();
    const { useProjectsSidebarStore: fresh } = await import(
      "../state/projectsSidebar"
    );
    expect(fresh.getState().open).toBe(true);
    expect(fresh.getState().stashed).toEqual(["p2"]);
    // Sanity: toggling persists back to storage.
    fresh.getState().toggleOpen();
    expect(
      JSON.parse(localStorage.getItem("relay.projectsSidebar.v1") ?? "{}").open,
    ).toBe(false);
  });

  it("shows the empty state when no projects exist", () => {
    useProjectsStore.setState({ projects: [] });
    render(<ProjectsSidebar />);
    expect(screen.getByText("No projects yet")).toBeTruthy();
    expect(screen.getByText("Add a project folder")).toBeTruthy();
  });
});
