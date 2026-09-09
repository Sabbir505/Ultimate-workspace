// Shared helper: open (or reuse) the built-in browser pane pointed at `url`.
// Used by every "show the user a web page" path — the chat `open_url` tool
// event (chat:open-browser), the browser MCP roundtrip, pty URL detection,
// and link clicks in chat markdown — so a URL ALWAYS lands in the in-app
// pane instead of the system browser (Tauri's default for target=_blank).
import { surfaceBrowserTab } from "./sessionLauncher";
import { browserNavigateTab } from "./ipc";
import { usePanesStore } from "../state/panes";
import { useProjectsStore } from "../state/projects";

export function openInBrowserPane(url: string): void {
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
    // Surface THIS pane's Browser chip — an untargeted surface could reveal a
    // different pane than the one that just navigated to the URL.
    surfaceBrowserTab(existing.paneId);
    return;
  }
  const paneId = panes.addPane({
    kind: "browser",
    url,
    projectId: useProjectsStore.getState().selectedProjectId,
  });
  surfaceBrowserTab(paneId);
}
