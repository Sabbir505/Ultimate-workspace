// Browser loading indicator semantics.
//
// The spinner was INVERTED: `browser:navigated` fires at navigation START
// (WebView2 NavigationStarting / wry on_navigation) but the handler cleared
// `loading` on it. So the dot appeared for the ~10ms IPC round-trip and then
// vanished for the entire real page load — the exact opposite of what the user
// needs to see.
//
// Two events now carry distinct meanings, and these tests pin that split:
//   browser:navigated   -> a document load BEGAN  => arm the spinner
//   browser:url-changed -> same-document (SPA/hash) => address bar only
//   browser:load-completed -> the load ENDED (success OR failure) => disarm
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const createTabMock = vi.fn(async () => undefined);
type BrowserRect = { x: number; y: number; width: number; height: number };
// Typed parameters so the mock wrappers below can forward arguments.
const boundsMock = vi.fn(
  async (
    _paneId: string,
    _tabId: string,
    _rect: { x: number; y: number; width: number; height: number },
  ) => undefined,
);
const visibleMock = vi.fn(async (_paneId: string, _tabId: string, _visible: boolean) => undefined);
const goBackMock = vi.fn(async (_paneId: string, _tabId: string) => undefined);
const reloadMock = vi.fn(async (_paneId: string, _tabId: string) => undefined);
const navigateMock = vi.fn(async (_paneId: string, _tabId: string, _url: string) => undefined);

/** Captured handlers so a test can deliver a backend event on demand. */
const handlers: {
  navigated?: (p: { paneId: string; tabId: string; url: string }) => void;
  urlChanged?: (p: { paneId: string; tabId: string; url: string }) => void;
  loadCompleted?: (p: { paneId: string; tabId: string; success: boolean }) => void;
  crashed?: (p: { paneId: string; tabId: string; reason: string }) => void;
} = {};

const paneId = (id: string, tab = "t-1") => ({ paneId: id, tabId: tab, success: true });

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tauriRuntimeAvailable: () => true,
  browserCreateTab: (...a: unknown[]) => createTabMock(...(a as [])),
  browserSetBoundsTab: (paneId: string, tabId: string, rect: BrowserRect) => boundsMock(paneId, tabId, rect),
  browserSetVisibleTab: (paneId: string, tabId: string, visible: boolean) => visibleMock(paneId, tabId, visible),
  browserGoBackTab: (paneId: string, tabId: string) => goBackMock(paneId, tabId),
  browserReloadTab: (paneId: string, tabId: string) => reloadMock(paneId, tabId),
  browserNavigateTab: (paneId: string, tabId: string, url: string) => navigateMock(paneId, tabId, url),
  browserClosePane: vi.fn(async () => undefined),
  browserCloseTab: vi.fn(async () => undefined),
  registerBrowserPaneProject: vi.fn(async () => undefined),
  unregisterBrowserPaneProject: vi.fn(async () => undefined),
  killPty: vi.fn(async () => undefined),
  listenBrowserNavigatedTab: vi.fn(async (h: typeof handlers.navigated) => {
    handlers.navigated = h;
    return () => {};
  }),
  listenBrowserUrlChangedTab: vi.fn(async (h: typeof handlers.urlChanged) => {
    handlers.urlChanged = h;
    return () => {};
  }),
  listenBrowserLoadCompleted: vi.fn(async (h: typeof handlers.loadCompleted) => {
    handlers.loadCompleted = h;
    return () => {};
  }),
  listenBrowserCrashed: vi.fn(async (h: typeof handlers.crashed) => {
    handlers.crashed = h;
    return () => {};
  }),
  listenBrowserTitle: vi.fn(async () => () => {}),
  browserTimeline: vi.fn(async () => []),
}));

import { BrowserPane } from "../components/panes/BrowserPane";
import { usePanesStore, type Pane } from "../state/panes";
import { useUiStore } from "../state/ui";

const PANE_ID = "pane-load";
const TAB_ID = "t-1";
const DONE = { paneId: PANE_ID, tabId: TAB_ID, success: true };

function pane(): Pane {
  return {
    paneId: PANE_ID,
    state: "idle",
    lastUsedAt: 1,
    lastInputAt: 0,
    activity: null,
    data: {
      kind: "browser",
      url: "https://example.com",
      projectId: null,
      tabs: [{ tabId: TAB_ID, url: "https://example.com", title: "Example" }],
      activeTabIndex: 0,
    },
  };
}

/** Memoized so the pane object (and its `tabs` array) keeps a stable identity
 *  across re-renders — a fresh array each render re-fires the tab-state
 *  reconcile effect and the assertions stop being about loading at all. */
const HARNESS_PANE = pane();
function Harness() {
  return <BrowserPane pane={HARNESS_PANE} />;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
}

const loadbar = (c: HTMLElement) => c.querySelector(".browser-loadbar") as HTMLElement;
const dot = (c: HTMLElement) => c.querySelector(".browser-spinner") as HTMLElement | null;

beforeEach(() => {
  vi.clearAllMocks();
  delete handlers.navigated;
  delete handlers.urlChanged;
  delete handlers.loadCompleted;
  delete handlers.crashed;
  usePanesStore.setState({ panes: [], focusedPaneId: null });
  useUiStore.setState({
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
});

describe("browser loading indicator", () => {
  it("arms on navigation start and only disarms on load-completed", async () => {
    const { container } = render(<Harness />);
    await settle();
    // A fresh tab starts loading (webview bootstrap).
    expect(loadbar(container).classList.contains("active")).toBe(true);

    // Navigation START must NOT clear it — this is the inverted-spinner bug.
    await act(async () => {
      handlers.navigated?.({ paneId: PANE_ID, tabId: TAB_ID, url: "https://example.com/next" });
    });
    expect(loadbar(container).classList.contains("active")).toBe(true);
    expect(dot(container)).not.toBeNull();

    // Load END is the only thing that clears it.
    await act(async () => {
      handlers.loadCompleted?.(DONE);
    });
    expect(loadbar(container).classList.contains("active")).toBe(false);
    expect(dot(container)).toBeNull();
  });

  it("a same-document URL change updates the bar WITHOUT arming the spinner", async () => {
    const { container } = render(<Harness />);
    await settle();
    await act(async () => {
      handlers.loadCompleted?.(DONE);
    });
    expect(loadbar(container).classList.contains("active")).toBe(false);

    // SPA pushState / hashchange: address bar follows, no document load, and
    // therefore no load-end event will ever arrive to clear a spinner.
    await act(async () => {
      handlers.urlChanged?.({ paneId: PANE_ID, tabId: TAB_ID, url: "https://example.com/app#/inbox" });
    });
    expect(loadbar(container).classList.contains("active")).toBe(false);
    const input = container.querySelector(".browser-urlbar input") as HTMLInputElement;
    expect(input.value).toBe("https://example.com/app#/inbox");
  });

  it("ignores another tab's load-completed", async () => {
    const { container } = render(<Harness />);
    await settle();
    await act(async () => {
      handlers.loadCompleted?.({ paneId: "other-pane", tabId: "zzz", success: true });
    });
    expect(loadbar(container).classList.contains("active")).toBe(true);
  });

  it("parses a label whose ids themselves contain '-tab-'", async () => {
    // The label format is `{pane}-tab-{tab}`, so the separator is the FIRST
    // "-tab-". A greedy parse backtracks to the LAST one and splits
    // "browser-a-tab-b-tab-1" into pane="a-tab-b" / tab="1", which then fails
    // the paneId check and silently drops the load-end event — the spinner
    // sticks on a fully loaded page.
    const { container } = render(
      <BrowserPane
        pane={{
          ...HARNESS_PANE,
          paneId: "a-tab-b",
          data: {
            kind: "browser",
            url: "https://example.com",
            projectId: null,
            tabs: [{ tabId: "t-1", url: "https://example.com", title: "E" }],
            activeTabIndex: 0,
          },
        }}
      />,
    );
    await settle();
    await act(async () => {
      handlers.loadCompleted?.(paneId("a-tab-b"));
    });
    expect(loadbar(container).classList.contains("active")).toBe(false);
  });

  it("disarms on a load the backend reports as FAILED", async () => {
    // The backend used to emit only on success, so a DNS error / refused
    // connection left the spinner running forever.
    const { container } = render(<Harness />);
    await settle();
    await act(async () => {
      handlers.loadCompleted?.({ paneId: PANE_ID, tabId: TAB_ID, success: false });
    });
    expect(loadbar(container).classList.contains("active")).toBe(false);
    expect(container.querySelector(".browser-blocked")).toBeNull();
  });

  it("arms for Back, which used to show no indicator at all", async () => {
    const { container } = render(<Harness />);
    await settle();
    // The native path is what these buttons drive; prove the webview came up
    // (bounds are only pushed for a tab whose nativeOk resolved) before
    // asserting on the native-only branch.
    expect(boundsMock).toHaveBeenCalled();
    await act(async () => {
      handlers.loadCompleted?.(DONE);
    });

    // Give the tab some history first: the button is `disabled` at a single
    // entry, and a disabled button swallows the click. (Forward stays
    // disabled — the local history stack this pane drives is append-only, so
    // there is no forward entry until a back actually happens in-webview.)
    await act(async () => {
      handlers.navigated?.({ paneId: PANE_ID, tabId: TAB_ID, url: "https://example.com/2" });
    });
    await act(async () => {
      handlers.loadCompleted?.(DONE);
    });

    const back = (Array.from(
      container.querySelectorAll(".browser-urlbar button"),
    ) as HTMLButtonElement[]).find((b) => b.textContent === "←")!;
    expect(back.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(back);
    });
    expect(goBackMock).toHaveBeenCalledWith(PANE_ID, TAB_ID);
    expect(loadbar(container).classList.contains("active")).toBe(true);

    // And the load-end event disarms it again.
    await act(async () => {
      handlers.loadCompleted?.(DONE);
    });
    expect(loadbar(container).classList.contains("active")).toBe(false);
  });

  it("Reload keeps the spinner up past the IPC resolving", async () => {
    // The `.finally(clear)` on browserReloadTab resolved when `Navigate` was
    // CALLED, not when the page finished — a one-frame indicator.
    const { container } = render(<Harness />);
    await settle();
    await act(async () => {
      handlers.loadCompleted?.(DONE);
    });

    const reload = (Array.from(container.querySelectorAll(".browser-urlbar button")) as HTMLButtonElement[])
      .find((b) => b.textContent === "↻")!;
    await act(async () => {
      fireEvent.click(reload);
    });
    expect(reloadMock).toHaveBeenCalled();
    expect(loadbar(container).classList.contains("active")).toBe(true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Still loading: the page hasn't finished.
    expect(loadbar(container).classList.contains("active")).toBe(true);
  });

  it("typing a URL arms the spinner and the load-end event disarms it", async () => {
    const { container } = render(<Harness />);
    await settle();
    await act(async () => {
      handlers.loadCompleted?.(DONE);
    });

    const input = container.querySelector(".browser-urlbar input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "localhost:4000/a" } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(navigateMock).toHaveBeenCalledWith(PANE_ID, TAB_ID, "http://localhost:4000/a");
    expect(loadbar(container).classList.contains("active")).toBe(true);

    await act(async () => {
      handlers.loadCompleted?.(DONE);
    });
    expect(loadbar(container).classList.contains("active")).toBe(false);
  });

  // Crash recovery (Windows renderer died): the pane shows the crash card
  // with a Recover button; clicking it closes the dead native webview and
  // resets the tab so the create path spins up a fresh one at the same URL.
  it("shows the crash card on browser:crashed and recovers the tab", async () => {
    const closeTabMock = vi.fn(async () => undefined);
    // re-patch the module mock for this test: vi.mocked on the imported fn
    const { browserCloseTab } = await import("../lib/ipc");
    (browserCloseTab as ReturnType<typeof vi.fn>).mockImplementation(closeTabMock);

    const { container } = render(<Harness />);
    await settle();
    expect(document.querySelector(".browser-crashed")).toBeNull();

    await act(async () => {
      handlers.crashed?.({ paneId: PANE_ID, tabId: TAB_ID, reason: "renderer exited" });
    });
    const card = document.querySelector(".browser-crashed") as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("renderer exited");

    fireEvent.click(document.querySelector<HTMLElement>("[data-testid=\"browser-recover\"]")!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(closeTabMock).toHaveBeenCalledWith(PANE_ID, TAB_ID);
    // The card is gone (state reset; the create effect re-creates the view).
    expect(document.querySelector(".browser-crashed")).toBeNull();
  });
});
