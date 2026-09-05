// B7 (ISSUES.md): `safeListen` resolves asynchronously, and both
// BranchDropdown and GitToolsSidebar dropped the unlisten handle when the
// component unmounted BEFORE the subscription promise resolved — the
// `cancelled` flag just skipped the assignment, leaking the backend event
// listener (and its closure) for the rest of the app's lifetime. The
// cleanup path must CALL the unlisten in that case.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listGitBranches: vi.fn(async () => []),
  checkoutGitBranch: vi.fn(async () => undefined),
  createGitBranch: vi.fn(async () => undefined),
  getChangedFiles: vi.fn(async () => []),
  refreshGitStatus: vi.fn(async () => undefined),
  // Each test installs its own deferred safeListen below.
  safeListen: vi.fn(),
}));

import { safeListen } from "../lib/ipc";
import { BranchDropdown } from "../components/chat/BranchDropdown";
import { GitToolsSidebar } from "../components/chat/GitToolsSidebar";
import { useChatStore } from "../state/chat";
import { useProjectsStore } from "../state/projects";
import { useUiStore } from "../state/ui";

const safeListenMock = vi.mocked(safeListen);

const PROJECTS = [
  { id: "p1", name: "P1", path: "D:/proj/p1", isGitRepo: true, createdAt: 1, lastOpenedAt: null } as never,
];

beforeEach(() => {
  useProjectsStore.setState({ projects: PROJECTS, selectedProjectId: "p1", gitStatuses: {} });
  useChatStore.setState({
    activeChatSessionId: null,
    sessionProjects: {},
    sessions: [],
    tasks: {},
    planSteps: {},
    subagents: {},
    messages: [],
  });
  useUiStore.setState({ gitSidebarCollapsed: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Install a safeListen mock whose resolution the test controls. */
function deferListen() {
  const unlisten = vi.fn();
  let resolve!: (u: () => void) => void;
  safeListenMock.mockImplementation(() => new Promise<() => void>((res) => { resolve = res; }));
  return { unlisten, resolve: () => resolve(unlisten) };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("safeListen unmount race", () => {
  it("BranchDropdown: unlisten fires when unmount beats the subscription", async () => {
    const listen = deferListen();
    const { unmount } = render(<BranchDropdown />);
    // Unmount BEFORE safeListen resolves — the cancelled branch used to drop
    // the handle entirely.
    unmount();
    listen.resolve();
    await flushMicrotasks();
    expect(listen.unlisten).toHaveBeenCalledTimes(1);
  });

  it("BranchDropdown: unlisten is retained while mounted (no double-call)", async () => {
    const listen = deferListen();
    const { unmount } = render(<BranchDropdown />);
    listen.resolve();
    await flushMicrotasks();
    expect(listen.unlisten).not.toHaveBeenCalled();
    unmount();
    await flushMicrotasks();
    expect(listen.unlisten).toHaveBeenCalledTimes(1);
  });

  it("GitToolsSidebar: unlisten fires when unmount beats the subscription", async () => {
    // The sidebar resolves the repo from the ACTIVE CHAT's binding.
    useChatStore.setState({
      activeChatSessionId: "sess-1",
      sessionProjects: { "sess-1": "p1" },
      sessions: [
        { id: "sess-1", title: "t", provider: "openai", model: "m", createdAt: 1, lastActiveAt: 2 } as never,
      ],
    });
    const listen = deferListen();
    const { unmount } = render(<GitToolsSidebar />);
    unmount();
    listen.resolve();
    await flushMicrotasks();
    expect(listen.unlisten).toHaveBeenCalledTimes(1);
  });

  it("GitToolsSidebar: unlisten is retained while mounted (no double-call)", async () => {
    useChatStore.setState({
      activeChatSessionId: "sess-1",
      sessionProjects: { "sess-1": "p1" },
      sessions: [
        { id: "sess-1", title: "t", provider: "openai", model: "m", createdAt: 1, lastActiveAt: 2 } as never,
      ],
    });
    const listen = deferListen();
    const { unmount } = render(<GitToolsSidebar />);
    listen.resolve();
    await flushMicrotasks();
    expect(listen.unlisten).not.toHaveBeenCalled();
    unmount();
    await flushMicrotasks();
    expect(listen.unlisten).toHaveBeenCalledTimes(1);
  });
});
