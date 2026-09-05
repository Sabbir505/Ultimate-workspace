// C2 (ISSUES.md): the DevDiffPanel prune effect only kept entries keyed by a
// live paneId or `project:<id>`. The embedded Files tab's chat-fallback
// binding keys its list `chat:<sessionId>` (see bindKey) — matched by neither
// — so EVERY pane-store tick wiped the list while the chat was still alive.
// The keep-set must retain `chat:` keys whose session still exists.
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

const CHAT_SESSION = {
  id: "sess-1",
  title: "t",
  provider: "openai",
  model: "m",
  createdAt: 1,
  lastActiveAt: 2,
};

const browserPane = {
  paneId: "pane-x",
  state: "idle",
  lastUsedAt: 1,
  lastInputAt: 0,
  activity: null,
  data: { kind: "browser", url: "http://localhost", projectId: null, tabs: [{ tabId: "t", url: "http://localhost", title: "t" }], activeTabIndex: 0 },
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
    sessions: [],
    gitStatuses: {},
  });
  useChatStore.setState({
    activeChatSessionId: "sess-1",
    focusedChatSessionId: null,
    splitChatSessionId: null,
    sessions: [CHAT_SESSION as never],
    sessionProjects: { "sess-1": "p1" },
  });
});

afterEach(() => {
  cleanup();
  usePanesStore.setState({ panes: [], focusedPaneId: null });
  useChatStore.setState({ activeChatSessionId: null, focusedChatSessionId: null, sessions: [], sessionProjects: {} });
  useProjectsStore.setState({ projects: [], selectedProjectId: null });
});

describe("DevDiffPanel prune keeps live chat bindings (C2)", () => {
  it("does not clear a chat-keyed file list when the pane store updates", async () => {
    render(<DevDiffPanel embedded />);
    // The list loads under bindKey `chat:sess-1` (embedded, no focused pane).
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());

    // Pane-store ticks (pane opened / closed / refocused) re-run the prune
    // effect. The chat session still exists — its cached list must survive
    // every sweep.
    act(() => usePanesStore.setState({ panes: [browserPane as never] }));
    expect(screen.getByText("a.ts")).toBeTruthy();
    act(() => usePanesStore.setState({ panes: [] }));
    expect(screen.getByText("a.ts")).toBeTruthy();
    act(() => usePanesStore.setState({ panes: [browserPane as never] }));
    expect(screen.getByText("a.ts")).toBeTruthy();
  });
});
