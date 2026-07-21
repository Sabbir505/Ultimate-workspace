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
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createHistory,
  currentUrl,
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
  browserCloseTab,
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
  /** Whether the native webview has been created (lazy: created on first activation). */
  webviewCreated: boolean;
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
    webviewCreated: false,
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
  const modalOpen = useUiStore(
    (s) =>
      s.pendingReplace !== null || s.projectSettingsFor !== null || s.gitPromptProjectId !== null,
  );

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

  const activeTabId = getActiveTabId(pane);
  const activeTab = tabs[activeTabIndex];
  const activeTabState = tabStates.get(activeTabId);
  const frameSrc = activeTabState ? currentUrl(activeTabState.history) : (activeTab?.url ?? "http://localhost:3000");
  const occluded = browserOccluded({
    activeView,
    paletteOpen,
    peekOpen,
    modalOpen,
    paneVisible: visible,
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

  // --- Native lifecycle: create webview for the active tab only (lazy). ---
  // When the active tab changes and its webview hasn't been created yet, create it.
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

    let cancelled = false;
    const body = bodyRef.current;
    const rect: BrowserRect = body ? rectOf(body) : { x: 0, y: 0, width: 1, height: 1 };
    const tabId = activeTabId;

    // Mark webviewCreated = true so we don't re-create.
    setTabStates((prev) => {
      const next = new Map(prev);
      const existing = next.get(tabId);
      if (existing) next.set(tabId, { ...existing, webviewCreated: true });
      return next;
    });

    browserCreateTab(paneId, tabId, tabUrl, rect)
      .then(() => {
        if (!cancelled) {
          setTabStates((prev) => {
            const next = new Map(prev);
            const existing = next.get(tabId);
            if (existing) next.set(tabId, { ...existing, nativeOk: true });
            return next;
          });
        }
      })
      .catch((err) => {
        const msg = typeof err === "string" ? err : err?.message ?? String(err);
        console.warn(`[conduit] browser_create failed for tab ${tabId}, using iframe fallback: ${msg}`);
        if (!cancelled) {
          setTabStates((prev) => {
            const next = new Map(prev);
            const existing = next.get(tabId);
            if (existing) next.set(tabId, { ...existing, nativeOk: false, createError: msg });
            return next;
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, activeTabId]);

  // --- Close tab webviews on pane unmount. ---
  useEffect(() => {
    return () => {
      // Close all tab webviews for this pane. Idempotent.
      for (const tab of tabs) {
        void browserCloseTab(paneId, tab.tabId).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  // --- Native bounds: track the body div, debounced. Set bounds for ALL tabs. ---
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let timer: number | null = null;
    const sync = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const r = rectOf(body);
        // Set bounds for all tab webviews (even hidden ones) so they don't
        // flash at stale positions when shown.
        for (const tab of tabs) {
          const ts = tabStates.get(tab.tabId);
          if (ts?.nativeOk === true) {
            void browserSetBoundsTab(paneId, tab.tabId, r).catch(() => {});
          }
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
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [paneId, tabs, tabStates]);

  // --- Native occlusion + per-tab visibility. ---
  // When occluded: hide ALL tab webviews.
  // When not occluded: hide all tabs except the active one; show the active one.
  useEffect(() => {
    for (const tab of tabs) {
      const ts = tabStates.get(tab.tabId);
      if (ts?.nativeOk !== true) continue;
      const shouldShow = !occluded && tab.tabId === activeTabId;
      void browserSetVisibleTab(paneId, tab.tabId, shouldShow).catch(() => {});
    }
  }, [paneId, tabs, tabStates, occluded, activeTabId]);

  // --- Native navigation events: keep the address bar + history truthful
  // for in-page navigations (link clicks, redirects). ---
  useEffect(() => {
    let unlisten: () => void = () => {};
    void listenBrowserNavigatedTab((payload: BrowserNavigatedPayload) => {
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
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten();
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

  // Sync the address bar if the active tab's URL changes externally.
  useEffect(() => {
    if (activeTab?.url) {
      setTabStates((prev) => {
        const next = new Map(prev);
        const existing = next.get(activeTabId);
        if (existing && existing.address !== activeTab.url) {
          next.set(activeTabId, { ...existing, address: activeTab.url });
        }
        return next;
      });
    }
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