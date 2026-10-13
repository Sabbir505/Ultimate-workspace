// Chat History (the main sidebar's inbox) must list UNBOUND chats only.
//
// Regression: chats opened from a project are nested under that project in
// the Projects panel, but they also kept rendering in the flat inbox —
// every project chat appeared in two sidebar lists at once. The fix filters
// bound chats out of the inbox. A binding whose project is gone (no row in
// the Projects panel to nest it under) deliberately stays visible.
//
// The Sidebar tree touches a lot of IPC surface, so `lib/ipc` is a
// permissive proxy stub — this test is about the inbox filter, not any one
// command. `then`/`catch`/`finally` must resolve to undefined, otherwise the
// mocked module becomes a thenable and awaiting it wedges the worker.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("../lib/ipc", () => {
  const PASS_THROUGH = new Set([
    "then",
    "catch",
    "finally",
    "__esModule",
    "default",
    "SIDEBAR_ART_PRESETS",
  ]);
  const stub = new Proxy(
    {},
    {
      has: (_t, prop) => typeof prop === "string" && !PASS_THROUGH.has(prop),
      get: (_t, prop) => {
        if (typeof prop !== "string") return undefined;
        if (prop === "SIDEBAR_ART_PRESETS") return [];
        if (PASS_THROUGH.has(prop)) return undefined;
        if (prop === "sidebarArtPresetUrl") return () => "";
        if (prop === "PROVIDER_INPUT_INCLUDES_CACHE") return {};
        if (prop === "toastError" || prop === "toastSuccess" || prop === "toastInfo")
          return () => {};
        return vi.fn().mockResolvedValue(null);
      },
    },
  );
  return stub;
});

import { Sidebar } from "../components/sidebar/Sidebar";
import { useChatStore } from "../state/chat";
import { useProjectsStore } from "../state/projects";
import type { ChatSession } from "../lib/ipc";
import type { Project } from "../types";

function chat(id: string, title: string, over: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    title,
    provider: "anthropic",
    model: "m",
    createdAt: 1,
    lastActiveAt: 1,
    starred: false,
    unread: false,
    projectId: null,
    agent: null,
    worktreePath: null,
    ...over,
  };
}

function project(id: string, name: string): Project {
  return { id, name, path: `D:/${name}`, isGitRepo: true, createdAt: 1, lastOpenedAt: 1 };
}

/** Titles the inbox rows currently show. */
function inboxTitles(): (string | null)[] {
  return Array.from(document.querySelectorAll(".chat-session-title-text")).map(
    (el) => el.textContent,
  );
}

// The inbox is windowed with @tanstack/react-virtual, which sizes its
// viewport from the scroll element's offsetWidth/offsetHeight. jsdom leaves
// both at 0, so the virtualizer would render no rows at all. Give it a
// plausible viewport for this file (same accommodation as
// automationStop.test.tsx / csvTableVirtualization.test.tsx).
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useProjectsStore.setState({
    projects: [project("p1", "Alpha")],
    gitStatuses: {},
    expanded: {},
    loaded: true,
  });
  useChatStore.setState({
    sessions: [],
    sessionProjects: {},
    cwdOverrides: {},
    streaming: {},
    activeChatSessionId: null,
    loaded: true,
  });
});

describe("sidebar Chat History inbox", () => {
  it("hides project-bound chats — they live nested under their project", () => {
    useChatStore.setState({
      sessions: [
        chat("bound", "Bound to Alpha", { projectId: "p1" }),
        chat("loose", "Loose chat"),
      ],
    });
    render(<Sidebar />);
    expect(inboxTitles()).toEqual(["Loose chat"]);
  });

  it("also hides chats bound through the in-memory sessionProjects map", () => {
    useChatStore.setState({
      sessions: [chat("c1", "Map-bound chat")],
      sessionProjects: { c1: "p1" },
    });
    render(<Sidebar />);
    expect(inboxTitles()).toEqual([]);
  });

  it("keeps a chat whose project no longer exists (nothing else shows it)", () => {
    useChatStore.setState({
      sessions: [chat("orphan", "Orphaned chat", { projectId: "deleted" })],
    });
    render(<Sidebar />);
    expect(inboxTitles()).toEqual(["Orphaned chat"]);
  });

  it("shows the empty state when every remaining chat is project-bound", () => {
    useChatStore.setState({
      sessions: [chat("bound", "Bound to Alpha", { projectId: "p1" })],
    });
    render(<Sidebar />);
    expect(inboxTitles()).toEqual([]);
    expect(screen.getByText("No chats yet")).toBeTruthy();
  });
});
