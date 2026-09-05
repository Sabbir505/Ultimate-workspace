// C6 (ISSUES.md): every address-bar keystroke swapped the `tabStates` Map —
// a dependency of BOTH the native-bounds effect (debounced
// browser_set_bounds) and the occlusion effect (browser_set_visible per tab)
// — so typing a URL spammed layout IPC. Typed text now lives in a separate
// per-tab draft (dropped on navigate / real navigation), so keystrokes must
// not invoke any bounds/visibility IPC, while display + Enter-submit still
// work.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const createTabMock = vi.fn(async () => undefined);
const boundsMock = vi.fn(async () => undefined);
const visibleMock = vi.fn(async () => undefined);
const navigateMock = vi.fn(async () => undefined);

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Force the NATIVE path (iframe fallback never calls the bounds IPC).
  tauriRuntimeAvailable: () => true,
  browserCreateTab: (...a: unknown[]) => createTabMock(...(a as [])),
  browserSetBoundsTab: (...a: unknown[]) => boundsMock(...(a as [])),
  browserSetVisibleTab: (...a: unknown[]) => visibleMock(...(a as [])),
  browserNavigateTab: (...a: unknown[]) => navigateMock(...(a as [])),
  listenBrowserNavigatedTab: vi.fn(async () => () => {}),
  listenBrowserTitle: vi.fn(async () => () => {}),
  listenBrowserLoadCompleted: vi.fn(async () => () => {}),
  browserTimeline: vi.fn(async () => []),
}));

import { BrowserPane } from "../components/panes/BrowserPane";
import { useUiStore } from "../state/ui";
import type { Pane } from "../../src/state/panes";

const PANE: Pane = {
  paneId: "pane-b1",
  state: "idle",
  lastUsedAt: 1,
  lastInputAt: 0,
  activity: null,
  data: {
    kind: "browser",
    url: "http://localhost:3000",
    projectId: null,
    tabs: [{ tabId: "tab-1", url: "http://localhost:3000", title: "Local" }],
    activeTabIndex: 0,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
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

describe("BrowserPane address typing does not spam layout IPC (C6)", () => {
  it("invokes no bounds/visible IPC while typing, and Enter still navigates", async () => {
    const { container } = render(<BrowserPane pane={PANE} />);

    // Native webview create resolves → nativeOk true → the initial layout
    // sync runs (bounds effect + occlusion effect). Flush promises + timers.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    const boundsBefore = boundsMock.mock.calls.length;
    const visibleBefore = visibleMock.mock.calls.length;
    expect(boundsBefore).toBeGreaterThan(0);
    expect(visibleBefore).toBeGreaterThan(0);

    // Type a URL — two keystrokes.
    const input = container.querySelector(".browser-urlbar input") as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "localhost:4000/a" } });
    });
    act(() => {
      fireEvent.change(input, { target: { value: "localhost:4000/ab" } });
    });
    // The typed text is displayed while typing…
    expect(input.value).toBe("localhost:4000/ab");
    // …and well past the 50ms bounds debounce, NO new layout IPC fired.
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(boundsMock.mock.calls.length).toBe(boundsBefore);
    expect(visibleMock.mock.calls.length).toBe(visibleBefore);

    // Enter still submits: normalizeUrl'd navigation into the native tab.
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigateMock).toHaveBeenCalledWith("pane-b1", "tab-1", "http://localhost:4000/ab");
    // Draft dropped after commit — the bar shows the real URL again.
    expect((container.querySelector(".browser-urlbar input") as HTMLInputElement).value).toBe(
      "http://localhost:4000/ab",
    );
  });
});
