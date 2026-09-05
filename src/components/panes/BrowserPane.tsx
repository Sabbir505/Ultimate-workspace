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
  canGoBack as historyCanGoBack,
  canGoForward as historyCanGoForward,
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
  browserOpenDevtools,
  browserSetBoundsTab,
  browserSetVisibleTab,
  browserClosePane,
  listenBrowserNavigatedTab,
  listenBrowserTitle,
  listenBrowserLoadCompleted,
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
import { useBrowserTrustStore } from "../../state/browserTrust";
import {
  browserCancelAgent,
  browserClearSiteData,
  browserConfirmResult,
  browserSetAgentPaused,
  browserTimeline,
  getSetting,
  setSetting,
} from "../../lib/ipc";

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

const AGENT_ACTIVE_TTL_MS = 4000;

/** Time-decaying "agent working" flag. zustand selectors only recompute when
 *  the store changes, so a raw Date.now() comparison would freeze on its first
 *  value — a 1s interval re-renders while the flag is live (and stops when
 *  idle, so an inactive pane costs nothing). */
function useAgentActiveTick(lastActivity: number | undefined): boolean {
  const [, setTick] = useState(0);
  const active = !!lastActivity && Date.now() - lastActivity < AGENT_ACTIVE_TTL_MS;
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [active, lastActivity]);
  return active;
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
  const setBrowserTabFavicon = usePanesStore((s) => s.setBrowserTabFavicon);
  const setBrowserTabUrl = usePanesStore((s) => s.setBrowserTabUrl);

  // Occlusion inputs (native path only; see lib/browserOcclusion.ts).
  const activeView = useUiStore((s) => s.activeView);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const peekOpen = useUiStore((s) => s.peek.open);
  const modalOpen = useUiStore((s) => s.modalOpen);
  // HTML popups that must paint over the webview (context meter hover panel).
  const contextTipOpen = useUiStore((s) => s.contextTipOpen);

  // Trust layer (Phase 2): gate confirmations, takeover, pause/stop, timeline.
  const confirm = useBrowserTrustStore((s) =>
    s.confirm && s.confirm.paneId === paneId ? s.confirm : null,
  );
  const takeover = useBrowserTrustStore((s) =>
    s.takeover && s.takeover.paneId === paneId ? s.takeover : null,
  );
  const paused = useBrowserTrustStore((s) => !!s.paused[paneId]);
  const timelineOpen = useBrowserTrustStore((s) => !!s.timelineOpen[paneId]);
  const timelineEntries = useBrowserTrustStore((s) => s.timeline[paneId]);
  const lastActivity = useBrowserTrustStore((s) => s.lastAgentActivity[paneId]);
  const agentWorking = useAgentActiveTick(lastActivity);
  const trustToggleTimeline = useBrowserTrustStore((s) => s.toggleTimeline);
  const trustSetTakeover = useBrowserTrustStore((s) => s.setTakeover);
  const trustSetPaused = useBrowserTrustStore((s) => s.setPaused);
  const trustSetConfirm = useBrowserTrustStore((s) => s.setConfirm);
  const trustSetTimeline = useBrowserTrustStore((s) => s.setTimeline);

  // Autonomy dial: "auto" (default — only hard-gate risk classes confirm) vs
  // "manual" (every agent action confirms). Persisted via the DB settings.
  const [autonomy, setAutonomy] = useState<"auto" | "manual">("auto");
  useEffect(() => {
    void getSetting("browserAutonomy")
      .then((v) => {
        if (v === "manual" || v === "auto") setAutonomy(v);
      })
      .catch(() => {});
  }, []);
  const changeAutonomy = (next: "auto" | "manual") => {
    setAutonomy(next);
    void setSetting("browserAutonomy", next).catch(() => {});
  };
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
  // Back/forward button enablement from the LOCAL history stack (the same
  // stack the iframe fallback navigates). The native path's real history can
  // be richer (e.g. restored after re-mount), but this matches the stack we
  // control and removes the always-enabled buttons.
  const canGoBack = activeTabState ? historyCanGoBack(activeTabState.history) : false;
  const canGoForward = activeTabState ? historyCanGoForward(activeTabState.history) : false;
  const occluded = browserOccluded({
    activeView,
    paletteOpen,
    peekOpen,
    modalOpen,
    paneVisible: visible && inActiveBrowserTab,
    collapsed,
    htmlOverlayOpen: contextTipOpen,
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

    browserCreateTab(paneId, tabId, tabUrl, rect, projectId)
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
        console.warn(`[relay] browser_create failed for tab ${tabId}, using iframe fallback: ${msg}`);
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
      // Hide every native tab we have ever created, not just tabs still in
      // the current store snapshot. A tab can be removed from `tabs` before
      // React's unmount cleanup runs; omitting it leaves an untracked native
      // WebView2 child above the DOM, intercepting clicks as a ghost overlay.
      const knownTabIds = new Set(latestTabs.map((tab) => tab.tabId));
      for (const tabId of nativeTabsRef.current) knownTabIds.add(tabId);
      for (const tabId of knownTabIds) {
        void browserSetVisibleTab(paneId, tabId, false).catch(() => {});
        void browserSetBoundsTab(paneId, tabId, offScreen).catch(() => {});
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
  // Trust layer: while the credential-takeover overlay or the timeline panel
  // is open the native webview MUST hide — the DOM overlay cannot paint above
  // an OS child window (same constraint as browserOcclusion). This flag is
  // folded into the occlusion effect below (single writer: a second
  // setVisible writer raced it and the webview could repaint OVER the
  // takeover/timeline overlay on any tabState change).
  const trustOverlayOpen = !!takeover || timelineOpen;
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
      // trustOverlayOpen (takeover / timeline panel) hides the webview too —
      // the DOM overlays cannot paint above an OS child window.
      const shouldShow = !occluded && !trustOverlayOpen && tabId === activeTabId;
      void browserSetVisibleTab(paneId, tabId, shouldShow).catch(() => {});
      // Move off-screen when hidden as a safety net — native webviews don't
      // respect CSS z-index and the visibility call may not take effect
      // immediately (or at all on some platforms).
      if (!shouldShow) {
        void browserSetBoundsTab(paneId, tabId, offScreen).catch(() => {});
      }
    }
  }, [paneId, tabs, tabStates, occluded, activeTabId, trustOverlayOpen]);

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

  // --- Injected-bridge title reports: label the tab + derive a favicon. ---
  // The backend emits `browser:title` on every post-nav injection pass and on
  // WebView2 NavigationCompleted, so a slow page's title lands within ~5 s.
  useEffect(() => {
    const listenReady = listenBrowserTitle((payload) => {
      if (payload.paneId !== paneId) return;
      const title = payload.title.trim();
      if (title) setBrowserTabTitle(paneId, payload.tabId, title);
      // Favicon from the tab's current URL: same-origin /favicon.ico. Cheap,
      // offline-safe, and correct for the sites users + agents actually open
      // (local dev servers included). If a site has none, the browser just
      // renders a broken-image we hide via onError.
      // Read from the STORE, not this closure: the effect intentionally does
      // not depend on the tabs array (listener stability), so a closure copy
      // would be stale for tabs created after mount.
      const pane = usePanesStore
        .getState()
        .panes.find((p) => p.paneId === paneId);
      const tab =
        pane && pane.data.kind === "browser"
          ? pane.data.tabs.find((t) => t.tabId === payload.tabId)
          : undefined;
      const url = tab?.url;
      if (url) {
        try {
          const u = new URL(url);
          if (u.protocol === "http:" || u.protocol === "https:") {
            setBrowserTabFavicon(paneId, payload.tabId, u.origin + "/favicon.ico");
          }
        } catch {
          /* non-parseable URL — skip favicon */
        }
      }
    });
    return () => {
      void listenReady.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, setBrowserTabTitle, setBrowserTabFavicon]);

  // --- WebView2 NavigationCompleted (ground truth) — clear the loading flag
  // when a load REALLY finished, even if the navigation-start event never
  // surfaced (the stuck-loading bug: spinner forever, black pane). ---
  useEffect(() => {
    const listenReady = listenBrowserLoadCompleted((label: string) => {
      // label = "browser-{paneId}-tab-{tabId}" (browser_label format).
      const m = /^browser-(.+)-tab-(.+)$/.exec(label);
      if (!m || m[1] !== paneId) return;
      const tabId = m[2];
      setTabStates((prev) => {
        const existing = prev.get(tabId);
        if (!existing || (!existing.loading && !existing.loadFailed)) return prev;
        const next = new Map(prev);
        next.set(tabId, { ...existing, loading: false, loadFailed: false });
        return next;
      });
    });
    return () => {
      void listenReady.then((u) => u());
    };
  }, [paneId]);

  // Trust layer: hydrate the timeline snapshot once per pane (live entries
  // stream in via browser:timeline-entry -> store).
  useEffect(() => {
    void browserTimeline(paneId)
      .then((entries) => trustSetTimeline(paneId, entries))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  const answerConfirm = (approved: boolean, alwaysForSite: boolean) => {
    if (!confirm) return;
    void browserConfirmResult(confirm.reqId, approved, alwaysForSite).catch(() => {});
    trustSetConfirm(null);
  };

  const dismissTakeover = () => {
    trustSetTakeover(null);
  };

  const togglePause = () => {
    const next = !paused;
    trustSetPaused(paneId, next);
    void browserSetAgentPaused(paneId, next).catch(() => {});
  };

  const stopAgent = () => {
    void browserCancelAgent(paneId).catch(() => {});
  };

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
        console.warn("[relay] browser_navigate failed", err);
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
            {tab.faviconUrl && (
              <img
                className="tab-favicon"
                src={tab.faviconUrl}
                alt=""
                onError={(e) => {
                  // Site has no /favicon.ico — drop the img instead of
                  // showing a broken-image glyph forever.
                  e.currentTarget.style.display = "none";
                }}
              />
            )}
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
          disabled={!canGoBack}
        >
          ←
        </button>
        <button
          className="ghost"
          title="Forward (uses the page's real history)"
          onClick={forward}
          disabled={!canGoForward}
        >
          →
        </button>
        <button className="ghost" title="Refresh" onClick={refresh}>
          ↻
        </button>
        <button
          className="ghost"
          title="Open DevTools (console + network)"
          onClick={() => void browserOpenDevtools(paneId, activeTabId).catch(() => {})}
        >
          ⚙
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
          // NO onBlur navigate: the native webview steals focus mid-typing
          // (every navigation/bounds change), the input blurred after each
          // character, and blur-navigate fired a search per KEYSTROKE
          // ("g" → bing?q=g, "o" → bing?q=o…). Navigate on Enter only.
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

      {/* Trust layer: gate confirmation bar. Lives in the DOM chrome ABOVE
          the webview anchor, so the OS child webview can't cover it. */}
      {confirm && (
        <div className="browser-confirm" data-risk={confirm.riskClass}>
          <div className="browser-confirm-text">
            <span className="browser-confirm-title">
              Agent wants to {confirm.op} {confirm.target ? `“${confirm.target}”` : ""}
            </span>
            <span className="browser-confirm-reason">
              {confirm.reason}
              {confirm.url ? ` — ${confirm.url}` : ""}
            </span>
          </div>
          <div className="browser-confirm-actions">
            <button className="primary" onClick={() => answerConfirm(true, false)}>
              Allow once
            </button>
            <button onClick={() => answerConfirm(true, true)}>Always on this site</button>
            <button className="danger" onClick={() => answerConfirm(false, false)}>
              Deny
            </button>
          </div>
        </div>
      )}

      {/* Trust layer: agent status strip (activity tint + pause/stop). */}
      <div className={`browser-trust-strip${agentWorking ? " active" : ""}${paused ? " paused" : ""}`}>
        <span className="browser-trust-status">
          {paused ? "⏸ Agent paused" : agentWorking ? "⏺ Agent working…" : "Idle"}
        </span>
        <div className="browser-trust-controls">
          <div className="browser-autonomy" title="Auto: confirm only risky actions (payments, destructive, credentials). Manual: confirm every agent action.">
            <button
              className={autonomy === "auto" ? "seg active" : "seg"}
              onClick={() => changeAutonomy("auto")}
            >
              Auto
            </button>
            <button
              className={autonomy === "manual" ? "seg active" : "seg"}
              onClick={() => changeAutonomy("manual")}
            >
              Manual
            </button>
          </div>
          <button
            className="ghost"
            title="Clear this site's session (cookies + storage) and reload"
            onClick={() => void browserClearSiteData(paneId, activeTabId).catch(() => {})}
          >
            🧹
          </button>
          <button className="ghost" title={paused ? "Resume agent" : "Pause agent"} onClick={togglePause}>
            {paused ? "▶" : "⏸"}
          </button>
          <button className="ghost" title="Stop the agent (cancels its current action)" onClick={stopAgent}>
            ⏹
          </button>
          <button
            className="ghost"
            title="Agent action timeline (what the agent did — user-owned log)"
            onClick={() => trustToggleTimeline(paneId)}
          >
            {timelineOpen ? "✕" : "☰"}
          </button>
        </div>
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

        {/* Trust layer: user-owned action timeline (hides the webview while
            open — trustOverlayOpen feeds the main occlusion effect). */}
        {timelineOpen && (
          <div className="browser-timeline">
            <div className="browser-timeline-head">
              <span>Agent actions — this session</span>
              <button className="ghost" onClick={() => trustToggleTimeline(paneId)}>
                ✕
              </button>
            </div>
            <div className="browser-timeline-list">
              {(timelineEntries ?? []).length === 0 && (
                <div className="hint">No agent actions recorded yet.</div>
              )}
              {(timelineEntries ?? [])
                .slice()
                .reverse()
                .map((e, i) => (
                  <div key={i} className={`browser-timeline-row outcome-${e.outcome}`}>
                    <span className="tl-time">
                      {new Date(e.tsMs).toLocaleTimeString([], { hour12: false })}
                    </span>
                    <span className="tl-op">{e.op}</span>
                    <span className="tl-target" title={e.detail ?? e.target}>
                      {e.target || "—"}
                      {e.riskClass ? ` [${e.riskClass}]` : ""}
                    </span>
                    <span className="tl-outcome">{e.outcome}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Trust layer: credential takeover — the agent is denied and blinded;
            the user types credentials themselves (Operator's privacy-shielded
            takeover, as a deny-and-hand-off). */}
        {takeover && (
          <div className="browser-takeover">
            <div className="browser-takeover-card">
              <div style={{ fontWeight: 700 }}>You're in control</div>
              <div className="hint">
                The agent tried to enter credentials ({takeover.reason}). Relay
                never lets an agent type passwords or card details. Enter them
                yourself now — the page is live below — then hand control back.
              </div>
              <button className="primary" onClick={dismissTakeover}>
                Done — hand back to the agent
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}