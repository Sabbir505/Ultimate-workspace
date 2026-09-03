// Pane store — the heart of the grid. Holds up to 6 pane slots, focus,
// per-pane visual state (§7.3), broadcast-mode selection (§4.5), and LRU
// bookkeeping for the "6 panes full — replace least-recently-used" flow
// (§4.3 step 4).
//
// Lifecycle rule (PRD §6.5, binding): a pane's process is killed ONLY on
// explicit close — never on blur. `closePane` is the single place that calls
// kill_pty for terminal panes.
//
// Multi-tab browser support: each BrowserPaneData holds a `tabs` array and an
// `activeTabIndex`. A pane with 5 tabs still counts as ONE pane against
// MAX_PANES=6. The `url` field is a derived convenience (= active tab's url)
// for backward compat.
import { create } from "zustand";
import { uuid } from "../lib/id";
import { browserClosePane, browserCloseTab, killPty, registerBrowserPaneProject, unregisterBrowserPaneProject } from "../lib/ipc";
import { DEFAULT_BROWSER_URL } from "../lib/browserHistory";
import type { HarnessId, PaneState } from "../types";

export const MAX_PANES = 6;

export type TerminalSpawnSpec =
  | { type: "agent"; sessionId: string }
  | { type: "shell"; cwd: string; command: string; injectSecretsProjectId?: string }
  | { type: "login"; harnessId: HarnessId; cwd: string };

export interface TerminalPaneData {
  kind: "terminal";
  sessionId: string | null; // Conduit session id for agent panes; null for shell/login panes
  harness: HarnessId | null;
  label: string;
  spawn: TerminalSpawnSpec;
  exited: boolean;
  exitCode: number | null;
}

/** Per-tab data stored inside BrowserPaneData.tabs[]. */
export interface BrowserTabData {
  tabId: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

export interface BrowserPaneData {
  kind: "browser";
  url: string; // derived convenience — always equals tabs[activeTabIndex].url
  projectId: string | null; // used to remember the last-used URL per project (§4.6)
  /** Multi-tab tabs array. Every browser pane has at least one default tab. */
  tabs: BrowserTabData[];
  /** Index into tabs[] for the currently visible tab. */
  activeTabIndex: number;
  /** Minimized out of the grid. A minimized browser is EXCLUDED from the
   *  split-vs-grid layout decision and not rendered in the visible grid, so
   *  minimizing returns the layout to the normal up-to-6 CLI grid. Its native
   *  webview stays alive via the dormant panes container (visible=false), and a
   *  toolbar "Browser" button restores it. This is NOT the same as close (✕),
   *  which destroys the webview. */
  collapsed?: boolean;
}

export type PaneKindData = TerminalPaneData | BrowserPaneData;

export interface Pane {
  paneId: string;
  state: PaneState;
  /** Monotonic counter used for LRU ordering; bumped on focus/use. */
  lastUsedAt: number;
  /** Monotonic counter of the last time the user sent input into this pane
   *  (0 = never). Primary signal for the split-layout spotlight default. */
  lastInputAt: number;
  /** Current detected activity (e.g. "Editing 3 files", "Searching codebase").
   *  Set by the terminal pane's output parser; cleared when idle. */
  activity: string | null;
  data: PaneKindData;
}

export type PaneDescriptor =
  | ({ kind: "terminal" } & Omit<TerminalPaneData, "kind" | "exited" | "exitCode">)
  | ({ kind: "browser" } & Omit<BrowserPaneData, "kind" | "tabs" | "activeTabIndex">);

interface BroadcastState {
  enabled: boolean;
  selected: string[]; // paneIds
}

interface PanesState {
  panes: Pane[];
  focusedPaneId: string | null;
  broadcast: BroadcastState;
  useCounter: number;
  /** Incremented every time focus is requested (focusPane / focusPaneByIndex /
   *  cycleFocus). TerminalPane keys its DOM-focus effect on this so that
   *  re-pressing a focus shortcut for the already-focused pane still re-grabs
   *  DOM focus (e.g. after it drifted to the sidebar/body). */
  focusEpoch: number;
  /** Explicit user choice for the split-layout spotlight terminal; null means
   *  "derive from recency" (see activeTerminalId). */
  spotlightOverride: string | null;
  /** Dev-only live memory (bytes) per pane, populated by usePaneMemory's poll.
   *  Empty in production builds (no polling, no chip rendered). */
  paneMemory: Record<string, number>;

  /** Pure add; returns the new paneId. Does not spawn anything. */
  addPane: (desc: PaneDescriptor) => string;
  /** Replace an existing slot (used for the LRU replace flow). */
  replacePane: (paneId: string, desc: PaneDescriptor) => void;
  /** Explicit close — kills the pty for terminal panes, closes ALL tab webviews
   *  for browser panes. */
  closePane: (paneId: string) => void;
  focusPane: (paneId: string | null) => void;
  focusPaneByIndex: (index: number) => void;
  cycleFocus: () => void;
  setPaneState: (paneId: string, state: PaneState) => void;
  markPaneExited: (paneId: string, code: number | null) => void;
  markPaneRespawned: (paneId: string) => void;
  /** Updates the active tab's url (and the derived url field). */
  setBrowserUrl: (paneId: string, url: string, tabId?: string) => void;
  /** Collapse/expand a browser pane (minimize to header bar only). */
  toggleBrowserCollapsed: (paneId: string) => void;
  /** Record that the user sent input into a terminal pane (typing/paste). */
  notePaneInput: (paneId: string) => void;
  /** Set a human-readable activity label for a pane (parsed from terminal output). */
  setPaneActivity: (paneId: string, activity: string | null) => void;
  /** Dev-only: set the latest memory reading (bytes) for a pane. */
  setPaneMemory: (paneId: string, bytes: number) => void;
  setSpotlight: (paneId: string | null) => void;

  // --- Multi-tab browser actions ---
  /** Add a new tab to a browser pane. Returns the new tabId. Auto-switches to it. */
  addBrowserTab: (paneId: string, url: string) => string;
  /** Close a tab. Closes its webview, removes from tabs array. If it was the
   *  last tab, closes the pane. */
  closeBrowserTab: (paneId: string, tabId: string) => void;
  /** Switch to a different tab by index. */
  switchBrowserTab: (paneId: string, tabIndex: number) => void;
  /** Set the title of a specific tab. */
  setBrowserTabTitle: (paneId: string, tabId: string, title: string) => void;
  /** Set a tab's favicon URL (derived from the page URL by the pane when a
   *  title report arrives). */
  setBrowserTabFavicon: (paneId: string, tabId: string, faviconUrl: string) => void;
  /** Update a specific tab's url (used by navigated events targeting a tab). */
  setBrowserTabUrl: (paneId: string, tabId: string, url: string) => void;

  setBroadcastEnabled: (enabled: boolean) => void;
  toggleBroadcastPane: (paneId: string) => void;
  selectAllBroadcast: () => void;
}

/** A minimized browser pane is parked out of the layout (its webview kept
 *  alive via the dormant container) and does NOT count against MAX_PANES —
 *  so minimizing a browser frees its slot for another CLI. Only visible
 *  panes occupy the grid. */
export function isVisiblePane(p: Pane): boolean {
  return !(p.data.kind === "browser" && p.data.collapsed);
}

/** Visible panes (the ones actually rendered in the grid/split). */
export function visiblePanes(panes: Pane[]): Pane[] {
  return panes.filter(isVisiblePane);
}

/** The pane to sacrifice when the grid is full: least-recently-used. Only
 *  considers VISIBLE panes — a minimized browser is never the LRU victim
 *  (it doesn't occupy a slot, and evicting it would kill its live webview). */
export function selectLruPane(panes: Pane[]): Pane | null {
  const visible = visiblePanes(panes);
  if (visible.length === 0) return null;
  return visible.reduce((lru, pane) => (pane.lastUsedAt < lru.lastUsedAt ? pane : lru));
}

/** Broadcast targets: only terminal panes can receive input. */
export function broadcastTargets(panes: Pane[], selected: string[]): Pane[] {
  const selectedSet = new Set(selected);
  return panes.filter((p) => p.data.kind === "terminal" && selectedSet.has(p.paneId));
}

/** Pure toggle for broadcast pane selection (exported for tests). */
export function toggleBroadcastSelection(selected: string[], paneId: string): string[] {
  return selected.includes(paneId)
    ? selected.filter((id) => id !== paneId)
    : [...selected, paneId];
}

// Split-layout spotlight selection (terminal pair picking) lives in its own
// pure module so the store stays focused on state mutation. Re-exported here
// so existing importers (`from "../state/panes"`) keep working.
export {
  terminalPanes,
  activeTerminalId,
  cycleTerminalId,
  activeTerminalPair,
  cycleTerminalPair,
} from "./spotlight";

/** Get the active tab's tabId from a browser pane. */
export function activeTabId(pane: Pane): string {
  if (pane.data.kind !== "browser") return "default";
  const tabs = pane.data.tabs;
  return tabs[pane.data.activeTabIndex]?.tabId ?? "default";
}

/**
 * Tear down a pane's native backend resources: kill the pty for a terminal
 * pane, or close ALL tab webviews for a browser pane. Called from every
 * pane-removal path (closePane, replacePane, addPane's LRU eviction) so the
 * dispose step can never be forgotten — which is what enforces PRD §8 ("no
 * orphaned agent processes after the app closes") at the pane level.
 *
 * INTENTIONAL IMPURITY: this is the one place the otherwise-pure Zustand
 * store reaches into IPC. The coupling is deliberate — disposing resources
 * inseparably from removing the pane is what guarantees a process is never
 * left running behind a dropped paneId. `safeInvoke` no-ops outside the
 * Tauri runtime (jsdom tests, plain `vite dev`), so the store stays unit-
 * testable without mocking IPC. Moving this out to a caller would trade a
 * layering-purity win for an orphaned-process correctness risk — not worth it.
 */
function disposePaneResources(pane: Pane): void {
  if (pane.data.kind === "terminal") {
    void killPty(pane.paneId);
  } else {
    // Browser panes: close ALL tab webviews + unregister from the
    // backend's project-pane registry so the MCP dispatch doesn't
    // try to target a dead pane.
    void browserClosePane(pane.paneId);
    void unregisterBrowserPaneProject(pane.paneId).catch(() => {});
  }
}

/** Get the active tab's url from a browser pane. */
export function activeTabUrl(pane: Pane): string {
  if (pane.data.kind !== "browser") return DEFAULT_BROWSER_URL;
  const tabs = pane.data.tabs;
  return tabs[pane.data.activeTabIndex]?.url ?? pane.data.url;
}

/** Migration: ensure every browser pane has a tabs array with at least one default
 *  tab. Call this at app boot / state hydration. Mutates the panes array in place
 *  and returns it. */
export function ensureBrowserTabs(panes: Pane[]): Pane[] {
  return panes.map((p) => {
    if (p.data.kind !== "browser") return p;
    if (p.data.tabs && p.data.tabs.length > 0 && p.data.activeTabIndex !== undefined) return p;
    const defaultTab: BrowserTabData = {
      tabId: "default",
      url: p.data.url || DEFAULT_BROWSER_URL,
      title: "",
    };
    return {
      ...p,
      data: {
        ...p.data,
        tabs: [defaultTab],
        activeTabIndex: 0,
      },
    };
  });
}

const DEFAULT_BROWSER_TAB = (url: string): BrowserTabData => ({
  tabId: "default",
  url,
  title: "",
});

function makePane(desc: PaneDescriptor, lastUsedAt: number): Pane {
  const base = { paneId: uuid(), state: "idle" as PaneState, lastUsedAt, lastInputAt: 0, activity: null };
  if (desc.kind === "terminal") {
    const { kind: _kind, ...rest } = desc;
    return {
      ...base,
      data: { kind: "terminal", ...rest, exited: false, exitCode: null },
    };
  }
  return {
    ...base,
    data: {
      kind: "browser",
      url: desc.url,
      projectId: desc.projectId,
      collapsed: false,
      tabs: [DEFAULT_BROWSER_TAB(desc.url)],
      activeTabIndex: 0,
    },
  };
}

export const usePanesStore = create<PanesState>((set, get) => ({
  panes: [],
  focusedPaneId: null,
  broadcast: { enabled: false, selected: [] },
  useCounter: 1,
  focusEpoch: 0,
  spotlightOverride: null,
  paneMemory: {},

  addPane: (desc) => {
    const counter = get().useCounter;
    const pane = makePane(desc, counter);
    set((state) => {
      let panes = [...state.panes, pane];
      // Backstop cap on VISIBLE panes only (MAX_PANES). Minimized browsers
      // don't occupy a slot, so they're never evicted here — evicting one
      // would destroy its live webview for no benefit. If we're over cap,
      // drop the least-recently-used visible pane (and dispose its resources).
      const visibleCount = panes.filter(isVisiblePane).length;
      if (visibleCount > MAX_PANES) {
        const victim = selectLruPane(panes);
        if (victim) {
          disposePaneResources(victim);
          panes = panes.filter((p) => p.paneId !== victim.paneId);
        }
      }
      return {
        panes,
        focusedPaneId: pane.paneId,
        useCounter: counter + 1,
      };
    });
    // If this is a browser pane with a projectId, register it so the MCP
    // dispatch (Task #4) can resolve the project to its browser panes.
    if (desc.kind === "browser" && desc.projectId) {
      void registerBrowserPaneProject(pane.paneId, desc.projectId).catch(() => {});
    }
    return pane.paneId;
  },

  replacePane: (paneId, desc) => {
    // Replacing a live pane means explicitly disposing its native resources
    // (PRD §8: never leave an orphaned pty / webview behind a reused slot).
    const old = get().panes.find((p) => p.paneId === paneId);
    if (old) disposePaneResources(old);
    const counter = get().useCounter;
    const replacement = makePane(desc, counter);
    set((state) => ({
      panes: state.panes.map((p) => (p.paneId === paneId ? replacement : p)),
      focusedPaneId: replacement.paneId,
      useCounter: counter + 1,
      broadcast: {
        ...state.broadcast,
        selected: state.broadcast.selected.map((id) => (id === paneId ? replacement.paneId : id)),
      },
    }));
  },

  closePane: (paneId) => {
    const pane = get().panes.find((p) => p.paneId === paneId);
    if (!pane) return;
    // §6.5: this explicit-close path is the ONLY place a pty gets killed.
    // Disposing resources is inseparable from removing the pane so a process
    // can never be orphaned behind a dropped paneId (PRD §8).
    disposePaneResources(pane);
    set((state) => {
      const panes = state.panes.filter((p) => p.paneId !== paneId);
      const paneMemory = { ...state.paneMemory };
      delete paneMemory[paneId];
      // Focus hand-off targets the last VISIBLE pane (same helper
      // focusPaneByIndex indexes with): the raw array still contains
      // minimized browser panes, which are parked out of the layout —
      // focusing one would strand focus on a pane the user can't see.
      const visible = visiblePanes(panes);
      const focusedPaneId =
        state.focusedPaneId === paneId
          ? (visible[visible.length - 1]?.paneId ?? null)
          : state.focusedPaneId;
      return {
        panes,
        paneMemory,
        focusedPaneId,
        spotlightOverride: state.spotlightOverride === paneId ? null : state.spotlightOverride,
        broadcast: {
          ...state.broadcast,
          selected: state.broadcast.selected.filter((id) => id !== paneId),
        },
      };
    });
  },

  focusPane: (paneId) => {
    if (paneId === null) {
      set({ focusedPaneId: null });
      return;
    }
    const counter = get().useCounter;
    set((state) => ({
      focusedPaneId: paneId,
      useCounter: counter + 1,
      focusEpoch: state.focusEpoch + 1,
      panes: state.panes.map((p) => (p.paneId === paneId ? { ...p, lastUsedAt: counter } : p)),
    }));
  },

  focusPaneByIndex: (index) => {
    // Index into VISIBLE panes only (M21): minimized browser panes are
    // parked out of the layout — counting them would focus an invisible
    // pane and let Mod+W kill a live webview the user can't see.
    const pane = visiblePanes(get().panes)[index];
    if (pane) get().focusPane(pane.paneId);
  },

  cycleFocus: () => {
    const { focusedPaneId } = get();
    const visible = visiblePanes(get().panes);
    if (visible.length === 0) return;
    const idx = visible.findIndex((p) => p.paneId === focusedPaneId);
    // idx == -1 when the focused pane was just minimized — start at the top.
    const next = visible[(idx + 1) % visible.length];
    get().focusPane(next.paneId);
  },

  setPaneState: (paneId, state) =>
    set((s) => ({
      panes: s.panes.map((p) => (p.paneId === paneId ? { ...p, state } : p)),
    })),

  markPaneExited: (paneId, code) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.paneId === paneId && p.data.kind === "terminal"
          ? { ...p, state: "idle" as PaneState, data: { ...p.data, exited: true, exitCode: code } }
          : p,
      ),
    })),

  markPaneRespawned: (paneId) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.paneId === paneId && p.data.kind === "terminal"
          ? { ...p, state: "idle" as PaneState, data: { ...p.data, exited: false, exitCode: null } }
          : p,
      ),
    })),

  setBrowserUrl: (paneId, url, tabId) =>
    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.paneId !== paneId || p.data.kind !== "browser") return p;
        const targetTabId = tabId ?? p.data.tabs[p.data.activeTabIndex]?.tabId;
        const newTabs = p.data.tabs.map((t) => (t.tabId === targetTabId ? { ...t, url } : t));
        const activeTab = newTabs[p.data.activeTabIndex];
        return {
          ...p,
          data: {
            ...p.data,
            tabs: newTabs,
            url: activeTab ? activeTab.url : url,
          },
        };
      }),
    })),

  toggleBrowserCollapsed: (paneId) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.paneId === paneId && p.data.kind === "browser"
          ? { ...p, data: { ...p.data, collapsed: !p.data.collapsed } }
          : p,
      ),
    })),

  notePaneInput: (paneId) => {
    const counter = get().useCounter;
    set((state) => ({
      useCounter: counter + 1,
      panes: state.panes.map((p) =>
        p.paneId === paneId ? { ...p, lastInputAt: counter, lastUsedAt: counter } : p,
      ),
    }));
  },

  setPaneActivity: (paneId, activity) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.paneId === paneId ? { ...p, activity } : p,
      ),
    })),

  setPaneMemory: (paneId, bytes) =>
    set((s) => ({ paneMemory: { ...s.paneMemory, [paneId]: bytes } })),

  setSpotlight: (paneId) => {
    set({ spotlightOverride: paneId });
    if (paneId) get().focusPane(paneId);
  },

  // --- Multi-tab browser actions ---

  addBrowserTab: (paneId, url) => {
    const tabId = uuid();
    const tab: BrowserTabData = { tabId, url, title: "" };
    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.paneId !== paneId || p.data.kind !== "browser") return p;
        const newTabs = [...p.data.tabs, tab];
        const newIndex = newTabs.length - 1;
        return {
          ...p,
          data: {
            ...p.data,
            tabs: newTabs,
            activeTabIndex: newIndex,
            url,
          },
        };
      }),
    }));
    return tabId;
  },

  closeBrowserTab: (paneId, tabId) => {
    const pane = get().panes.find((p) => p.paneId === paneId);
    if (!pane || pane.data.kind !== "browser") return;
    const tabs = pane.data.tabs;
    const idx = tabs.findIndex((t) => t.tabId === tabId);
    if (idx === -1) return;

    // Last tab: close the entire pane.
    if (tabs.length <= 1) {
      get().closePane(paneId);
      return;
    }

    // Close this tab's webview, then remove from array.
    void browserCloseTab(paneId, tabId).catch(() => {});

    const newTabs = tabs.filter((t) => t.tabId !== tabId);
    // Adjust activeTabIndex if needed.
    let newActiveIndex = pane.data.activeTabIndex;
    if (idx < newActiveIndex) {
      newActiveIndex -= 1;
    } else if (idx === newActiveIndex) {
      newActiveIndex = Math.min(newActiveIndex, newTabs.length - 1);
    }
    const activeTab = newTabs[newActiveIndex];

    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.paneId !== paneId || p.data.kind !== "browser") return p;
        return {
          ...p,
          data: {
            ...p.data,
            tabs: newTabs,
            activeTabIndex: newActiveIndex,
            url: activeTab ? activeTab.url : p.data.url,
          },
        };
      }),
    }));
  },

  switchBrowserTab: (paneId, tabIndex) =>
    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.paneId !== paneId || p.data.kind !== "browser") return p;
        const tabs = p.data.tabs;
        if (tabIndex < 0 || tabIndex >= tabs.length) return p;
        const activeTab = tabs[tabIndex];
        return {
          ...p,
          data: {
            ...p.data,
            activeTabIndex: tabIndex,
            url: activeTab.url,
          },
        };
      }),
    })),

  setBrowserTabTitle: (paneId, tabId, title) =>
    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.paneId !== paneId || p.data.kind !== "browser") return p;
        return {
          ...p,
          data: {
            ...p.data,
            tabs: p.data.tabs.map((t) => (t.tabId === tabId ? { ...t, title } : t)),
          },
        };
      }),
    })),

  setBrowserTabFavicon: (paneId, tabId, faviconUrl) =>
    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.paneId !== paneId || p.data.kind !== "browser") return p;
        return {
          ...p,
          data: {
            ...p.data,
            tabs: p.data.tabs.map((t) => (t.tabId === tabId ? { ...t, faviconUrl } : t)),
          },
        };
      }),
    })),

  setBrowserTabUrl: (paneId, tabId, url) =>
    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.paneId !== paneId || p.data.kind !== "browser") return p;
        const newTabs = p.data.tabs.map((t) => {
          if (t.tabId !== tabId) return t;
          // A real navigation invalidates the previous page's title/favicon —
          // clear them so the tab never shows the old page's label while the
          // new page loads (the injected bridge reports the new title within
          // moments).
          if (t.url === url) return t;
          return { ...t, url, title: "", faviconUrl: undefined };
        });
        const activeTab = newTabs[p.data.activeTabIndex];
        return {
          ...p,
          data: {
            ...p.data,
            tabs: newTabs,
            url: activeTab ? activeTab.url : url,
          },
        };
      }),
    })),

  setBroadcastEnabled: (enabled) =>
    set((s) => ({
      broadcast: enabled
        ? { enabled: true, selected: s.broadcast.selected }
        : { enabled: false, selected: [] },
    })),

  toggleBroadcastPane: (paneId) =>
    set((s) => ({
      broadcast: { ...s.broadcast, selected: toggleBroadcastSelection(s.broadcast.selected, paneId) },
    })),

  selectAllBroadcast: () =>
    set((s) => ({
      broadcast: {
        ...s.broadcast,
        selected: s.panes.filter((p) => p.data.kind === "terminal").map((p) => p.paneId),
      },
    })),
}));
