// Tests for workspaceRestore: pane-grid autosave + restore.
//   1. serialize/parse round-trip (agent, shell, browser; login dropped)
//   2. autosave: debounced write of the "__autosave__" workspace row for the
//      selected project
//   3. restore: rebuilds panes (respawn agent/shell, browser tabs) and skips
//      panes whose session was deleted
//   4. restore-on-select: selecting a project with an EMPTY grid restores its
//      layout once per app run; selecting with a live grid never wipes it
//   5. boot: lastSelectedId setting re-selects the project after load
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
  listWorkspaces: vi.fn().mockResolvedValue(null),
  saveWorkspace: vi.fn().mockResolvedValue(null),
  spawnAgentSession: vi.fn().mockResolvedValue(undefined),
  spawnShell: vi.fn().mockResolvedValue(undefined),
  runHarnessLogin: vi.fn().mockResolvedValue(undefined),
  killPty: vi.fn().mockResolvedValue(undefined),
  browserClosePane: vi.fn().mockResolvedValue(undefined),
  browserCloseTab: vi.fn().mockResolvedValue(undefined),
  registerBrowserPaneProject: vi.fn().mockResolvedValue(undefined),
  unregisterBrowserPaneProject: vi.fn().mockResolvedValue(undefined),
}));

const ipc = await import("../lib/ipc");
const saveMock = vi.mocked(ipc.saveWorkspace);
const listWsMock = vi.mocked(ipc.listWorkspaces);
const getSettingMock = vi.mocked(ipc.getSetting);
const spawnAgentMock = vi.mocked(ipc.spawnAgentSession);
const spawnShellMock = vi.mocked(ipc.spawnShell);

import { usePanesStore } from "../state/panes";
import { useProjectsStore } from "../state/projects";
import {
  AUTOSAVE_WORKSPACE_NAME,
  initWorkspacePersistence,
  parseSnapshot,
  restoreLayout,
  serializePanes,
  _resetWorkspacePersistenceForTests,
} from "../lib/workspaceRestore";

function seedProjects() {
  useProjectsStore.setState({
    projects: [
      { id: "pA", name: "A", path: "D:/a" } as never,
      { id: "pB", name: "B", path: "D:/b" } as never,
    ],
    sessions: [
      {
        id: "sess-1",
        projectId: "pA",
        harness: "claude_code",
        title: "agent run",
        createdAt: 0,
        lastActiveAt: 0,
      } as never,
    ],
    loaded: true,
    selectedProjectId: null,
  });
}

beforeEach(() => {
  _resetWorkspacePersistenceForTests();
  // resetAllMocks (not clearAllMocks): a mockResolvedValue set in one test
  // must not leak into the next — e.g. a saved-layout row for pA would
  // otherwise still be "on disk" in a later test that expects none.
  vi.resetAllMocks();
  // Re-arm safe defaults: the panes store calls these fire-and-forget with
  // .catch(), so they must return promises, not undefined.
  vi.mocked(ipc.spawnAgentSession).mockResolvedValue(undefined);
  vi.mocked(ipc.spawnShell).mockResolvedValue(undefined);
  vi.mocked(ipc.runHarnessLogin).mockResolvedValue(undefined);
  vi.mocked(ipc.killPty).mockResolvedValue(undefined);
  vi.mocked(ipc.browserClosePane).mockResolvedValue(undefined);
  vi.mocked(ipc.browserCloseTab).mockResolvedValue(undefined);
  vi.mocked(ipc.registerBrowserPaneProject).mockResolvedValue(undefined);
  vi.mocked(ipc.unregisterBrowserPaneProject).mockResolvedValue(undefined);
  vi.mocked(ipc.setSetting).mockResolvedValue(undefined);
  saveMock.mockResolvedValue(null as never);
  listWsMock.mockResolvedValue(null);
  getSettingMock.mockResolvedValue(null);
  seedProjects();
  usePanesStore.setState({
    panes: [],
    focusedPaneId: null,
    broadcast: { enabled: false, selected: [] },
    useCounter: 1,
    paneMemory: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("serializePanes / parseSnapshot", () => {
  it("round-trips agent, shell, and browser panes; drops login panes", () => {
    const store = usePanesStore.getState();
    store.addPane({
      kind: "terminal",
      sessionId: "sess-1",
      harness: "claude_code",
      label: "agent run · A",
      spawn: { type: "agent", sessionId: "sess-1" },
    });
    store.addPane({
      kind: "terminal",
      sessionId: null,
      harness: null,
      label: "Terminal",
      spawn: { type: "shell", cwd: "D:/a", command: "powershell.exe" },
    });
    store.addPane({
      kind: "terminal",
      sessionId: null,
      harness: "claude_code",
      label: "Login",
      spawn: { type: "login", harnessId: "claude_code", cwd: "D:/a" },
    });
    const browserId = store.addPane({ kind: "browser", url: "https://example.com", projectId: "pA" });
    store.addBrowserTab(browserId, "https://two.example.com");

    const snap = serializePanes(usePanesStore.getState().panes);
    expect(snap.v).toBe(1);
    expect(snap.panes).toHaveLength(3); // login dropped
    expect(snap.panes[0]).toMatchObject({ kind: "terminal-agent", sessionId: "sess-1" });
    expect(snap.panes[1]).toMatchObject({ kind: "terminal-shell", cwd: "D:/a" });
    expect(snap.panes[2]).toMatchObject({
      kind: "browser",
      tabs: ["https://example.com", "https://two.example.com"],
    });

    const back = parseSnapshot(JSON.stringify(snap));
    expect(back).toEqual(snap);
  });

  it("parseSnapshot rejects malformed payloads instead of throwing", () => {
    expect(parseSnapshot("not json")).toBeNull();
    expect(parseSnapshot(JSON.stringify({ v: 99, panes: [] }))).toBeNull();
    expect(parseSnapshot(JSON.stringify({ v: 1 }))).toBeNull();
  });
});

describe("autosave", () => {
  it("debounces pane mutations into one workspace write for the selected project", async () => {
    vi.useFakeTimers();
    getSettingMock.mockResolvedValue(null);
    await initWorkspacePersistence();

    useProjectsStore.getState().selectProject("pA");
    const store = usePanesStore.getState();
    store.addPane({
      kind: "terminal",
      sessionId: "sess-1",
      harness: "claude_code",
      label: "agent",
      spawn: { type: "agent", sessionId: "sess-1" },
    });
    store.focusPane(usePanesStore.getState().panes[0].paneId); // second mutation, same burst

    await vi.advanceTimersByTimeAsync(1000);
    expect(saveMock).toHaveBeenCalledTimes(1);
    const [projectId, name, data] = saveMock.mock.calls[0];
    expect(projectId).toBe("pA");
    expect(name).toBe(AUTOSAVE_WORKSPACE_NAME);
    expect(JSON.parse(data).panes).toHaveLength(1);
  });

  it("does not save while no project is selected", async () => {
    vi.useFakeTimers();
    getSettingMock.mockResolvedValue(null);
    await initWorkspacePersistence();

    usePanesStore.getState().addPane({
      kind: "terminal",
      sessionId: null,
      harness: null,
      label: "Terminal",
      spawn: { type: "shell", cwd: ".", command: "bash" },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe("restoreLayout", () => {
  it("rebuilds agent + shell + browser panes from the saved snapshot", async () => {
    const snapshot = {
      v: 1,
      panes: [
        { kind: "terminal-agent", sessionId: "sess-1", harness: "claude_code", label: "old" },
        { kind: "terminal-shell", cwd: "D:/a", command: "powershell.exe", label: "Terminal" },
        { kind: "browser", projectId: "pA", tabs: ["https://one.example.com", "https://two.example.com"], activeTabIndex: 1, collapsed: false },
      ],
    };
    listWsMock.mockResolvedValue([
      { id: "w1", projectId: "pA", name: AUTOSAVE_WORKSPACE_NAME, data: JSON.stringify(snapshot), createdAt: 0, updatedAt: 0 },
    ] as never);

    const restored = await restoreLayout("pA");
    expect(restored).toBe(true);

    const panes = usePanesStore.getState().panes;
    expect(panes).toHaveLength(3);
    expect(spawnAgentMock).toHaveBeenCalledWith(expect.any(String), "sess-1");
    expect(spawnShellMock).toHaveBeenCalledWith(expect.any(String), "D:/a", "powershell.exe", undefined);
    const browser = panes.find((p) => p.data.kind === "browser");
    expect(browser?.data.kind === "browser" && browser.data.tabs).toHaveLength(2);
    expect(browser?.data.kind === "browser" && browser.data.activeTabIndex).toBe(1);
  });

  it("skips panes whose session no longer exists", async () => {
    const snapshot = {
      v: 1,
      panes: [{ kind: "terminal-agent", sessionId: "deleted-sess", harness: "claude_code", label: "gone" }],
    };
    listWsMock.mockResolvedValue([
      { id: "w1", projectId: "pA", name: AUTOSAVE_WORKSPACE_NAME, data: JSON.stringify(snapshot), createdAt: 0, updatedAt: 0 },
    ] as never);

    await restoreLayout("pA");
    expect(usePanesStore.getState().panes).toHaveLength(0);
    expect(spawnAgentMock).not.toHaveBeenCalled();
  });

  it("returns false when the project has no autosave row", async () => {
    listWsMock.mockResolvedValue([]);
    expect(await restoreLayout("pA")).toBe(false);
  });
});

describe("restore on project select", () => {
  it("restores the saved layout when selecting a project with an empty grid — once per run", async () => {
    getSettingMock.mockResolvedValue(null);
    const snapshot = { v: 1, panes: [{ kind: "terminal-shell", cwd: "D:/a", command: "bash", label: "T" }] };
    // pA has a saved layout; pB has none.
    listWsMock.mockImplementation(async (projectId: string) =>
      projectId === "pA"
        ? ([
            { id: "w1", projectId: "pA", name: AUTOSAVE_WORKSPACE_NAME, data: JSON.stringify(snapshot), createdAt: 0, updatedAt: 0 },
          ] as never)
        : [],
    );
    await initWorkspacePersistence();

    useProjectsStore.getState().selectProject("pA");
    await vi.waitFor(() => {
      expect(usePanesStore.getState().panes).toHaveLength(1);
    });
    expect(listWsMock).toHaveBeenCalledWith("pA");

    // User closes the pane deliberately, then switches away and back. The
    // switch flushes the now-EMPTY layout for pA (divergence detected), so
    // re-selecting pA must NOT resurrect the restored pane. pB's own select
    // does attempt a restore (empty grid is the trigger), but pB has no
    // saved row, so the grid stays empty.
    usePanesStore.getState().closePane(usePanesStore.getState().panes[0].paneId);
    useProjectsStore.getState().selectProject("pB");
    await new Promise((r) => setTimeout(r, 20));
    useProjectsStore.getState().selectProject("pA");
    await new Promise((r) => setTimeout(r, 20));
    expect(usePanesStore.getState().panes).toHaveLength(0);
    expect(listWsMock).toHaveBeenCalledTimes(2); // pA + pB, each attempted once
    // The deliberate empty layout was persisted for pA on switch-out.
    expect(saveMock).toHaveBeenCalledWith(
      "pA",
      AUTOSAVE_WORKSPACE_NAME,
      JSON.stringify({ v: 1, panes: [] }),
    );
  });

  it("never wipes a live grid on project switch", async () => {
    getSettingMock.mockResolvedValue(null);
    listWsMock.mockResolvedValue(null); // pA has no saved layout
    await initWorkspacePersistence();

    useProjectsStore.getState().selectProject("pA");
    await vi.waitFor(() => expect(listWsMock).toHaveBeenCalledTimes(1));
    usePanesStore.getState().addPane({
      kind: "terminal",
      sessionId: null,
      harness: null,
      label: "T",
      spawn: { type: "shell", cwd: ".", command: "bash" },
    });

    useProjectsStore.getState().selectProject("pB");
    await new Promise((r) => setTimeout(r, 20));
    expect(usePanesStore.getState().panes).toHaveLength(1); // untouched
    expect(listWsMock).toHaveBeenCalledTimes(1); // pB restore never attempted
  });

  it("boot re-selects the last-used project, which triggers the restore", async () => {
    getSettingMock.mockResolvedValue("pB");
    listWsMock.mockResolvedValue(null);
    await initWorkspacePersistence();
    expect(useProjectsStore.getState().selectedProjectId).toBe("pB");
    expect(listWsMock).toHaveBeenCalledWith("pB"); // empty grid → restore attempted
  });
});
