// Git sidebar section disclosure: persistent per-section open/closed state.
//
// The Git sidebar contains four independent sections — Git, Plans, Progress,
// Agents — each with its own toggle that should persist across the lifetime
// of the store (so reloading a chat remembers the user's last layout).
// The whole-sidebar gitSidebarCollapsed boolean is unchanged and remains
// orthogonal: when the sidebar itself is collapsed the sections are not
// rendered; when it is open, each section's `open` flag controls its body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { useUiStore } from "../state/ui";
import { useChatStore } from "../state/chat";
import { useProjectsStore } from "../state/projects";

/* ── Store-level tests ───────────────────────────────────────────────────── */

describe("git sidebar section disclosure", () => {
  // Reset all mutable state so one test's toggles don't leak into the next.
  beforeEach(() => {
    useUiStore.setState({
      gitSidebarCollapsed: false,
      gitSectionGitOpen: true,
      gitSectionPlansOpen: true,
      gitSectionProgressOpen: true,
      gitSectionAgentsOpen: true,
    });
  });

  it("toggles each section independently", () => {
    const s = useUiStore.getState();
    s.toggleGitSectionGit();
    expect(useUiStore.getState().gitSectionGitOpen).toBe(false);
    // Sibling sections must not be affected — toggling Git must not
    // accidentally collapse Plans / Progress / Agents.
    expect(useUiStore.getState().gitSectionPlansOpen).toBe(true);
    expect(useUiStore.getState().gitSectionProgressOpen).toBe(true);
    expect(useUiStore.getState().gitSectionAgentsOpen).toBe(true);

    s.toggleGitSectionPlans();
    expect(useUiStore.getState().gitSectionPlansOpen).toBe(false);

    s.toggleGitSectionProgress();
    expect(useUiStore.getState().gitSectionProgressOpen).toBe(false);

    s.toggleGitSectionAgents();
    expect(useUiStore.getState().gitSectionAgentsOpen).toBe(false);
  });

  it("toggling a section twice returns it to its original state", () => {
    const s = useUiStore.getState();
    s.toggleGitSectionGit();
    s.toggleGitSectionGit();
    expect(useUiStore.getState().gitSectionGitOpen).toBe(true);
  });

  it("section state is independent of the whole-sidebar collapse toggle", () => {
    // gitSidebarCollapsed hides the entire sidebar; section flags are not
    // touched by it. This is the contract callers rely on: collapsing the
    // sidebar shouldn't silently reset which sections were open.
    const s = useUiStore.getState();
    s.toggleGitSectionGit();
    expect(useUiStore.getState().gitSectionGitOpen).toBe(false);

    s.toggleGitSidebar();
    expect(useUiStore.getState().gitSidebarCollapsed).toBe(true);
    // Section flag is preserved.
    expect(useUiStore.getState().gitSectionGitOpen).toBe(false);

    s.toggleGitSidebar();
    expect(useUiStore.getState().gitSidebarCollapsed).toBe(false);
    expect(useUiStore.getState().gitSectionGitOpen).toBe(false);
  });
});

describe("git sidebar section disclosure — initial defaults", () => {
  // Verify the store ships with all four sections open. Re-import the module
  // to read the constructor's defaults, since other tests in this file have
  // already mutated shared state.
  it("defaults all four sections to open on a fresh store", async () => {
    vi.resetModules();
    const { useUiStore: fresh } = await import("../state/ui");
    const { gitSectionGitOpen, gitSectionPlansOpen, gitSectionProgressOpen, gitSectionAgentsOpen } =
      fresh.getState();
    expect(gitSectionGitOpen).toBe(true);
    expect(gitSectionPlansOpen).toBe(true);
    expect(gitSectionProgressOpen).toBe(true);
    expect(gitSectionAgentsOpen).toBe(true);
  });
});

/* ── Component-level tests ───────────────────────────────────────────────── */

vi.mock("../lib/ipc", () => ({
  getChangedFiles: vi.fn().mockResolvedValue([]),
  listGitBranches: vi.fn().mockResolvedValue([]),
  safeListen: vi.fn().mockResolvedValue(() => {}),
}));

import { GitToolsSidebar } from "../components/chat/GitToolsSidebar";
import { getChangedFiles, listGitBranches } from "../lib/ipc";
import type { ChatSession } from "../lib/ipc";

const getChangedFilesMock = vi.mocked(getChangedFiles);
const listGitBranchesMock = vi.mocked(listGitBranches);

describe("GitToolsSidebar — section disclosure", () => {
  beforeEach(() => {
    // Make sure the sidebar is in its expanded state with all sections open.
    useUiStore.setState({
      gitSidebarCollapsed: false,
      gitSectionGitOpen: true,
      gitSectionPlansOpen: true,
      gitSectionProgressOpen: true,
      gitSectionAgentsOpen: true,
    });
    // The sidebar reads from chat/projects stores but doesn't need any data
    // to render the disclosure headers themselves.
    useChatStore.setState({
      activeChatSessionId: null,
      sessionProjects: {},
      sessions: [],
      tasks: {},
      planSteps: {},
      subagents: {},
      messages: [],
    });
    useProjectsStore.setState({
      projects: [],
      gitStatuses: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders section headers as disclosure buttons with aria-expanded=true when open", () => {
    render(<GitToolsSidebar />);
    const plans = screen.getByRole("button", { name: /plans/i });
    const progress = screen.getByRole("button", { name: /progress/i });
    const agents = screen.getByRole("button", { name: /agents/i });
    const git = screen.getByRole("button", { name: /^git tools$/i });
    expect(plans.getAttribute("aria-expanded")).toBe("true");
    expect(progress.getAttribute("aria-expanded")).toBe("true");
    expect(agents.getAttribute("aria-expanded")).toBe("true");
    expect(git.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking a section header toggles its aria-expanded state and the body hides", () => {
    render(<GitToolsSidebar />);
    const plans = screen.getByRole("button", { name: /plans/i });
    expect(plans.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(plans);
    // The store now reports plans as collapsed, and the body has the
    // collapsed CSS class (display: grid; grid-template-rows: 0fr).
    expect(useUiStore.getState().gitSectionPlansOpen).toBe(false);
    const region = document.getElementById("git-section-plans");
    expect(region).not.toBeNull();
    expect(region!.className).not.toMatch(/\bopen\b/);
  });

  it("toggling the whole sidebar closed still preserves per-section flags", () => {
    render(<GitToolsSidebar />);
    // Collapse the Plans section first.
    fireEvent.click(screen.getByRole("button", { name: /plans/i }));
    expect(useUiStore.getState().gitSectionPlansOpen).toBe(false);
    // Then collapse the whole sidebar.
    fireEvent.click(screen.getByRole("button", { name: /collapse git tools/i }));
    expect(useUiStore.getState().gitSidebarCollapsed).toBe(true);
    // The Plans section flag must be preserved — the store is the source of
    // truth, not the DOM, so re-opening the sidebar should reveal the
    // remembered state.
    expect(useUiStore.getState().gitSectionPlansOpen).toBe(false);
  });

  it("an unbound new chat must NOT show the sidebar-selected project's git data", () => {
    // A brand-new chat created from the toolbar has NO project binding yet
    // (newChat without a projectId). The git surface must follow the chat —
    // it must never fall back to whatever project happens to be selected in
    // the sidebar tree, or it leaks that project's changes/branch into a
    // chat that has nothing to do with it.
    useChatStore.setState({
      activeChatSessionId: "sess-new",
      sessionProjects: {}, // unbound
      sessions: [
        { id: "sess-new", title: "t", provider: "openai", model: "m", createdAt: 1, lastActiveAt: 2 } as ChatSession,
      ],
    });
    useProjectsStore.setState({
      selectedProjectId: "p1",
      projects: [
        { id: "p1", name: "p1", path: "D:/proj/p1", isGitRepo: true, createdAt: 1, lastOpenedAt: null } as never,
      ],
      gitStatuses: {
        p1: { branch: "master", ahead: 0, behind: 0, dirty: true, clean: false } as never,
      },
    });

    render(<GitToolsSidebar />);

    // Effects flush synchronously under RTL's act(): with the old fallback
    // the poll would have fired against p1's path by now.
    expect(getChangedFilesMock).not.toHaveBeenCalled();
    expect(listGitBranchesMock).not.toHaveBeenCalled();
    // The other project's branch name must not appear (unbound shows HEAD).
    expect(screen.queryByText("master")).toBeNull();
  });
});
