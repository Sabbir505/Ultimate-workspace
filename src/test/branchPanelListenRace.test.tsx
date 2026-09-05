// C3 (ISSUES.md): BranchPanel dropped the safeListen unlisten handle when the
// component unmounted BEFORE the subscription promise resolved — the
// `cancelled` flag just skipped the assignment, leaking the project:fs-changed
// listener (and its closure) for the rest of the app's lifetime. Cleanup must
// CALL the unlisten in that case (DevDiffPanel pattern).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitLog: vi.fn(async () => []),
  safeListen: vi.fn(),
}));

import { safeListen } from "../lib/ipc";
import { BranchPanel } from "../components/panes/BranchPanel";
import { useChatStore } from "../state/chat";
import { useProjectsStore } from "../state/projects";

const safeListenMock = vi.mocked(safeListen);

const PROJECTS = [
  { id: "p1", name: "P1", path: "D:/proj/p1", isGitRepo: true, createdAt: 1, lastOpenedAt: null } as never,
];

beforeEach(() => {
  useProjectsStore.setState({
    projects: PROJECTS,
    selectedProjectId: "p1",
    gitStatuses: { p1: { isRepo: true, branch: "main", dirty: false, ahead: 0, behind: 0 } } as never,
  });
  useChatStore.setState({
    activeChatSessionId: null,
    sessionProjects: {},
    sessions: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BranchPanel safeListen unmount race (C3)", () => {
  it("unlisten fires when unmount beats the subscription", async () => {
    const unlisten = vi.fn();
    let resolve!: (u: () => void) => void;
    safeListenMock.mockImplementation(() => new Promise<() => void>((res) => { resolve = res; }));

    const { unmount } = render(<BranchPanel />);
    // Unmount BEFORE safeListen resolves — the old cancelled branch dropped
    // the handle entirely.
    unmount();
    resolve(unlisten);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unlisten is retained while mounted (no double-call)", async () => {
    const unlisten = vi.fn();
    let resolve!: (u: () => void) => void;
    safeListenMock.mockImplementation(() => new Promise<() => void>((res) => { resolve = res; }));

    const { unmount } = render(<BranchPanel />);
    resolve(unlisten);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(unlisten).not.toHaveBeenCalled();
    unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
