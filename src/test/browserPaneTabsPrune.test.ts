// A3 (ISSUES.md): persistBrowserPaneTabs spread `{ ...paneTabs, [paneId]: … }`
// and NOTHING ever deleted from that map — paneIds are fresh UUIDs per pane,
// so every browser pane ever opened left a permanent entry in the persisted
// settings blob (re-parsed in full on every boot). Pane close (and the other
// pane-removal paths: replace, LRU eviction) must prune the paneId.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setSettingMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/ipc", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: (...a: unknown[]) => setSettingMock(...(a as [string, string])),
  killPty: vi.fn().mockResolvedValue(undefined),
  browserClosePane: vi.fn().mockResolvedValue(undefined),
  browserCloseTab: vi.fn().mockResolvedValue(undefined),
  registerBrowserPaneProject: vi.fn().mockResolvedValue(undefined),
  unregisterBrowserPaneProject: vi.fn().mockResolvedValue(undefined),
}));

import { usePanesStore } from "../state/panes";
import { useSettingsStore } from "../state/settings";

const browserDesc = {
  kind: "browser" as const,
  url: "https://example.com",
  projectId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  usePanesStore.setState({ panes: [], focusedPaneId: null, useCounter: 1, broadcast: { enabled: false, selected: [] } });
  useSettingsStore.setState({ browserPaneState: { paneTabs: {} } });
});

afterEach(() => {
  usePanesStore.setState({ panes: [], focusedPaneId: null });
  useSettingsStore.setState({ browserPaneState: { paneTabs: {} } });
});

describe("A3: closed browser panes are pruned from the persisted tab state", () => {
  it("closePane drops the pane's persisted tabs (memory + settings blob)", () => {
    const paneId = usePanesStore.getState().addPane(browserDesc);
    useSettingsStore.getState().persistBrowserPaneTabs(paneId, [{ tabId: "t1", url: "https://example.com", title: "Ex" }], 0);
    expect(useSettingsStore.getState().restoreBrowserPaneTabs(paneId)).not.toBeNull();

    usePanesStore.getState().closePane(paneId);

    expect(useSettingsStore.getState().restoreBrowserPaneTabs(paneId)).toBeNull();
    // The persisted blob is rewritten WITHOUT the closed pane's key.
    const writes = setSettingMock.mock.calls;
    const lastWrite = writes[writes.length - 1]?.[1] as string;
    expect(JSON.parse(lastWrite).paneTabs).not.toHaveProperty(paneId);
  });

  it("replacePane (LRU slot reuse) prunes the replaced pane's entry", () => {
    const old = usePanesStore.getState().addPane(browserDesc);
    useSettingsStore.getState().persistBrowserPaneTabs(old, [], 0);

    usePanesStore.getState().replacePane(old, browserDesc);

    expect(useSettingsStore.getState().restoreBrowserPaneTabs(old)).toBeNull();
  });

  it("opening/closing N panes keeps the paneTabs map bounded (no per-pane growth)", () => {
    for (let i = 0; i < 25; i++) {
      const id = usePanesStore.getState().addPane(browserDesc);
      useSettingsStore.getState().persistBrowserPaneTabs(id, [], 0);
      usePanesStore.getState().closePane(id);
    }
    expect(Object.keys(useSettingsStore.getState().browserPaneState.paneTabs)).toHaveLength(0);
  });

  it("a live pane's persisted tabs survive another pane closing", () => {
    const keep = usePanesStore.getState().addPane(browserDesc);
    const drop = usePanesStore.getState().addPane(browserDesc);
    useSettingsStore.getState().persistBrowserPaneTabs(keep, [], 0);
    useSettingsStore.getState().persistBrowserPaneTabs(drop, [], 0);

    usePanesStore.getState().closePane(drop);

    expect(useSettingsStore.getState().restoreBrowserPaneTabs(keep)).not.toBeNull();
    expect(useSettingsStore.getState().restoreBrowserPaneTabs(drop)).toBeNull();
  });
});
