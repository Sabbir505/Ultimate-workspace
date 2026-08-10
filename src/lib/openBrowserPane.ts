// Shared helper: open (or reuse) the built-in browser pane pointed at `url`.
// Used by every "show the user a web page" path — the chat `open_url` tool
// event (chat:open-browser), the browser MCP roundtrip, pty URL detection,
// and link clicks in chat markdown — so a URL ALWAYS lands in the in-app
// pane instead of the system browser (Tauri's default for target=_blank).
import { browserNavigateTab } from "./ipc";
import { usePanesStore } from "../state/panes";
import { useProjectsStore } from "../state/projects";
import { useUiStore } from "../state/ui";

export function openInBrowserPane(url: string): void {
  const panes = usePanesStore.getState();
  const ui = useUiStore.getState();
  // Surface the Browser tab — every caller of this helper is a "show the user
  // a web page" path, so the panel must actually become visible (mirrors the
  // canvas auto-open for generated artifacts).
  ui.setToolPanelTab("browser");
  ui.setToolPanelCollapsed(false);
  const existing = panes.panes.find(
    (p) => p.data.kind === "browser" && !p.data.collapsed,
  );
  if (existing && existing.data.kind === "browser") {
    const tab = existing.data.tabs[existing.data.activeTabIndex];
    if (tab) {
      panes.setBrowserUrl(existing.paneId, url, tab.tabId);
      void browserNavigateTab(existing.paneId, tab.tabId, url).catch(() => {});
    }
    panes.focusPane(existing.paneId);
    return;
  }
  panes.addPane({
    kind: "browser",
    url,
    projectId: useProjectsStore.getState().selectedProjectId,
  });
}
