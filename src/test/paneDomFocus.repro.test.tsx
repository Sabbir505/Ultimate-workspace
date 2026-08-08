// Regression for "focusing a pane via shortcut should move DOM focus (typing/
// scrolling) to that pane, not just the visual highlight." Mounts REAL
// TerminalPane components (with real xterm instances) and asserts that after
// focusPane moves focusedPaneId, document.activeElement becomes the
// newly-focused terminal's xterm helper-textarea.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { PaneGrid } from "../components/panes/PaneGrid";
import { useKeybindings } from "../hooks/useKeybindings";
import { usePanesStore, type PaneDescriptor } from "../state/panes";
import { useSettingsStore } from "../state/settings";
import { DEFAULT_KEYBINDINGS } from "../lib/keybindings";

// jsdom doesn't implement matchMedia or ResizeObserver, both of which xterm /
// TerminalPane rely on during mount. Polyfill minimal stubs.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function terminalDesc(sessionId: string): PaneDescriptor {
  return {
    kind: "terminal",
    sessionId,
    harness: "claude_code",
    label: `session ${sessionId}`,
    spawn: { type: "agent", sessionId },
  };
}

function HarnessWithShortcuts() {
  useKeybindings();
  return <PaneGrid />;
}

describe("pane focus moves DOM focus to the terminal", () => {
  afterEach(() => {
    usePanesStore.setState({ panes: [], focusedPaneId: null });
    cleanup();
  });

  it("focusPane moves document.activeElement to the target terminal's textarea", async () => {
    // Pin theme to avoid the system-theme path (jsdom lacks window.matchMedia).
    useSettingsStore.setState({ theme: "dark" });
    const a = usePanesStore.getState().addPane(terminalDesc("s1"));
    const b = usePanesStore.getState().addPane(terminalDesc("s2"));
    // addPane focuses the newest (b). Confirm DOM focus is on b's textarea.
    const { container } = render(<PaneGrid />);

    // TerminalPane is lazy-loaded (xterm stays out of the initial bundle), so
    // the chunk resolves asynchronously — wait for both xterm instances to
    // mount + their focus effect to run instead of assuming a fixed tick.
    const textareas = () => container.querySelectorAll("textarea.xterm-helper-textarea");
    await waitFor(() => expect(textareas().length).toBe(2));
    const tas = textareas();
    // Initially b is focused.
    expect(document.activeElement).toBe(tas[1]);

    // Now focus pane a via the store (same path Mod+1 takes).
    act(() => {
      usePanesStore.getState().focusPane(a);
    });

    // After the focused-effect re-runs, DOM focus should be on a's textarea.
    expect(document.activeElement).toBe(tas[0]);
    expect(usePanesStore.getState().focusedPaneId).toBe(a);
    expect(b).toBeDefined();
  });

  it("pressing Mod+1 (Ctrl+1) moves DOM focus to pane 0's terminal even when xterm stopPropagation's the keydown", async () => {
    useSettingsStore.setState({ theme: "dark", keybindings: { ...DEFAULT_KEYBINDINGS } });
    const a = usePanesStore.getState().addPane(terminalDesc("s1"));
    usePanesStore.getState().addPane(terminalDesc("s2")); // newest is focused
    const { container } = render(<HarnessWithShortcuts />);

    // Wait for the lazy TerminalPane chunk to resolve and both xterm
    // instances to mount (see test above).
    await waitFor(() =>
      expect(container.querySelectorAll("textarea.xterm-helper-textarea").length).toBe(2),
    );
    const tas = container.querySelectorAll("textarea.xterm-helper-textarea");
    // xterm stand-in on the currently-focused pane's textarea: stopPropagation,
    // exactly like xterm's core keydown handler does for Ctrl-combos.
    const focusedTa = tas[1] as HTMLTextAreaElement;
    const xtermStub = (e: Event) => e.stopPropagation();
    focusedTa.addEventListener("keydown", xtermStub);
    focusedTa.focus();
    expect(document.activeElement).toBe(focusedTa);

    // Dispatch the real shortcut: Ctrl+1.
    const e = new KeyboardEvent("keydown", {
      key: "1", bubbles: true, cancelable: true, ctrlKey: true,
    });
    Object.defineProperty(e, "target", { value: focusedTa });
    act(() => focusedTa.dispatchEvent(e));

    // After the capture-phase handler fires focusPaneByIndex(0) and the
    // focused-effect re-runs, DOM focus must be on pane 0's terminal.
    expect(usePanesStore.getState().focusedPaneId).toBe(a);
    expect(document.activeElement).toBe(tas[0]);

    focusedTa.removeEventListener("keydown", xtermStub);
  });

  it("Mod+1 re-runs the focus effect (focusEpoch bump) even when pane 0 is already focused", async () => {
    useSettingsStore.setState({ theme: "dark", keybindings: { ...DEFAULT_KEYBINDINGS } });
    const a = usePanesStore.getState().addPane(terminalDesc("s1"));
    usePanesStore.getState().addPane(terminalDesc("s2"));
    usePanesStore.getState().focusPane(a); // pane 0 already focused
    const { container } = render(<HarnessWithShortcuts />);

    // Wait for the lazy TerminalPane chunk to resolve and both xterm
    // instances to mount (see test above).
    await waitFor(() =>
      expect(container.querySelectorAll("textarea.xterm-helper-textarea").length).toBe(2),
    );
    const tas = container.querySelectorAll("textarea.xterm-helper-textarea");
    const pane0Ta = tas[0] as HTMLTextAreaElement;
    const xtermStub = (e: Event) => e.stopPropagation();
    pane0Ta.addEventListener("keydown", xtermStub);
    pane0Ta.focus();
    const epochBefore = usePanesStore.getState().focusEpoch;
    expect(document.activeElement).toBe(pane0Ta);

    // Press Mod+1 while pane 0 is ALREADY the focused pane.
    const e = new KeyboardEvent("keydown", {
      key: "1", bubbles: true, cancelable: true, ctrlKey: true,
    });
    Object.defineProperty(e, "target", { value: pane0Ta });
    act(() => pane0Ta.dispatchEvent(e));

    // The focus epoch must bump — proving the focus effect re-ran (so DOM
    // focus is re-grabbed even when focusedPaneId didn't change).
    expect(usePanesStore.getState().focusEpoch).toBe(epochBefore + 1);
    expect(document.activeElement).toBe(pane0Ta);

    pane0Ta.removeEventListener("keydown", xtermStub);
  });
});
