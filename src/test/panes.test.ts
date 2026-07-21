import { beforeEach, describe, expect, it } from "vitest";
import {
  broadcastTargets,
  MAX_PANES,
  selectLruPane,
  toggleBroadcastSelection,
  usePanesStore,
  type Pane,
  type PaneDescriptor,
} from "../state/panes";

function terminalDesc(sessionId: string): PaneDescriptor {
  return {
    kind: "terminal",
    sessionId,
    harness: "claude_code",
    label: `session ${sessionId}`,
    spawn: { type: "agent", sessionId },
  };
}

function browserDesc(): PaneDescriptor {
  return { kind: "browser", url: "http://localhost:3000", projectId: null };
}

function makePane(paneId: string, lastUsedAt: number, kind: "terminal" | "browser" = "terminal"): Pane {
  return {
    paneId,
    state: "idle",
    lastUsedAt,
    lastInputAt: 0,
    data:
      kind === "terminal"
        ? {
            kind: "terminal",
            sessionId: paneId,
            harness: "claude_code",
            label: paneId,
            spawn: { type: "agent", sessionId: paneId },
            exited: false,
            exitCode: null,
          }
        : {
            kind: "browser",
            url: "http://localhost:3000",
            projectId: null,
            collapsed: false,
            tabs: [{ tabId: "default", url: "http://localhost:3000", title: "" }],
            activeTabIndex: 0,
          },
  };
}

beforeEach(() => {
  usePanesStore.setState({
    panes: [],
    focusedPaneId: null,
    broadcast: { enabled: false, selected: [] },
    useCounter: 1,
  });
});

describe("broadcast selection", () => {
  it("toggle adds and removes pane ids", () => {
    expect(toggleBroadcastSelection([], "a")).toEqual(["a"]);
    expect(toggleBroadcastSelection(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleBroadcastSelection(["a"], "b")).toEqual(["a", "b"]);
  });

  it("store toggle works and select-all only picks terminal panes", () => {
    const store = usePanesStore.getState();
    const t1 = store.addPane(terminalDesc("s1"));
    const b1 = store.addPane(browserDesc());
    const t2 = store.addPane(terminalDesc("s2"));

    usePanesStore.getState().setBroadcastEnabled(true);
    usePanesStore.getState().toggleBroadcastPane(t1);
    expect(usePanesStore.getState().broadcast.selected).toEqual([t1]);

    usePanesStore.getState().selectAllBroadcast();
    const selected = usePanesStore.getState().broadcast.selected;
    expect(selected).toContain(t1);
    expect(selected).toContain(t2);
    expect(selected).not.toContain(b1); // browsers can't receive input
  });

  it("broadcastTargets returns only selected terminal panes", () => {
    const panes = [makePane("t1", 1), makePane("b1", 2, "browser"), makePane("t2", 3)];
    const targets = broadcastTargets(panes, ["t1", "b1"]);
    expect(targets.map((p) => p.paneId)).toEqual(["t1"]);
  });

  it("disabling broadcast clears the selection", () => {
    const store = usePanesStore.getState();
    const t1 = store.addPane(terminalDesc("s1"));
    usePanesStore.getState().setBroadcastEnabled(true);
    usePanesStore.getState().toggleBroadcastPane(t1);
    usePanesStore.getState().setBroadcastEnabled(false);
    expect(usePanesStore.getState().broadcast).toEqual({ enabled: false, selected: [] });
  });

  it("closing a pane removes it from the selection", () => {
    const store = usePanesStore.getState();
    const t1 = store.addPane(terminalDesc("s1"));
    usePanesStore.getState().setBroadcastEnabled(true);
    usePanesStore.getState().toggleBroadcastPane(t1);
    usePanesStore.getState().closePane(t1);
    expect(usePanesStore.getState().broadcast.selected).toEqual([]);
  });
});

describe("LRU pane replacement", () => {
  it("selectLruPane picks the least-recently-used pane", () => {
    const panes = [makePane("a", 5), makePane("b", 2), makePane("c", 9)];
    expect(selectLruPane(panes)?.paneId).toBe("b");
  });

  it("returns null for an empty grid", () => {
    expect(selectLruPane([])).toBeNull();
  });

  it("focusing a pane makes it most-recently-used", () => {
    const store = usePanesStore.getState();
    const ids = ["s1", "s2", "s3"].map((s) => store.addPane(terminalDesc(s)));
    // Focus order: last added (s3) is focused by addPane. Now focus s1.
    usePanesStore.getState().focusPane(ids[0]);
    const lru = selectLruPane(usePanesStore.getState().panes);
    expect(lru?.paneId).toBe(ids[1]); // s2 is now least recently used
  });

  it("grid never exceeds MAX_PANES", () => {
    const store = usePanesStore.getState();
    for (let i = 0; i < MAX_PANES + 2; i++) store.addPane(terminalDesc(`s${i}`));
    expect(usePanesStore.getState().panes.length).toBe(MAX_PANES);
  });

  it("replacePane swaps the slot content and focuses the new pane", () => {
    const store = usePanesStore.getState();
    const victim = store.addPane(terminalDesc("old"));
    usePanesStore.getState().replacePane(victim, terminalDesc("new"));
    const panes = usePanesStore.getState().panes;
    expect(panes.length).toBe(1);
    expect(panes[0].data.kind === "terminal" && panes[0].data.sessionId).toBe("new");
    expect(usePanesStore.getState().focusedPaneId).toBe(panes[0].paneId);
  });
});

describe("focus and close", () => {
  it("addPane focuses the new pane", () => {
    const store = usePanesStore.getState();
    const id = store.addPane(terminalDesc("s1"));
    expect(usePanesStore.getState().focusedPaneId).toBe(id);
  });

  it("cycleFocus wraps around", () => {
    const store = usePanesStore.getState();
    const a = store.addPane(terminalDesc("s1"));
    const b = store.addPane(terminalDesc("s2"));
    expect(usePanesStore.getState().focusedPaneId).toBe(b);
    usePanesStore.getState().cycleFocus();
    expect(usePanesStore.getState().focusedPaneId).toBe(a);
    usePanesStore.getState().cycleFocus();
    expect(usePanesStore.getState().focusedPaneId).toBe(b);
  });

  it("focusPaneByIndex focuses panes 1..6", () => {
    const store = usePanesStore.getState();
    const a = store.addPane(terminalDesc("s1"));
    store.addPane(terminalDesc("s2"));
    usePanesStore.getState().focusPaneByIndex(0);
    expect(usePanesStore.getState().focusedPaneId).toBe(a);
    usePanesStore.getState().focusPaneByIndex(9); // out of range: no crash
    expect(usePanesStore.getState().focusedPaneId).toBe(a);
  });

  it("closing the focused pane moves focus to a remaining pane", () => {
    const store = usePanesStore.getState();
    const a = store.addPane(terminalDesc("s1"));
    const b = store.addPane(terminalDesc("s2"));
    usePanesStore.getState().closePane(b); // b was focused
    expect(usePanesStore.getState().focusedPaneId).toBe(a);
  });
});

describe("minimized browsers don't occupy a slot", () => {
  beforeEach(() => usePanesStore.getState().panes.splice(0));

  it("a minimized browser does NOT count against MAX_PANES", () => {
    const store = usePanesStore.getState();
    // Fill the visible grid with 5 terminals + 1 browser (6 visible).
    for (let i = 0; i < 5; i++) store.addPane(terminalDesc(`t${i}`));
    const browserId = store.addPane(browserDesc());
    expect(usePanesStore.getState().panes.length).toBe(MAX_PANES); // 6 visible
    // Minimize the browser — it leaves the layout but stays in the array.
    usePanesStore.getState().toggleBrowserCollapsed(browserId);
    expect(usePanesStore.getState().panes.length).toBe(MAX_PANES); // still 6 in array
    // A 6th terminal now fits — the minimized browser freed its slot.
    store.addPane(terminalDesc("extra"));
    const panes = usePanesStore.getState().panes;
    const terminals = panes.filter((p) => p.data.kind === "terminal");
    const minimizedBrowsers = panes.filter(
      (p) => p.data.kind === "browser" && p.data.collapsed,
    );
    expect(terminals.length).toBe(MAX_PANES); // 6 CLI panes
    expect(minimizedBrowsers.length).toBe(1); // browser still alive, parked
  });

  it("selectLruPane never returns a minimized browser", () => {
    const store = usePanesStore.getState();
    const tId = store.addPane(terminalDesc("t1"));
    const bId = store.addPane(browserDesc());
    // Minimize the browser, then leave it alone so it's the globally oldest pane.
    usePanesStore.getState().toggleBrowserCollapsed(bId);
    usePanesStore.getState().focusPane(tId); // make the terminal more recently used
    const lru = selectLruPane(usePanesStore.getState().panes);
    expect(lru).not.toBeNull();
    expect(lru?.paneId).not.toBe(bId); // never the minimized browser
  });
});
