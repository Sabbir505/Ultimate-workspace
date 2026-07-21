// Regression for "Mod+1..6 focus-pane shortcuts don't work when a terminal is
// focused." Mounts the real useKeybindings handler + real usePanesStore, and an
// xterm-stand-in listener on the terminal's helper-textarea that calls the REAL
// e.stopPropagation() (mimicking xterm's core keydown handler). The capture-phase
// window listener in useKeybindings must still see the keydown and move focus.
//
// Before the fix, useKeybindings registered on window in the BUBBLE phase, so
// xterm's stopPropagation swallowed the event and focus-pane shortcuts never fired.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePanesStore, type PaneDescriptor } from "../state/panes";
import { useSettingsStore } from "../state/settings";
import { useKeybindings } from "../hooks/useKeybindings";
import { render, cleanup } from "@testing-library/react";

function Harness() {
  useKeybindings();
  return null;
}

function terminalDesc(sessionId: string): PaneDescriptor {
  return {
    kind: "terminal",
    sessionId,
    harness: "claude_code",
    label: `session ${sessionId}`,
    spawn: { type: "agent", sessionId },
  };
}

const DEFAULTS = {
  openPalette: "Mod+K", focusPane1: "Mod+1", focusPane2: "Mod+2",
  focusPane3: "Mod+3", focusPane4: "Mod+4", focusPane5: "Mod+5",
  focusPane6: "Mod+6", cyclePane: "Mod+`", newSession: "Mod+N",
  closePane: "Mod+W", toggleBroadcast: "Mod+Shift+B", openSettings: "Mod+,",
  spotlightNext: "Mod+Shift+]", spotlightPrev: "Mod+Shift+[",
};

function fireKey(target: HTMLElement, key: string, mods: { ctrl?: boolean; shift?: boolean } = {}) {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: mods.ctrl ?? true,
    metaKey: false,
    shiftKey: mods.shift ?? false,
    altKey: false,
  });
  Object.defineProperty(e, "target", { value: target });
  target.dispatchEvent(e);
}

describe("focus-pane shortcuts fire even when xterm stopPropagation's the keydown", () => {
  let xtermStub: (e: KeyboardEvent) => void;
  let ta: HTMLTextAreaElement;

  beforeEach(() => {
    useSettingsStore.setState({ keybindings: { ...DEFAULTS } });
    usePanesStore.setState({ panes: [], focusedPaneId: null });
    ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    document.body.appendChild(ta);
    // xterm stand-in: stops propagation on the textarea, exactly like xterm's
    // core keydown handler does for Ctrl-combos.
    xtermStub = (e: KeyboardEvent) => e.stopPropagation();
    ta.addEventListener("keydown", xtermStub);
  });
  afterEach(() => {
    ta.removeEventListener("keydown", xtermStub);
    document.body.removeChild(ta);
    cleanup();
  });

  it("Mod+1 focuses pane 0", () => {
    const a = usePanesStore.getState().addPane(terminalDesc("s1"));
    usePanesStore.getState().addPane(terminalDesc("s2"));
    const panes = usePanesStore.getState().panes;

    render(<Harness />);
    ta.focus();
    fireKey(ta, "1");

    expect(usePanesStore.getState().focusedPaneId).toBe(panes[0].paneId);
    expect(a).toBeDefined();
  });

  it("Mod+2 focuses pane 1", () => {
    usePanesStore.getState().addPane(terminalDesc("s1"));
    usePanesStore.getState().addPane(terminalDesc("s2"));
    const panes = usePanesStore.getState().panes;

    render(<Harness />);
    ta.focus();
    fireKey(ta, "2");

    expect(usePanesStore.getState().focusedPaneId).toBe(panes[1].paneId);
  });

  it("Mod+W (closePane) also survives stopPropagation", () => {
    const a = usePanesStore.getState().addPane(terminalDesc("s1"));
    usePanesStore.getState().addPane(terminalDesc("s2"));
    const panes = usePanesStore.getState().panes;
    // Focus pane 0 first so closePane has a target.
    usePanesStore.getState().focusPane(panes[0].paneId);

    render(<Harness />);
    ta.focus();
    fireKey(ta, "w");

    // Pane 0 was closed; focus moved to the remaining pane.
    expect(usePanesStore.getState().panes.some((p) => p.paneId === a)).toBe(false);
    expect(usePanesStore.getState().focusedPaneId).toBe(panes[1].paneId);
  });
});
