// C13 (ISSUES.md): DevDiffPanel's `visibleFiles` useMemo (and the
// review/toggleFile useCallbacks) sat AFTER the "unbound" and "collapsed"
// early returns. Transitioning a mounted panel to the unbound empty state (or
// collapsing it) rendered fewer hooks than the previous render — React threw
// "Rendered fewer hooks than expected" and the panel crashed. The fix moves
// every hook above the early returns; this test mounts bound and then forces
// both transitions — the render must survive.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const getChangedFilesMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChangedFiles: (...a: unknown[]) => getChangedFilesMock(...a),
  getGitFileDiffScoped: vi.fn(async () => ""),
  getBranchChangedFiles: vi.fn(async () => ({ files: [], mergeBase: "" })),
  listChatCheckpoints: vi.fn(async () => []),
  generateDiffReview: vi.fn(async () => null),
}));

import { DevDiffPanel } from "../components/panes/DevDiffPanel";
import { useChatStore } from "../state/chat";
import { usePanesStore } from "../state/panes";
import { useProjectsStore } from "../state/projects";
import { useUiStore } from "../state/ui";

const CHAT_SESSION = {
  id: "sess-1",
  title: "t",
  provider: "openai",
  model: "m",
  createdAt: 1,
  lastActiveAt: 2,
};

const terminalPane = {
  paneId: "term-1",
  state: "idle",
  lastUsedAt: 1,
  lastInputAt: 0,
  activity: null,
  data: { kind: "terminal", sessionId: "relay-1", harness: null, label: "sh", spawn: { type: "shell", cwd: "D:/proj/p1", command: "sh" }, exited: false, exitCode: null, crashed: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  getChangedFilesMock.mockResolvedValue([
    { status: "??", kind: "U", path: "src/a.ts", oldPath: null, added: 1, deleted: 0 },
  ]);
  usePanesStore.setState({ panes: [], focusedPaneId: null });
  useProjectsStore.setState({
    projects: [
      { id: "p1", name: "P1", path: "D:/proj/p1", isGitRepo: true, createdAt: 1, lastOpenedAt: null } as never,
    ],
    selectedProjectId: "p1",
    sessions: [{ id: "relay-1", projectId: "p1", harness: "shell", title: "sh", createdAt: 1, lastActiveAt: 1 } as never],
    gitStatuses: {},
  });
  useChatStore.setState({
    activeChatSessionId: "sess-1",
    focusedChatSessionId: null,
    splitChatSessionId: null,
    sessions: [CHAT_SESSION as never],
    sessionProjects: { "sess-1": "p1" },
  });
  useUiStore.setState({ diffPanelCollapsed: false });
});

afterEach(() => {
  cleanup();
  usePanesStore.setState({ panes: [], focusedPaneId: null });
  useChatStore.setState({ activeChatSessionId: null, focusedChatSessionId: null, sessions: [], sessionProjects: {} });
  useProjectsStore.setState({ projects: [], selectedProjectId: null, sessions: [] });
});

describe("C13: hook order stays unconditional across binding transitions", () => {
  it("embedded: binding a chat then clearing it must not crash the render", async () => {
    render(<DevDiffPanel embedded />);
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());

    // Clear the binding mid-test: bindKey falls back to null and the panel
    // renders its embedded empty state.
    act(() => {
      useChatStore.setState({ activeChatSessionId: null, sessionProjects: {} });
    });
    expect(screen.getByText(/Select a project/i)).toBeTruthy();
  });

  it("standalone: focusing a pane then collapsing (and unbinding) must not crash", async () => {
    render(<DevDiffPanel />);
    act(() => {
      usePanesStore.setState({ panes: [terminalPane as never], focusedPaneId: "term-1" });
    });
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());

    // Collapse → early return strip. Pre-fix the hooks after the return were
    // skipped and React threw.
    act(() => {
      useUiStore.setState({ diffPanelCollapsed: true });
    });
    expect(screen.getByLabelText(/collapsed/i)).toBeTruthy();

    // Unbind entirely → the panel disappears (null render).
    act(() => {
      useUiStore.setState({ diffPanelCollapsed: false });
      usePanesStore.setState({ panes: [], focusedPaneId: null });
    });
    expect(screen.queryByText("a.ts")).toBeNull();
  });
});
