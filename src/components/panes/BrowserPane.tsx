// Browser pane (§4.6): real browsing inside the grid — now with multi-tab support.
//
// NATIVE PATH (Windows/macOS): a Tauri child webview per tab (top-level browsing
// context — X-Frame-Options doesn't apply, full navigation/history works)
// positioned exactly over the body div below. Because native webviews float
// ABOVE the DOM (not composited with it), three things keep the illusion
// intact:
//   1. bounds: a ResizeObserver on the body div (+ window resize) drives
//      debounced browser_set_bounds calls for ALL tab webviews;
//   2. occlusion: any overlay (settings/skills/cost views, command palette,
//      peek panel, modals) or a hidden split-mode slot hides ALL webviews via
//      browser_set_visible(false) — see lib/browserOcclusion.ts;
//   3. lifecycle: unmount / closePane -> browser_close_pane.
// Only the ACTIVE tab's webview is visible; inactive tabs are hidden.
// Lazy creation: a tab's webview is created only on first activation.
//
// IFRAME FALLBACK (Linux, or any browser_create failure): render one iframe
// per tab, only active visible via CSS display toggle.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createHistory,
  currentUrl,
  DEFAULT_BROWSER_URL,
  normalizeUrl,
  pushUrl,
  type BrowserHistory,
} from "../../lib/browserHistory";
import { browserOccluded } from "../../lib/browserOcclusion";
import {
  browserCreateTab,
  browserNavigateTab,
  browserGoBackTab,
  browserGoForwardTab,
  browserReloadTab,
  browserSetBoundsTab,
  browserSetVisibleTab,
  browserClosePane,
  listenBrowserNavigatedTab,
  tauriRuntimeAvailable,
  type BrowserRect,
  type BrowserNavigatedPayload,
} from "../../lib/ipc";
import {
  usePanesStore,
  activeTabId as getActiveTabId,
  activeTabUrl as getActiveTabUrl,
  type Pane,
  type BrowserTabData,
} from "../../state/panes";
import { useSettingsStore } from "../../state/settings";
import { useUiStore } from "../../state/ui";

const LOAD_TIMEOUT_MS = 8000;
const BOUNDS_DEBOUNCE_MS = 50;

interface Props {
  pane: Pane;
  /** Whether this pane is the visible one in split mode (PaneGrid decides).
   *  Hidden panes stay mounted, so their native webviews must be hidden
   *  explicitly. */
  visible?: boolean;
}

interface TabState {
  history: BrowserHistory;
  address: string;
  loading: boolean;
  loadFailed: boolean;
  /** null = still deciding, true = native child webview, false = iframe fallback. */
  nativeOk: boolean | null;
  createError: string | null;
}

function rectOf(el: HTMLElement): BrowserRect {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function makeTabState(url: string): TabState {
  return {
    history: createHistory(url),
    address: url,
    loading: true,
    loadFailed: false,
    nativeOk: null,
    createError: null,
  };
}

export function BrowserPane({ pane, visible = true }: Props) {
  const paneId = pane.paneId;
  const projectId = pane.data.kind === "browser" ? pane.data.projectId : null;
  const collapsed = pane.data.kind === "browser" ? !!pane.data.collapsed : false;
  const tabs = pane.data.kind === "browser" ? pane.data.tabs : [];
  const activeTabIndex = pane.data.kind === "browser" ? pane.data.activeTabIndex : 0;
  const lastBrowserUrl = useSettingsStore((s) => s.lastBrowserUrl);

  // Store actions.
  const setBrowserUrl = usePanesStore((s) => s.setBrowserUrl);
  const switchBrowserTab = usePanesStore((s) => s.switchBrowserTab);
  const addBrowserTab = usePanesStore((s) => s.addBrowserTab);
  const closeBrowserTab = usePanesStore((s) => s.closeBrowserTab);
  const setBrowserTabTitle = usePanesStore((s) => s.setBrowserTabTitle);
  const setBrowserTabUrl = usePanesStore((s) => s.setBrowserTabUrl);

  // Occlusion inputs (native path only; see lib/browserOcclusion.ts).
  const activeView = useUiStore((s) => s.activeView);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const peekOpen = useUiStore((s) => s.peek.open);
  const modalOpen = useUiStore((s) => s.modalOpen);
  // The Browser tab's content only renders when this tool-panel tab is the
  // active one AND the panel is not collapsed. PaneFrame's `visible` prop only
  // reflects the active-browser-vs-hidden-browser decision inside the slot —
  // it does NOT encode the tool-panel-tab switch or the panel-collapsed state.
  // Without feeding those in, switching to Terminal/Files/Canvas or closing
  // the whole panel leaves the active browser pane's `visible` prop unchanged
  // (still true), so the native webview is never told to hide and it stays
  // painted on top of whatever the user is now looking at.
  const toolPanelTab = useUiStore((s) => s.toolPanelTab);
  const toolPanelCollapsed = useUiStore((s) => s.toolPanelCollapsed);
  const inActiveBrowserTab = toolPanelTab === "browser" && !toolPanelCollapsed;

  // Per-tab state: Map<tabId, TabState>. Lazily populated.
  const [tabStates, setTabStates] = useState<Map<string, TabState>>(() => {
    const m = new Map<string, TabState>();
    for (const t of tabs) {
      m.set(t.tabId, makeTabState(t.url));
    }
    return m;
  });

  const [copied, setCopied] = useState(false);
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  const bodyRef = useRef<HTMLDivElement>(null);
  const timeoutRefs = useRef<Map<string, number>>(new Map());
  // Latest tabStates snapshot for the unmount cleanup — the cleanup closure
  // would otherwise capture a stale Map from effect-creation time.
  const tabStatesRef = useRef<Map<string, TabState>>(tabStates);
  tabStatesRef.current = tabStates;
  // Track which tabs have a native webview (nativeOk === true). Unlike
  // tabStates, this is NEVER pruned when tabs are closed — the ghost-hide
  // effect needs to know "did this tab have a native webview?" even after
  // the tab is removed from the tabs array and its tabState entry is purged.
  const nativeTabsRef = useRef<Set<string>>(new Set());

  const activeTabId = getActiveTabId(pane);
  const activeTab = tabs[activeTabIndex];
  const activeTabState = tabStates.get(activeTabId);
  const frameSrc = activeTabState ? currentUrl(activeTabState.history) : (activeTab?.url ?? DEFAULT_BROWSER_URL);
  const occluded = browserOccluded({
    activeView,
    paletteOpen,
    peekOpen,
    modalOpen,
    paneVisible: visible && inActiveBrowserTab,
    collapsed,
  });

  // Ensure tabState entries exist for any tabs we don't have state for yet.
  useEffect(() => {
    setTabStates((prev) => {
      const next = new Map(prev);
      for (const t of tabs) {
        if (!next.has(t.tabId)) {
          next.set(t.tabId, makeTabState(t.url));
        }
      }
      // Remove stale entries for tabs that no longer exist.
      const currentTabIds = new Set(tabs.map((t) => t.tabId));
      for (const key of next.keys()) {
        if (!currentTabIds.has(key)) next.delete(key);
      }
      return next;
    });
  }, [tabs]);

  // In-flight native webview creates, keyed by tabId. This MUST be a ref,
  // not component state: the create effect below re-runs on every tabStates
  // change (new Map identity), and each re-run executes the previous run's
  // cleanup — which set `cancelled = true`. The in-flight browserCreateTab
  // promise then resolved with `cancelled` already true, so `nativeOk` was
  // never set: the OS-level webview stayed alive but untracked — a ghost
  // overlay that no occlusion effect would ever hide, while the iframe
  // fallback rendered underneath it.
  const createInFlightRef = useRef<Set<string>>(new Set());

  // --- Native lifecycle: create webview for the active tab only (lazy). ---
  // When the active tab changes and its webview hasn't been created yet, create it.
  // Depends on `tabStates` too: the tabState-ensure effect above adds an entry
  // for a brand-new tab asynchronously (via setTabState → re-render). If this
  // effect only re-ran on `activeTabId`, it would read a stale `tabStates`
  // snapshot from the render where the tab became active but its entry didn't
  // exist yet, return early, and NEVER create the webview. Re-running when the
  // entry lands closes that race.
  useEffect(() => {
    if (!tauriRuntimeAvailable()) {
      // Mark all tabs as iframe-fallback.
      setTabStates((prev) => {
        const next = new Map(prev);
        for (const [key, st] of next) {
          if (st.nativeOk === null) next.set(key, { ...st, nativeOk: false });
        }
        return next;
      });
      return;
    }

    const tabState = tabStates.get(activeTabId);
    if (!tabState || tabState.nativeOk !== null) return;
    // Don't create webview if the tab has no URL yet.
    const tabUrl = activeTab?.url;
    if (!tabUrl) return;
    const tabId = activeTabId;
    // One create per tab at a time — the guard survives effect re-runs
    // (see createInFlightRef above).
    if (createInFlightRef.current.has(tabId)) return;
    createInFlightRef.current.add(tabId);

    const body = bodyRef.current;
    const rect: BrowserRect = body ? rectOf(body) : { x: 0, y: 0, width: 1, height: 1 };

    browserCreateTab(paneId, tabId, tabUrl, rect)
      .then(() => {
        // setState after unmount is a React 18 no-op; the unmount cleanup
        // closes the pane's webviews, so a late resolve can't leak one.
        setTabStates((prev) => {
          const next = new Map(prev);
          const existing = next.get(tabId);
          if (existing) next.set(tabId, { ...existing, nativeOk: true });
          return next;
        });
      })
      .catch((err) => {
        const msg = typeof err === "string" ? err : err?.message ?? String(err);
        console.warn(`[conduit] browser_create failed for tab ${tabId}, using iframe fallback: ${msg}`);
        setTabStates((prev) => {
          const next = new Map(prev);
          const existing = next.get(tabId);
          if (existing) next.set(tabId, { ...existing, nativeOk: false, createError: msg });
          return next;
        });
      })
      .finally(() => {
        createInFlightRef.current.delete(tabId);
      });
  }, [paneId, activeTabId, tabStates, activeTab?.url]);

  // --- Destroy native webviews on pane unmount. ---
  // The store's closePane already calls browserClosePane, but React may unmount
  // this component before that finishes (or after a stale `tabs` snapshot),
  // leaving the native webview — a separate OS child window positioned over
  // the body div — floating above the UI as a frozen overlay. Calling the
  // full-pane close here too is idempotent on the backend (close_pane_tabs
  // drains all `browser-{paneId}-tab-*` webviews) and closes the race.
  //
  // Before closing, hide AND move every tab's webview off-screen. The close
  // call may fail silently (e.g. backend I/O error), and then the webview
  // stays as a frozen ghost overlay covering the chat. Hiding + off-screen
  // as a belt-and-suspenders ensures the ghost isn't VISIBLE even if the
  // close IPC fails.
  //
  // DEPENDENCY: only [paneId]. Adding `tabs` or `tabStates` here would cause
  // the cleanup to fire on every tab add/remove/switch (destroying webviews),
  // which crashes the app. Refs provide the latest values without re-running
  // the cleanup.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    return () => {
      const latestTabs = tabsRef.current;
      const latestStates = tabStatesRef.current;
      const offScreen: BrowserRect = { x: -9999, y: -9999, width: 1, height: 1 };
      for (const tab of latestTabs) {
        const ts = latestStates.get(tab.tabId);
        if (ts?.nativeOk !== true) continue;
        void browserSetVisibleTab(paneId, tab.tabId, false).catch(() => {});
        void browserSetBoundsTab(paneId, tab.tabId, offScreen).catch(() => {});
      }
      void browserClosePane(paneId).catch(() => {});
    };
  }, [paneId]);

  // --- Native bounds: track the body div, debounced. Set bounds for VISIBLE
  // tabs only (occluded tabs are kept off-screen by the occlusion effect). ---
  // A ref holds the timer id so the cleanup function can cancel pending debounces
  // even after a re-render swaps the closure.
  const boundsTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const sync = () => {
      if (boundsTimerRef.current !== null) window.clearTimeout(boundsTimerRef.current);
      boundsTimerRef.current = window.setTimeout(() => {
        const r = rectOf(body);
        // Only sync bounds for the active, visible tab — occluded/hidden tabs
        // should stay off-screen (set by the occlusion effect). Syncing ALL
        // tabs was pulling occluded webviews back into view after the occlusion
        // moved them off-screen, causing browser content to bleed through
        // settings and other overlays.
        const ts = tabStates.get(activeTabId);
        if (ts?.nativeOk === true && !occluded) {
          void browserSetBoundsTab(paneId, activeTabId, r).catch(() => {});
        }
      }, BOUNDS_DEBOUNCE_MS);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(body);
    window.addEventListener("resize", sync);
    sync();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      if (boundsTimerRef.current !== null) window.clearTimeout(boundsTimerRef.current);
    };
  }, [paneId, tabs, tabStates, occluded, activeTabId]);

  // Track the previous tabs + activeTabId so we can hide webviews that
  // were visible last render but are now gone (closed tab) or no longer
  // active (tab switch). Without this, a closed tab's native webview can
  // stay on screen as a ghost overlay: the occlusion effect below iterates
  // the CURRENT tabs array (which no longer contains the closed tab), so it
  // never calls browserSetVisibleTab(false) on it. The backend's
  // browser_close IPC is fire-and-forget, so if it fails or is slow the
  // webview keeps painting above the DOM.
  //
  // We use nativeTabsRef (a Set that is never pruned on tab close) instead
  // of tabStates.get(tabId) because the tabState-ensure effect may purge
  // the closed tab's entry from tabStates before this effect runs.
  const prevTabsRef = useRef<{ tabs: typeof tabs; activeTabId: string }>({ tabs, activeTabId });

  // Sync nativeTabsRef: any tab whose nativeOk is true gets tracked in the set.
  // This set is never pruned on tab close (unlike tabStates), so the ghost-hide
  // effect can still look up a closed tab and hide its webview.
  for (const [tid, st] of tabStates) {
    if (st.nativeOk === true) nativeTabsRef.current.add(tid);
  }

  useEffect(() => {
    const prev = prevTabsRef.current;
    const offScreen: BrowserRect = { x: -9999, y: -9999, width: 1, height: 1 };
    // Hide + move off-screen any tab that was the active tab in the previous
    // render but is now gone (closed) or no longer active (tab switch).
    // We use nativeTabsRef instead of tabStates because a closed tab may have
    // already been purged from tabStates by the tabState-ensure effect.
    const prevActiveId = prev.activeTabId;
    if (prevActiveId && nativeTabsRef.current.has(prevActiveId)) {
      const stillExists = tabs.some((t) => t.tabId === prevActiveId);
      const stillActive = prevActiveId === activeTabId;
      if (!stillExists || !stillActive) {
        void browserSetVisibleTab(paneId, prevActiveId, false).catch(() => {});
        void browserSetBoundsTab(paneId, prevActiveId, offScreen).catch(() => {});
      }
    }
    prevTabsRef.current = { tabs, activeTabId };
  }, [paneId, tabs, activeTabId, tabStates]);

  // --- Native occlusion + per-tab visibility ---
  // useLayoutEffect so hide/size runs synchronously BEFORE the browser paints
  // the next frame — preventing a flash of the webview in the wrong position.
  // When occluded: hide ALL tab webviews AND move them off-screen so they
  // can't peek through even if the visibility call hasn't taken effect yet
  // (native webviews are OS-level child windows that float above the DOM —
  // CSS z-index has no effect on them).
  // When not occluded: hide all tabs except the active one; show the active one.
  useLayoutEffect(() => {
    const offScreen: BrowserRect = { x: -9999, y: -9999, width: 1, height: 1 };
    // Collect every tab ID that has a native webview — both from the current
    // tabs array AND from nativeTabsRef (which tracks webviews that may have
    // been closed/removed from tabs but whose OS-level window still exists).
    const allNativeTabIds = new Set<string>();
    for (const tab of tabs) {
      const ts = tabStates.get(tab.tabId);
      if (ts?.nativeOk === true) allNativeTabIds.add(tab.tabId);
    }
    for (const tid of nativeTabsRef.current) {
      allNativeTabIds.add(tid);
    }
    for (const tabId of allNativeTabIds) {
      const shouldShow = !occluded && tabId === activeTabId;
      void browserSetVisibleTab(paneId, tabId, shouldShow).catch(() => {});
      // Move off-screen when hidden as a safety net — native webviews don't
      // respect CSS z-index and the visibility call may not take effect
      // immediately (or at all on some platforms).
      if (!shouldShow) {
        void browserSetBoundsTab(paneId, tabId, offScreen).catch(() => {});
      }
    }
  }, [paneId, tabs, tabStates, occluded, activeTabId]);

  // --- Native navigation events: keep the address bar + history truthful
  // for in-page navigations (link clicks, redirects). ---
  useEffect(() => {
    // Hold the listen() promise: cleanup may run before it resolves (pane
    // closed quickly, StrictMode double-mount), and dropping the real
    // unlisten would leak this handler — and its paneId closure — for the
    // app's lifetime. Resolve the promise in cleanup and unsubscribe late.
    const listenReady = listenBrowserNavigatedTab((payload: BrowserNavigatedPayload) => {
      if (payload.paneId !== paneId) return;
      const tabId = payload.tabId;
      const url = payload.url;

      // Update the specific tab's url in the store.
      setBrowserTabUrl(paneId, tabId, url);

      setTabStates((prev) => {
        const next = new Map(prev);
        const existing = next.get(tabId);
        if (existing) {
          const h = currentUrl(existing.history) === url
            ? existing.history
            : pushUrl(existing.history, url);
          next.set(tabId, {
            ...existing,
            history: h,
            address: url,
            loading: false,
            loadFailed: false,
          });
        }
        return next;
      });

      // Persist per-project URL.
      useSettingsStore.getState().rememberBrowserUrl(projectId, url);
    });
    return () => {
      void listenReady.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, projectId]);

  // Iframe fallback only: arm the "didn't respond" heuristic whenever the
  // frame navigates. The native path has no XFO problem, so no timeout there.
  useEffect(() => {
    if (activeTabState?.nativeOk === true) return;
    // Clear all timeouts.
    for (const [key, t] of timeoutRefs.current) {
      window.clearTimeout(t);
      timeoutRefs.current.delete(key);
    }
    const tabId = activeTabId;
    timeoutRefs.current.set(
      tabId,
      window.setTimeout(() => {
        setTabStates((prev) => {
          const next = new Map(prev);
          const existing = next.get(tabId);
          if (existing && existing.loading) {
            next.set(tabId, { ...existing, loadFailed: true });
          }
          return next;
        });
      }, LOAD_TIMEOUT_MS),
    );
    return () => {
      const t = timeoutRefs.current.get(tabId);
      if (t !== undefined) {
        window.clearTimeout(t);
        timeoutRefs.current.delete(tabId);
      }
    };
  }, [frameSrc, activeTabState?.nativeOk, activeTabId]);

  // Sync when the active tab's URL changes externally (e.g. the chat's
  // `open_url` tool emits `chat:open-browser` -> setBrowserUrl). Besides the
  // address bar, the iframe fallback navigates only when its own `history`
  // advances (frameSrc = currentUrl(history)), so an external URL must be
  // pushed into history too — otherwise the address bar updates but the page
  // never changes. The native path navigates via browser_navigate directly,
  // so pushing here is a harmless no-op-or-sync for it.
  useEffect(() => {
    const url = activeTab?.url;
    if (!url) return;
    setTabStates((prev) => {
      const existing = prev.get(activeTabId);
      if (!existing) return prev;
      const historyUrl = currentUrl(existing.history);
      const urlChanged = historyUrl !== url;
      if (!urlChanged && existing.address === url) return prev;
      const next = new Map(prev);
      next.set(activeTabId, {
        ...existing,
        address: url,
        history: urlChanged ? pushUrl(existing.history, url) : existing.history,
        loading: urlChanged ? existing.nativeOk !== true : existing.loading,
        loadFailed: urlChanged ? false : existing.loadFailed,
      });
      return next;
    });
  }, [activeTab?.url, activeTabId]);

  const persist = useCallback(
    (next: string) => {
      setBrowserUrl(paneId, next, activeTabId);
      useSettingsStore.getState().rememberBrowserUrl(projectId, next);
    },
    [paneId, projectId, setBrowserUrl, activeTabId],
  );

  const navigate = (raw: string) => {
    const next = normalizeUrl(raw);
    setTabStates((prev) => {
      const nextMap = new Map(prev);
      const existing = nextMap.get(activeTabId);
      if (existing) {
        nextMap.set(activeTabId, {
          ...existing,
          history: pushUrl(existing.history, next),
          address: next,
        });
      }
      return nextMap;
    });
    persist(next);
    if (activeTabState?.nativeOk === true) {
      setTabStates((prev) => {
        const nextMap = new Map(prev);
        const existing = nextMap.get(activeTabId);
        if (existing) nextMap.set(activeTabId, { ...existing, loading: true });
        return nextMap;
      });
      void browserNavigateTab(paneId, activeTabId, next).catch((err) => {
        console.warn("[conduit] browser_navigate failed", err);
        setTabStates((prev) => {
          const nextMap = new Map(prev);
          const existing = nextMap.get(activeTabId);
          if (existing) nextMap.set(activeTabId, { ...existing, loading: false });
          return nextMap;
        });
      });
    }
  };

  const back = () => {
    if (activeTabState?.nativeOk === true) {
      void browserGoBackTab(paneId, activeTabId).catch(() => {});
      return;
    }
    try {
      iframeRefs.current.get(activeTabId)?.contentWindow?.history.back();
    } catch {
      /* no history yet */
    }
  };

  const forward = () => {
    if (activeTabState?.nativeOk === true) {
      void browserGoForwardTab(paneId, activeTabId).catch(() => {});
      return;
    }
    try {
      iframeRefs.current.get(activeTabId)?.contentWindow?.history.forward();
    } catch {
      /* no history yet */
    }
  };

  const refresh = () => {
    if (activeTabState?.nativeOk === true) {
      setTabStates((prev) => {
        const next = new Map(prev);
        const existing = next.get(activeTabId);
        if (existing) next.set(activeTabId, { ...existing, loading: true });
        return next;
      });
      void browserReloadTab(paneId, activeTabId)
        .catch(() => {})
        .finally(() => {
          setTabStates((prev) => {
            const next = new Map(prev);
            const existing = next.get(activeTabId);
            if (existing) next.set(activeTabId, { ...existing, loading: false });
            return next;
          });
        });
      return;
    }
    setTabStates((prev) => {
      const next = new Map(prev);
      const existing = next.get(activeTabId);
      if (existing) next.set(activeTabId, { ...existing, loading: true, loadFailed: false });
      return next;
    });
    if (timeoutRefs.current.has(activeTabId)) {
      window.clearTimeout(timeoutRefs.current.get(activeTabId)!);
    }
    timeoutRefs.current.set(
      activeTabId,
      window.setTimeout(() => {
        setTabStates((prev) => {
          const next = new Map(prev);
          const existing = next.get(activeTabId);
          if (existing) next.set(activeTabId, { ...existing, loadFailed: true });
          return next;
        });
      }, LOAD_TIMEOUT_MS),
    );
    const iframe = iframeRefs.current.get(activeTabId);
    if (iframe) {
      try {
        iframe.contentWindow?.location.reload();
      } catch {
        iframe.src = frameSrc;
      }
    }
  };

  const goHome = () => navigate(lastBrowserUrl(projectId));

  const openExternal = () => {
    void openUrl(frameSrc).catch((err) => console.warn("open external failed", err));
  };

  const copyUrl = () => {
    void navigator.clipboard
      .writeText(frameSrc)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch((err) => console.warn("copy failed", err));
  };

  const onLoad = () => {
    setTabStates((prev) => {
      const next = new Map(prev);
      const existing = next.get(activeTabId);
      if (existing) next.set(activeTabId, { ...existing, loading: false, loadFailed: false });
      return next;
    });
    if (timeoutRefs.current.has(activeTabId)) {
      window.clearTimeout(timeoutRefs.current.get(activeTabId)!);
      timeoutRefs.current.delete(activeTabId);
    }
  };

  const onNewTab = () => {
    const newUrl = lastBrowserUrl(projectId);
    addBrowserTab(paneId, newUrl);
  };

  const onCloseTab = (tabId: string) => {
    closeBrowserTab(paneId, tabId);
  };

  const onSwitchTab = (index: number) => {
    switchBrowserTab(paneId, index);
  };

  return (
    <>
      {/* Tab bar */}
      <div className="browser-tabbar">
        {tabs.map((tab, i) => (
          <div
            key={tab.tabId}
            className={`browser-tab${i === activeTabIndex ? " active" : ""}`}
            onClick={() => onSwitchTab(i)}
            title={tab.title || tab.url}
          >
            <span className="tab-title">{tab.title || "New Tab"}</span>
            <button
              className="ghost tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.tabId);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button className="ghost new-tab-btn" title="New tab" onClick={onNewTab}>
          +
        </button>
      </div>

      {/* URL bar */}
      <div className="browser-urlbar">
        <button
          className="ghost"
          title="Back (uses the page's real history)"
          onClick={back}
        >
          ←
        </button>
        <button
          className="ghost"
          title="Forward (uses the page's real history)"
          onClick={forward}
        >
          →
        </button>
        <button className="ghost" title="Refresh" onClick={refresh}>
          ↻
        </button>
        <button className="ghost" title="Home (project default URL)" onClick={goHome}>
          ⌂
        </button>
        <input
          value={activeTabState?.address ?? ""}
          onChange={(e) => {
            setTabStates((prev) => {
              const next = new Map(prev);
              const existing = next.get(activeTabId);
              if (existing) next.set(activeTabId, { ...existing, address: e.target.value });
              return next;
            });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const addr = tabStates.get(activeTabId)?.address ?? "";
              if (addr) navigate(addr);
            }
          }}
          onBlur={() => {
            const addr = tabStates.get(activeTabId)?.address ?? "";
            if (addr && normalizeUrl(addr) !== frameSrc) navigate(addr);
          }}
          // Select the whole URL on focus/click so a single keystroke replaces it
          // — matches a normal browser's address bar behavior.
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.currentTarget.select()}
          spellCheck={false}
        />
        {activeTabState?.loading && <span className="browser-spinner" title="Loading…" />}
        <button className="ghost" title="Copy URL" onClick={copyUrl}>
          {copied ? "✓" : "⧉"}
        </button>
        <button className="ghost" title="Open in external browser" onClick={openExternal}>
          ↗
        </button>
      </div>

      {/* The body div is the native webview's anchor: its rect drives the
          webview's bounds. In iframe-fallback mode it hosts one iframe per tab
          (only active tab visible). */}
      <div className="pane-body" ref={bodyRef}>
        {tabs.map((tab) => {
          const ts = tabStates.get(tab.tabId);
          const isActive = tab.tabId === activeTabId;
          const nativeOk = ts?.nativeOk;
          const src = ts ? currentUrl(ts.history) : tab.url;
          const loadFailed = ts?.loadFailed ?? false;
          const createError = ts?.createError ?? null;

          return (
            <div
              key={tab.tabId}
              style={{ display: isActive && nativeOk !== true ? "block" : "none", width: "100%", height: "100%" }}
            >
              {nativeOk !== true && (
                <iframe
                  ref={(el) => {
                    if (el) {
                      iframeRefs.current.set(tab.tabId, el);
                    } else {
                      iframeRefs.current.delete(tab.tabId);
                    }
                  }}
                  className="browser-frame"
                  src={src}
                  title="Browser preview"
                  onLoad={onLoad}
                />
              )}
              {nativeOk !== true && loadFailed && (
                <div className="browser-blocked">
                  <div style={{ fontWeight: 600 }}>This page didn't respond</div>
                  <div className="hint">
                    {createError
                      ? `Native browser pane failed to start: ${createError}. Falling back to iframe — the page may also block embedding (X-Frame-Options).`
                      : "It may be blocking embedding (X-Frame-Options) or still starting up."}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="primary" onClick={openExternal}>
                      Open externally ↗
                    </button>
                    <button onClick={() => {
                      setTabStates((prev) => {
                        const next = new Map(prev);
                        const existing = next.get(tab.tabId);
                        if (existing) next.set(tab.tabId, { ...existing, loadFailed: false });
                        return next;
                      });
                    }}>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}