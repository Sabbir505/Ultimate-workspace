// Registers backend event listeners for the browser MCP roundtrips
// (browser:resolve-pane-request, browser:open-browser-request) and dispatches
// answers back to the Rust backend. Mirrors the shape of useChatEvents.
//
// The MCP WebSocket server (Task #4) emits these events when it needs to
// target a browser pane by project_id or auto-open one.
import { useEffect } from "react";
import {
  browserNavigateTab,
  browserNewTabResult,
  browserOpenPaneResult,
  browserResolvePaneResult,
  browserSwitchTabResult,
  browserCloseTabResult,
  listenBrowserActivity,
  listenBrowserCloseTabRequest,
  listenBrowserConfirmRequest,
  listenBrowserNewTabRequest,
  listenBrowserOpenBrowserRequest,
  listenBrowserResolvePaneRequest,
  listenBrowserSwitchTabRequest,
  listenBrowserTakeoverRequest,
  listenBrowserTimelineEntry,
} from "../lib/ipc";
import { useBrowserTrustStore } from "../state/browserTrust";
import { surfaceBrowserTab } from "../lib/sessionLauncher";
import { usePanesStore } from "../state/panes";
import { useProjectsStore } from "../state/projects";
import { useUiStore } from "../state/ui";

/** Bring the Browser tab of the right tool panel into view — mirrors the
 *  canvas auto-open for generated artifacts. `paneId`, when known, is also
 *  focused so its webview gets the visible slot. REUSES the existing Browser
 *  chip: this runs on EVERY agent browser tool call (read/click/type/…), and
 *  a raw ui.addTab here stacked a brand-new "Browser" chip per tool call. */
function surfaceBrowserPanel(paneId?: string | null): void {
  surfaceBrowserTab();
  if (paneId) {
    const panes = usePanesStore.getState();
    if (panes.panes.some((p) => p.paneId === paneId)) {
      panes.focusPane(paneId);
    }
  }
}

/**
 * Open (or reuse) a built-in browser pane for a specific project pointed at
 * `url`. Returns the paneId + active tabId (the backend polls for that tab's
 * webview). Mirrors `openInBrowserPane` from useChatEvents but scoped to an
 * explicit projectId.
 */
export function openBrowserPaneForProject(
  url: string,
  projectId: string | null,
): { paneId: string; tabId: string } {
  const panes = usePanesStore.getState();
  const existing = panes.panes.find(
    (p) => p.data.kind === "browser" && !p.data.collapsed,
  );
  if (existing && existing.data.kind === "browser") {
    const tab = existing.data.tabs[existing.data.activeTabIndex];
    if (tab) {
      panes.setBrowserUrl(existing.paneId, url, tab.tabId);
      void browserNavigateTab(existing.paneId, tab.tabId, url).catch(() => {});
    }
    surfaceBrowserPanel(existing.paneId);
    return {
      paneId: existing.paneId,
      tabId: tab?.tabId ?? existing.data.tabs[0]?.tabId ?? "default",
    };
  }
  const paneId = panes.addPane({
    kind: "browser",
    url,
    projectId,
  });
  surfaceBrowserPanel(paneId);
  const pane = usePanesStore
    .getState()
    .panes.find((p) => p.paneId === paneId);
  const tabId =
    pane && pane.data.kind === "browser"
      ? pane.data.tabs[pane.data.activeTabIndex]?.tabId ?? "default"
      : "default";
  return { paneId, tabId };
}

export function useBrowserMcpEvents(): void {
  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    // Resolve-pane-request: the backend asks which browser pane belongs to
    // a given project. We pick the most-recently-used one and answer back.
    unlistens.push(
      listenBrowserResolvePaneRequest(({ reqId, projectId }) => {
        const panes = usePanesStore.getState().panes;
        const candidates = panes.filter(
          (p) => p.data.kind === "browser" && p.data.projectId === projectId,
        );
        const best = candidates.length > 0
          ? candidates.reduce((a, b) => (a.lastUsedAt > b.lastUsedAt ? a : b))
          : null;
        void browserResolvePaneResult(reqId, best?.paneId ?? null).catch(() => {});
      }),
    );

    // Open-browser-request: the backend wants us to create (or reveal) a
    // browser pane for a given project pointed at a URL, then answer back
    // with the new paneId + the active tabId (the backend polls for THAT
    // tab's webview label — the old hardcoded "default" poll broke whenever
    // the frontend's first tab id differed).
    unlistens.push(
      listenBrowserOpenBrowserRequest(({ reqId, projectId, url }) => {
        try {
          const { paneId, tabId } = openBrowserPaneForProject(url, projectId);
          void browserOpenPaneResult(reqId, paneId, tabId).catch(() => {});
        } catch {
          void browserOpenPaneResult(reqId, null).catch(() => {});
        }
      }),
    );

    // Switch-tab-request: the agent wants a different tab of a pane active.
    unlistens.push(
      listenBrowserSwitchTabRequest(({ reqId, paneId, tabId }) => {
        const panes = usePanesStore.getState();
        const pane = panes.panes.find(
          (p) => p.paneId === paneId && p.data.kind === "browser",
        );
        if (!pane || pane.data.kind !== "browser") {
          void browserSwitchTabResult(reqId, null).catch(() => {});
          return;
        }
        const index = pane.data.tabs.findIndex((t) => t.tabId === tabId);
        if (index < 0) {
          void browserSwitchTabResult(reqId, null).catch(() => {});
          return;
        }
        panes.switchBrowserTab(paneId, index);
        surfaceBrowserPanel(paneId);
        void browserSwitchTabResult(reqId, tabId).catch(() => {});
      }),
    );

    // New-tab-request: the agent wants a new tab pointed at a URL. The pane's
    // BrowserPane component lazily creates the webview once the tab activates.
    unlistens.push(
      listenBrowserNewTabRequest(({ reqId, paneId, url }) => {
        const panes = usePanesStore.getState();
        const pane = panes.panes.find(
          (p) => p.paneId === paneId && p.data.kind === "browser",
        );
        if (!pane || pane.data.kind !== "browser") {
          void browserNewTabResult(reqId, null).catch(() => {});
          return;
        }
        const tabId = panes.addBrowserTab(paneId, url);
        surfaceBrowserPanel(paneId);
        void browserNewTabResult(reqId, tabId).catch(() => {});
      }),
    );

    // Close-tab-request: the agent closes a tab. If it was the pane's last
    // tab the store closes the whole pane — the answer still echoes the tab.
    unlistens.push(
      listenBrowserCloseTabRequest(({ reqId, paneId, tabId }) => {
        const panes = usePanesStore.getState();
        const pane = panes.panes.find(
          (p) => p.paneId === paneId && p.data.kind === "browser",
        );
        if (!pane || pane.data.kind !== "browser" ||
            !pane.data.tabs.some((t) => t.tabId === tabId)) {
          void browserCloseTabResult(reqId, null).catch(() => {});
          return;
        }
        panes.closeBrowserTab(paneId, tabId);
        void browserCloseTabResult(reqId, tabId).catch(() => {});
      }),
    );

    // Browser-activity: the agent performed a browser action (harness MCP op
    // or chat browser_* tool) — surface the Browser tab so it's visible.
    unlistens.push(
      listenBrowserActivity(({ paneId }) => {
        surfaceBrowserPanel(paneId);
        useBrowserTrustStore.getState().markAgentActivity(paneId);
      }),
    );

    // Gate confirmation (trust layer): the backend paused a risky agent
    // action until the user approves. Route to the pane-scoped UI via the
    // store; timeout/answers go back through browserConfirmResult.
    unlistens.push(
      listenBrowserConfirmRequest((payload) => {
        useBrowserTrustStore.getState().setConfirm(payload);
        surfaceBrowserPanel(payload.paneId);
      }),
    );

    // Credential takeover: the agent tried to type into a credential field —
    // it is denied and blinded; the user enters credentials themselves.
    unlistens.push(
      listenBrowserTakeoverRequest((payload) => {
        useBrowserTrustStore.getState().setTakeover(payload);
        surfaceBrowserPanel(payload.paneId);
      }),
    );

    // Timeline: user-owned record of every agent browser action, streamed
    // live for the pane's audit panel.
    unlistens.push(
      listenBrowserTimelineEntry(({ paneId, entry }) => {
        useBrowserTrustStore.getState().appendTimeline(paneId, entry);
      }),
    );

    return () => {
      for (const u of unlistens) void u.then((fn) => fn());
    };
  }, []);
}