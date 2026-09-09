// Regression: tool-panel "Browser" chips used to be UNBOUND — "+" → Browser
// stacked a second chip that revealed the SAME most-recent pane (with all of
// its tabs) instead of an independent browser. surfaceBrowserTab now binds
// chips to panes (adopting an unbound chip when present), openBrowserPane
// spawns a fresh bound pane when every visible pane already has a chip, and
// panes without a chip (restored at boot, chip closed) are adopted instead of
// duplicated.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  runHarnessLogin: vi.fn().mockResolvedValue(undefined),
  spawnAgentSession: vi.fn().mockResolvedValue(undefined),
  spawnShell: vi.fn().mockResolvedValue(undefined),
  touchSession: vi.fn().mockResolvedValue(undefined),
  killPty: vi.fn().mockResolvedValue(undefined),
  browserClosePane: vi.fn().mockResolvedValue(undefined),
  browserCloseTab: vi.fn().mockResolvedValue(undefined),
  registerBrowserPaneProject: vi.fn().mockResolvedValue(undefined),
  unregisterBrowserPaneProject: vi.fn().mockResolvedValue(undefined),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

import { usePanesStore } from "../state/panes";
import { useUiStore } from "../state/ui";
import { openBrowserPane, surfaceBrowserTab } from "../lib/sessionLauncher";

const browserDesc = { kind: "browser" as const, url: "https://example.com", projectId: null };

function addBrowserPane(): string {
  return usePanesStore.getState().addPane(browserDesc);
}

beforeEach(() => {
  usePanesStore.setState({
    panes: [],
    focusedPaneId: null,
    useCounter: 1,
    broadcast: { enabled: false, selected: [] },
  });
  useUiStore.setState({ openTabs: [], nextTabId: 1, activeTabId: null, toolPanelCollapsed: true });
});

afterEach(() => {
  usePanesStore.setState({ panes: [], focusedPaneId: null });
  useUiStore.setState({ openTabs: [], activeTabId: null });
});

describe("Browser tool-panel chips are bound to panes", () => {
  it("surfaceBrowserTab adds a chip BOUND to the pane and activates it", () => {
    const paneId = addBrowserPane();
    surfaceBrowserTab(paneId);
    const { openTabs, activeTabId } = useUiStore.getState();
    expect(openTabs).toHaveLength(1);
    expect(openTabs[0].kind).toBe("browser");
    expect(openTabs[0].paneId).toBe(paneId);
    expect(activeTabId).toBe(openTabs[0].instanceId);
  });

  it("a second pane gets its own chip — the first chip keeps its binding", () => {
    const a = addBrowserPane();
    const b = addBrowserPane();
    surfaceBrowserTab(a);
    surfaceBrowserTab(b);
    const { openTabs, activeTabId } = useUiStore.getState();
    const chips = openTabs.filter((t) => t.kind === "browser");
    expect(chips).toHaveLength(2);
    expect(openTabs.find((t) => t.paneId === a)).toBeTruthy();
    const active = chips.find((t) => t.instanceId === activeTabId);
    expect(active?.paneId).toBe(b);
  });

  it("an unbound browser chip is adopted (bound) instead of stacking a duplicate", () => {
    const paneId = addBrowserPane();
    useUiStore.getState().addTab("browser"); // legacy unbound chip
    expect(useUiStore.getState().openTabs[0].paneId).toBeUndefined();
    surfaceBrowserTab(paneId);
    const { openTabs, activeTabId } = useUiStore.getState();
    expect(openTabs).toHaveLength(1);
    expect(openTabs[0].paneId).toBe(paneId);
    expect(activeTabId).toBe(openTabs[0].instanceId);
  });

  it("openBrowserPane spawns a fresh pane + bound chip when every pane already has a chip", () => {
    const a = addBrowserPane();
    surfaceBrowserTab(a);
    openBrowserPane();
    const panes = usePanesStore.getState().panes.filter((p) => p.data.kind === "browser");
    expect(panes).toHaveLength(2);
    const chips = useUiStore.getState().openTabs.filter((t) => t.kind === "browser");
    expect(chips).toHaveLength(2);
    expect(new Set(chips.map((c) => c.paneId)).size).toBe(2);
  });

  it("openBrowserPane adopts a visible pane that has no chip (restored at boot)", () => {
    const orphan = addBrowserPane(); // no chip bound
    openBrowserPane();
    const chips = useUiStore.getState().openTabs.filter((t) => t.kind === "browser");
    expect(chips).toHaveLength(1);
    expect(chips[0].paneId).toBe(orphan);
    expect(usePanesStore.getState().panes).toHaveLength(1);
  });
});
