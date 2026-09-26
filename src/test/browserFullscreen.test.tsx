// Full-screen browser pane.
//
// The pane's page is a NATIVE webview (an OS-level child window floating above
// the DOM), so "full screen" is not a CSS paint job: expanding the pane only
// grows the body div, and BrowserPane's ResizeObserver pushes the matching
// rect via browser_set_bounds. That makes OCCLUSION the thing worth testing —
// a full-screen pane must keep its webview VISIBLE even when the tool panel it
// nominally lives in is collapsed or showing another tab, or the user gets a
// full-screen pane with an invisible page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const createTabMock = vi.fn(async () => undefined);
// Typed parameters so `mock.calls[i][n]` indexes resolve.
const boundsMock = vi.fn(
  async (_paneId: string, _tabId: string, _rect: { x: number; y: number; width: number; height: number }) =>
    undefined,
);
const visibleMock = vi.fn(async (_paneId: string, _tabId: string, _visible: boolean) => undefined);

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tauriRuntimeAvailable: () => true,
  browserCreateTab: (...a: unknown[]) => createTabMock(...(a as [])),
  browserSetBoundsTab: (paneId: string, tabId: string, rect: { x: number; y: number; width: number; height: number }) =>
    boundsMock(paneId, tabId, rect),
  browserSetVisibleTab: (paneId: string, tabId: string, visible: boolean) =>
    visibleMock(paneId, tabId, visible),
  browserClosePane: vi.fn(async () => undefined),
  browserCloseTab: vi.fn(async () => undefined),
  registerBrowserPaneProject: vi.fn(async () => undefined),
  unregisterBrowserPaneProject: vi.fn(async () => undefined),
  killPty: vi.fn(async () => undefined),
  listenBrowserNavigatedTab: vi.fn(async () => () => {}),
  listenBrowserTitle: vi.fn(async () => () => {}),
  listenBrowserLoadCompleted: vi.fn(async () => () => {}),
  browserTimeline: vi.fn(async () => []),
}));

import { BrowserPane } from "../components/panes/BrowserPane";
import { PaneFrame } from "../components/panes/PaneFrame";
import { toggleBrowserFullscreen } from "../lib/sessionLauncher";
import { DEFAULT_KEYBINDINGS, matchesAccelerator } from "../lib/keybindings";
import { fullscreenBrowserPane, usePanesStore, type Pane } from "../state/panes";
import { useUiStore } from "../state/ui";

const browserDesc = { kind: "browser" as const, url: "https://example.com", projectId: null };

function paneOf(paneId: string): Pane {
  const pane = usePanesStore.getState().panes.find((p) => p.paneId === paneId);
  if (!pane) throw new Error(`pane ${paneId} missing`);
  return pane;
}

function isFullscreen(paneId: string): boolean {
  const pane = paneOf(paneId);
  return pane.data.kind === "browser" && !!pane.data.fullscreen;
}

/** Mirrors production: the tool panel re-renders from the store on every tick,
 *  so the pane prop is never a stale snapshot. A test that renders
 *  `<BrowserPane pane={paneOf(id)} />` once would freeze the pane's flags. */
function StoreBrowserPane({ paneId }: { paneId: string }) {
  const pane = usePanesStore((s) => s.panes.find((p) => p.paneId === paneId));
  if (!pane) return null;
  return <BrowserPane pane={pane} />;
}

/** Standalone browser pane (not owned by the panes store) for frame tests. */
function standalonePane(extra: Record<string, unknown> = {}): Pane {
  return {
    paneId: "pane-fs",
    state: "idle",
    lastUsedAt: 1,
    lastInputAt: 0,
    activity: null,
    data: {
      kind: "browser",
      url: "https://example.com",
      projectId: null,
      tabs: [{ tabId: "tab-1", url: "https://example.com", title: "Example" }],
      activeTabIndex: 0,
      ...extra,
    },
  };
}

/** Let the native-create promise resolve and the rAF-coalesced bounds push
 *  land, the same way the address-typing test does. */
async function flushLayout() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  usePanesStore.setState({
    panes: [],
    focusedPaneId: null,
    useCounter: 1,
    broadcast: { enabled: false, selected: [] },
  });
  useUiStore.setState({
    openTabs: [],
    nextTabId: 1,
    activeTabId: null,
    activeView: "chat",
    paletteOpen: false,
    modalOpen: false,
    contextTipOpen: false,
    toolPanelTab: "browser",
    toolPanelCollapsed: false,
  });
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  usePanesStore.setState({ panes: [], focusedPaneId: null });
  useUiStore.setState({ openTabs: [], activeTabId: null, toolPanelTab: "terminal" });
});

describe("browser full-screen state", () => {
  it("expands one pane and takes the flag off every other browser pane", () => {
    const a = usePanesStore.getState().addPane(browserDesc);
    const b = usePanesStore.getState().addPane(browserDesc);
    usePanesStore.getState().setBrowserFullscreen(a, true);
    expect(isFullscreen(a)).toBe(true);
    usePanesStore.getState().setBrowserFullscreen(b, true);
    // Two expanded panes would mean two native webviews fighting for the
    // screen — the second one wins outright.
    expect(isFullscreen(a)).toBe(false);
    expect(isFullscreen(b)).toBe(true);
    expect(fullscreenBrowserPane(usePanesStore.getState().panes)?.paneId).toBe(b);
  });

  it("leaves untouched panes on the same object (no re-render churn)", () => {
    const a = usePanesStore.getState().addPane(browserDesc);
    const b = usePanesStore.getState().addPane(browserDesc);
    const before = paneOf(b);
    usePanesStore.getState().setBrowserFullscreen(a, true);
    expect(paneOf(b)).toBe(before);
  });

  it("refuses to expand a minimized pane (it has no chrome left)", () => {
    const paneId = usePanesStore.getState().addPane(browserDesc);
    usePanesStore.getState().toggleBrowserCollapsed(paneId);
    usePanesStore.getState().toggleBrowserFullscreen(paneId);
    expect(paneOf(paneId).data).toMatchObject({ collapsed: true });
    expect(isFullscreen(paneId)).toBe(false);
  });

  it("clearBrowserFullscreen drops the flag on every pane", () => {
    const a = usePanesStore.getState().addPane(browserDesc);
    usePanesStore.getState().setBrowserFullscreen(a, true);
    usePanesStore.getState().clearBrowserFullscreen();
    expect(fullscreenBrowserPane(usePanesStore.getState().panes)).toBeNull();
  });
});

describe("toggleBrowserFullscreen (F11 / palette entry point)", () => {
  it("surfaces the pane's Browser tab and expands the focused browser pane", () => {
    const paneId = usePanesStore.getState().addPane(browserDesc);
    useUiStore.getState().setToolPanelCollapsed(true);
    toggleBrowserFullscreen();
    // A pane whose chip isn't active renders display:none, and a display:none
    // element cannot be the fixed overlay — so surfacing is mandatory.
    expect(useUiStore.getState().toolPanelCollapsed).toBe(false);
    expect(useUiStore.getState().openTabs[0]).toMatchObject({ kind: "browser", paneId });
    expect(useUiStore.getState().activeTabId).toBe(useUiStore.getState().openTabs[0].instanceId);
    expect(isFullscreen(paneId)).toBe(true);
  });

  it("pressing it again exits", () => {
    const paneId = usePanesStore.getState().addPane(browserDesc);
    toggleBrowserFullscreen(paneId);
    expect(isFullscreen(paneId)).toBe(true);
    toggleBrowserFullscreen(paneId);
    expect(isFullscreen(paneId)).toBe(false);
  });

  it("falls back to the most-recently-used browser when nothing is focused", () => {
    usePanesStore.getState().addPane(browserDesc);
    const b = usePanesStore.getState().addPane(browserDesc);
    usePanesStore.getState().focusPane(null);
    toggleBrowserFullscreen();
    expect(isFullscreen(b)).toBe(true);
  });

  it("does nothing when there is no browser pane", () => {
    toggleBrowserFullscreen();
    expect(fullscreenBrowserPane(usePanesStore.getState().panes)).toBeNull();
    expect(useUiStore.getState().openTabs).toHaveLength(0);
  });
});

describe("PaneFrame full-screen rendering", () => {
  it("adds the overlay class and an exit button", () => {
    const { container } = render(
      <PaneFrame pane={standalonePane({ fullscreen: true })} index={0} focused />,
    );
    const pane = container.querySelector(".pane") as HTMLElement;
    expect(pane.classList.contains("pane-fullscreen")).toBe(true);
    expect(container.querySelector(".pane-fs-exit")).toBeTruthy();
  });

  it("ignores `hidden` — a display:none element cannot be a fixed overlay", () => {
    const { container } = render(
      <PaneFrame pane={standalonePane({ fullscreen: true })} index={0} focused hidden />,
    );
    expect((container.querySelector(".pane") as HTMLElement).style.display).toBe("");
  });

  it("still honours `hidden` when not full-screen", () => {
    const { container } = render(
      <PaneFrame pane={standalonePane()} index={0} focused hidden />,
    );
    expect((container.querySelector(".pane") as HTMLElement).style.display).toBe("none");
  });
});

describe("BrowserPane full-screen", () => {
  it("toggles from the URL bar and exits on Escape", async () => {
    const paneId = usePanesStore.getState().addPane(browserDesc);
    const { container } = render(<StoreBrowserPane paneId={paneId} />);
    await flushLayout();

    const btn = container.querySelector(".browser-fs-btn") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(isFullscreen(paneId)).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    // Escape is handled by the pane, not the global keybinding map (a bare
    // "Escape" accelerator there would preventDefault every Escape in the app).
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(isFullscreen(paneId)).toBe(false);
  });

  it("keeps the webview visible while full screen, even with the panel collapsed", async () => {
    const paneId = usePanesStore.getState().addPane(browserDesc);
    usePanesStore.getState().setBrowserFullscreen(paneId, true);
    // The panel it nominally lives in is shut and another tab is on top.
    useUiStore.setState({ toolPanelCollapsed: true, toolPanelTab: "files" });

    render(<StoreBrowserPane paneId={paneId} />);
    await flushLayout();

    expect(visibleMock.mock.calls.some((c) => c[2] === true)).toBe(true);
    // The growing body div still drives browser_set_bounds — that push IS the
    // full-screen resize (jsdom has no layout, so the rect itself is 0x0 here
    // and only the call is observable).
    expect(boundsMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("occludes normally again once full screen is dropped", async () => {
    const paneId = usePanesStore.getState().addPane(browserDesc);
    usePanesStore.getState().setBrowserFullscreen(paneId, true);
    render(<StoreBrowserPane paneId={paneId} />);
    await flushLayout();
    expect(visibleMock.mock.calls.some((c) => c[2] === true)).toBe(true);

    visibleMock.mockClear();
    await act(async () => {
      usePanesStore.getState().setBrowserFullscreen(paneId, false);
      useUiStore.setState({ toolPanelCollapsed: true, toolPanelTab: "files" });
    });
    await flushLayout();
    expect(visibleMock.mock.calls.some((c) => c[2] === true)).toBe(false);
    expect(visibleMock.mock.calls.some((c) => c[2] === false)).toBe(true);
  });
});

describe("F11 accelerator", () => {
  it("is bound to an unmodified F11 and matches it", () => {
    expect(DEFAULT_KEYBINDINGS.browserFullscreen).toBe("F11");
    expect(
      matchesAccelerator("F11", {
        key: "F11",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(true);
  });

  it("does not steal a modified F11 (Shift+F11 etc.)", () => {
    expect(
      matchesAccelerator("F11", {
        key: "F11",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(false);
  });
});
