// Tests for the GitToolsSidebar activity strip (§3.1.6): the "Now" summary
// showing streaming chats + in-flight automations at the top of the git
// sidebar. The strip must render only when something is actually active and
// list the right titles/names.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  getChangedFiles: vi.fn().mockResolvedValue([]),
  listGitBranches: vi.fn().mockResolvedValue([]),
  safeListen: vi.fn().mockResolvedValue(() => {}),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

import { GitToolsSidebar } from "../components/chat/GitToolsSidebar";
import { useChatStore } from "../state/chat";
import { useAutomationsStore } from "../state/automations";
import { useUiStore } from "../state/ui";

beforeEach(() => {
  useChatStore.setState({
    sessions: [],
    streaming: {},
    subagents: {},
    tasks: {},
    planSteps: {},
    sessionProjects: {},
  });
  useAutomationsStore.setState({ automations: [], runningNow: {} });
  // The sidebar renders as a collapsed ~48px strip by default — expand it so
  // the section contents (the "Now" strip) are in the tree.
  useUiStore.setState({ gitSidebarCollapsed: false });
});

afterEach(() => cleanup());

/** The "Now" strip container — null when nothing is active. */
function activityStrip(): HTMLElement | null {
  return document.querySelector(".git-sidebar-activity");
}

it("renders nothing when no work is active", () => {
  render(<GitToolsSidebar />);
  expect(activityStrip()).toBeNull();
});

it("shows streaming chats count + titles", () => {
  useChatStore.setState({
    sessions: [
      { id: "s1", title: "Fix the parser", createdAt: 0, lastActiveAt: 0, provider: "x", model: "y" },
    ],
    streaming: { s1: "accumulating reply" },
  });
  render(<GitToolsSidebar />);
  const strip = activityStrip();
  expect(strip).not.toBeNull();
  // The item's title attr carries the streaming session's name.
  const item = within(strip!).getByTitle("Fix the parser");
  expect(within(item).getByText("1")).not.toBeNull();
});

it("shows running automations count + names", () => {
  useAutomationsStore.setState({
    automations: [
      {
        id: "a1",
        name: "Nightly backup",
        prompt: "p",
        harness: "claude_code",
        model: "m",
        cwd: ".",
        schedule: "* * * * *",
        enabled: true,
        lastRunAt: null,
        lastStatus: null,
        chatSessionId: null,
        createdAt: 0,
      },
    ],
    runningNow: { a1: true },
  });
  render(<GitToolsSidebar />);
  const strip = activityStrip();
  expect(strip).not.toBeNull();
  const item = within(strip!).getByTitle("Nightly backup");
  expect(within(item).getByText("1")).not.toBeNull();
});

it("shows both active stream and running automation together", () => {
  useChatStore.setState({
    sessions: [
      { id: "s1", title: "Fix the parser", createdAt: 0, lastActiveAt: 0, provider: "x", model: "y" },
    ],
    streaming: { s1: "accumulating reply" },
  });
  useAutomationsStore.setState({
    automations: [
      {
        id: "a1",
        name: "Nightly backup",
        prompt: "p",
        harness: "claude_code",
        model: "m",
        cwd: ".",
        schedule: "* * * * *",
        enabled: true,
        lastRunAt: null,
        lastStatus: null,
        chatSessionId: null,
        createdAt: 0,
      },
    ],
    runningNow: { a1: true },
  });
  render(<GitToolsSidebar />);
  const strip = activityStrip();
  expect(strip).not.toBeNull();
  expect(within(strip!).getByTitle("Fix the parser")).not.toBeNull();
  expect(within(strip!).getByTitle("Nightly backup")).not.toBeNull();
});

it("hides the strip once streaming finishes", () => {
  useChatStore.setState({
    sessions: [
      { id: "s1", title: "Fix the parser", createdAt: 0, lastActiveAt: 0, provider: "x", model: "y" },
    ],
    streaming: { s1: "accumulating reply" },
  });
  const { rerender } = render(<GitToolsSidebar />);
  expect(activityStrip()).not.toBeNull();
  useChatStore.setState({ streaming: {} });
  rerender(<GitToolsSidebar />);
  expect(activityStrip()).toBeNull();
});