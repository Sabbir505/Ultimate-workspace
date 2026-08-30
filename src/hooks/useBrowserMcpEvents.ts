// Registers backend event listeners for the browser MCP roundtrips
// (browser:resolve-pane-request, browser:open-browser-request) and dispatches
// answers back to the Rust backend. Mirrors the shape of useChatEvents.
//
// The MCP WebSocket server (Task #4) emits these events when it needs to
// target a browser pane by project_id or auto-open one.
import { useEffect } from "react";
import {
  browserNavigateTab,
  browserOpenPaneResult,
  browserResolvePaneResult,
  listenBrowserActivity,
  listenBrowserOpenBrowserRequest,
  listenBrowserResolvePaneRequest,
} from "../lib/ipc";
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
 * `url`. Returns the new or existing paneId. Mirrors `openInBrowserPane` from
 * useChatEvents but scoped to an explicit projectId.
 */
export function openBrowserPaneForProject(url: string, projectId: string | null): string {
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
    return existing.paneId;
  }
  const paneId = panes.addPane({
    kind: "browser",
    url,
    projectId,
  });
  surfaceBrowserPanel(paneId);
  return paneId;
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
    // with the new paneId.
    unlistens.push(
      listenBrowserOpenBrowserRequest(({ reqId, projectId, url }) => {
        try {
          const newPaneId = openBrowserPaneForProject(url, projectId);
          void browserOpenPaneResult(reqId, newPaneId).catch(() => {});
        } catch {
          void browserOpenPaneResult(reqId, null).catch(() => {});
        }
      }),
    );

    // Browser-activity: the agent performed a browser action (harness MCP op
    // or chat browser_* tool) — surface the Browser tab so it's visible.
    unlistens.push(
      listenBrowserActivity(({ paneId }) => {
        surfaceBrowserPanel(paneId);
      }),
    );

    return () => {
      for (const u of unlistens) void u.then((fn) => fn());
    };
  }, []);
}