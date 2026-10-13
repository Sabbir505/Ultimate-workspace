// Browser URL bar anatomy (the 2026-10 redesign).
//
// The bar used to be one flat row of text glyphs (← → ↻ ⚙ ⌂ ⧉ ↗) with no
// grouping: history, tools and window actions all had the same visual weight,
// and the address input was a loose sibling fighting them for space. The
// redesign gave it a real browser-bar shell:
//   [ ← → ↻ ]  ( favicon | address | spinner )  ( ⋯ )  [ ⧉ ↗ ⤢ ]
// where the omnibox is the ONLY flexible element and every control is a fixed
// icon button. These tests pin the contract tests and users rely on: the
// address input still lives inside .browser-urlbar, history buttons are
// discoverable by title, and the low-frequency tools (home/devtools) are one
// click deeper in an overflow menu instead of crowding the bar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const navigateMock = vi.fn(async (_paneId: string, _tabId: string, _url: string) => undefined);
const devtoolsMock = vi.fn(async (_paneId: string, _tabId: string) => undefined);

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tauriRuntimeAvailable: () => true,
  browserCreateTab: vi.fn(async () => undefined),
  browserSetBoundsTab: vi.fn(async () => undefined),
  browserSetVisibleTab: vi.fn(async () => undefined),
  browserNavigateTab: (paneId: string, tabId: string, url: string) => navigateMock(paneId, tabId, url),
  browserOpenDevtools: (paneId: string, tabId: string) => devtoolsMock(paneId, tabId),
  browserClosePane: vi.fn(async () => undefined),
  browserCloseTab: vi.fn(async () => undefined),
  registerBrowserPaneProject: vi.fn(async () => undefined),
  unregisterBrowserPaneProject: vi.fn(async () => undefined),
  killPty: vi.fn(async () => undefined),
  listenBrowserNavigatedTab: vi.fn(async () => () => {}),
  listenBrowserUrlChangedTab: vi.fn(async () => () => {}),
  listenBrowserTitle: vi.fn(async () => () => {}),
  listenBrowserLoadCompleted: vi.fn(async () => () => {}),
  listenBrowserCrashed: vi.fn(async () => () => {}),
  browserTimeline: vi.fn(async () => []),
}));

import { BrowserPane } from "../components/panes/BrowserPane";
import { usePanesStore, type Pane } from "../state/panes";
import { useSettingsStore } from "../state/settings";
import { useUiStore } from "../state/ui";

const PANE_ID = "pane-urlbar";
const TAB_ID = "t-1";

function paneWith(faviconUrl?: string): Pane {
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
      tabs: [{ tabId: TAB_ID, url: "https://example.com", title: "Example", faviconUrl }],
      activeTabIndex: 0,
    },
  };
}

/** Memoized per test so the pane keeps a stable identity across re-renders. */
let HARNESS_PANE: Pane;
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

const urlbarButtons = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".browser-urlbar button")) as HTMLButtonElement[];

beforeEach(() => {
  vi.clearAllMocks();
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
  usePanesStore.setState({ panes: [], focusedPaneId: null });
});

describe("browser URL bar", () => {
  it("wraps the address input in the omnibox, not as a loose row sibling", async () => {
    HARNESS_PANE = paneWith();
    const { container } = render(<Harness />);
    await settle();

    const omnibox = container.querySelector(".urlbar-omnibox") as HTMLElement;
    expect(omnibox).toBeTruthy();
    const input = omnibox.querySelector("input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("https://example.com");
    // The old contract .browser-urlbar input still resolves (address-typing
    // tests select through it) — the omnibox keeps it nested, not replaced.
    expect(container.querySelector(".browser-urlbar .urlbar-omnibox input")).toBe(input);
  });

  it("shows the site's favicon in the omnibox when it has one", async () => {
    HARNESS_PANE = paneWith("https://example.com/favicon.ico");
    const { container } = render(<Harness />);
    await settle();

    const favicon = container.querySelector(".urlbar-omnibox .urlbar-favicon") as HTMLImageElement;
    expect(favicon.getAttribute("src")).toBe("https://example.com/favicon.ico");
  });

  it("falls back to a globe glyph when the tab has no favicon", async () => {
    HARNESS_PANE = paneWith();
    const { container } = render(<Harness />);
    await settle();

    expect(container.querySelector(".urlbar-omnibox .urlbar-favicon")).toBeNull();
    // lucide renders an <svg>; the glyph slot is the class-marked one.
    expect(container.querySelector(".urlbar-omnibox .urlbar-site-glyph")).toBeTruthy();
  });

  it("keeps history controls icon-only but discoverable by title", async () => {
    HARNESS_PANE = paneWith();
    const { container } = render(<Harness />);
    await settle();

    const titles = urlbarButtons(container).map((b) => b.title);
    expect(titles).toContain("Back (uses the page's real history)");
    expect(titles).toContain("Forward (uses the page's real history)");
    expect(titles).toContain("Refresh");
    // Right-edge actions stay on the bar itself.
    expect(titles).toContain("Copy URL");
    expect(titles).toContain("Open in external browser");
    expect(titles).toContain("Full screen");
    // Every control is a fixed icon button (no text-glyph rows left).
    for (const b of urlbarButtons(container)) {
      expect(b.classList.contains("urlbar-btn")).toBe(true);
      expect(b.textContent).toBe("");
    }
  });

  it("moves home and devtools into an overflow menu that opens and closes", async () => {
    HARNESS_PANE = paneWith();
    const { container } = render(<Harness />);
    await settle();

    const more = container.querySelector(".urlbar-overflow button") as HTMLButtonElement;
    expect(more.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      fireEvent.click(more);
    });
    const menu = container.querySelector(".urlbar-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(more.getAttribute("aria-expanded")).toBe("true");

    const home = Array.from(menu.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Home"),
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(home);
    });
    // Home navigates to the project's last-browser-URL from settings.
    const expected = useSettingsStore.getState().lastBrowserUrl(null);
    expect(navigateMock).toHaveBeenCalledWith(PANE_ID, TAB_ID, expected);
    expect(container.querySelector(".urlbar-menu")).toBeNull();

    // DevTools lives in the same menu.
    await act(async () => {
      fireEvent.click(more);
    });
    const devtools = Array.from(
      (container.querySelector(".urlbar-menu") as HTMLElement).querySelectorAll("button"),
    ).find((b) => b.textContent?.includes("DevTools")) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(devtools);
    });
    expect(devtoolsMock).toHaveBeenCalledWith(PANE_ID, TAB_ID);
  });

  it("closes the overflow menu on Escape", async () => {
    HARNESS_PANE = paneWith();
    const { container } = render(<Harness />);
    await settle();

    await act(async () => {
      fireEvent.click(container.querySelector(".urlbar-overflow button") as HTMLButtonElement);
    });
    expect(container.querySelector(".urlbar-menu")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(container.querySelector(".urlbar-menu")).toBeNull();
  });
});
