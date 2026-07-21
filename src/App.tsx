// App shell: sidebar + main area (toolbar, pane grid, broadcast bar), plus
// overlay views (settings / skills / cost), command palette, peek panel,
// project settings, and the replace-LRU-pane confirmation (§4.3 step 4).
import { useEffect } from "react";
import { CommandPalette } from "./components/command-palette/CommandPalette";
import { CostDashboard } from "./components/cost-dashboard/CostDashboard";
import { Modal } from "./components/common/Modal";
import { OnboardingBanner } from "./components/onboarding/OnboardingBanner";
import { BroadcastBar } from "./components/panes/BroadcastBar";
import { ChatBrowserSplit, PaneGrid } from "./components/panes/PaneGrid";
import { PeekPanel } from "./components/peek/PeekPanel";
import { SettingsView } from "./components/settings/SettingsView";
import { ProjectSettingsPanel } from "./components/sidebar/ProjectSettingsPanel";
import { Sidebar } from "./components/sidebar/Sidebar";
import { PanelIcon } from "./components/common/PanelIcon";
import { SkillsLibrary } from "./components/skills-library/SkillsLibrary";
import { ChatView } from "./components/chat/ChatView";
import { useChatEvents } from "./hooks/useChatEvents";
import { useGitStatusPolling } from "./hooks/useGitStatusPolling";
import { useKeybindings } from "./hooks/useKeybindings";
import { usePtyEvents } from "./hooks/usePtyEvents";
import { useTheme } from "./hooks/useTheme";
import { exportFocusedSession } from "./lib/exportSession";
import { confirmReplaceLru } from "./lib/sessionLauncher";
import { MAX_PANES, usePanesStore } from "./state/panes";
import { useProjectsStore } from "./state/projects";
import { useSettingsStore } from "./state/settings";
import { useSkillsStore } from "./state/skills";
import { useUiStore } from "./state/ui";

export default function App() {
  const activeView = useUiStore((s) => s.activeView);
  const pendingReplace = useUiStore((s) => s.pendingReplace);
  const setPendingReplace = useUiStore((s) => s.setPendingReplace);
  const setGitPromptProjectId = useUiStore((s) => s.setGitPromptProjectId);
  const projectSettingsFor = useUiStore((s) => s.projectSettingsFor);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const broadcast = usePanesStore((s) => s.broadcast);
  const setBroadcastEnabled = usePanesStore((s) => s.setBroadcastEnabled);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const gitPromptProjectId = useUiStore((s) => s.gitPromptProjectId);
  const gitPromptProject = useProjectsStore((s) =>
    gitPromptProjectId ? s.projects.find((p) => p.id === gitPromptProjectId) ?? null : null,
  );
  const markGitRepo = useProjectsStore((s) => s.markGitRepo);
  const lastBrowserUrl = useSettingsStore((s) => s.lastBrowserUrl);

  // Bootstrap: settings first (theme), then projects/sessions/harnesses, skills.
  useEffect(() => {
    void useSettingsStore.getState().load();
    void useProjectsStore.getState().loadAll();
    void useSkillsStore.getState().load();
  }, []);

  useTheme();
  useKeybindings();
  usePtyEvents();
  useChatEvents();
  useGitStatusPolling();

  const openBrowserPane = () => {
    const store = usePanesStore.getState();
    // Only VISIBLE panes count against MAX_PANES — a minimized browser is
    // parked out of the layout and doesn't occupy a slot.
    const visibleCount = store.panes.filter(
      (p) => !(p.data.kind === "browser" && p.data.collapsed),
    ).length;
    if (visibleCount >= MAX_PANES) return;
    store.addPane({
      kind: "browser",
      url: lastBrowserUrl(selectedProjectId),
      projectId: selectedProjectId,
    });
  };

  // Minimized browser panes: restoring flips `collapsed` back to false so the
  // pane re-enters the grid/split. If the grid is already full (6 visible),
  // bail — the user must free a slot first (same guard as openBrowserPane).
  const minimizedBrowsers = usePanesStore((s) =>
    s.panes.filter((p) => p.data.kind === "browser" && p.data.collapsed),
  );
  const restoreBrowser = () => {
    const store = usePanesStore.getState();
    const visibleCount = store.panes.filter(
      (p) => !(p.data.kind === "browser" && p.data.collapsed),
    ).length;
    if (visibleCount >= MAX_PANES) return;
    // Restore the most-recently-used minimized browser.
    const target = minimizedBrowsers.reduce((a, b) => (a.lastUsedAt > b.lastUsedAt ? a : b));
    store.toggleBrowserCollapsed(target.paneId);
  };

  const pendingSession = pendingReplace
    ? useProjectsStore.getState().sessions.find((s) => s.id === pendingReplace.sessionId)
    : null;

  return (
    <div className="app">
      {!sidebarCollapsed && <Sidebar />}

      {sidebarCollapsed && (
        <button
          className="sidebar-restore"
          onClick={toggleSidebar}
          title="Show sidebar"
          aria-label="Show sidebar"
        >
          <PanelIcon />
        </button>
      )}

      <div className="main">
        <div className="toolbar">
          <strong style={{ fontSize: 14 }}>Conduit</strong>
          <span className="spacer" />
          <button onClick={openBrowserPane} title="Open a browser preview pane (google.com)">
            + Browser Pane
          </button>
          {minimizedBrowsers.length > 0 && (
            <button
              className="broadcast-toggle active"
              onClick={restoreBrowser}
              title="Restore the minimized browser pane back into the grid"
            >
              ▣ Browser ({minimizedBrowsers.length})
            </button>
          )}
          <button
            className={`broadcast-toggle${broadcast.enabled ? " active" : ""}`}
            onClick={() => setBroadcastEnabled(!broadcast.enabled)}
            title="Toggle broadcast mode (Cmd/Ctrl+Shift+B)"
          >
            ⇶ Broadcast
          </button>
          <button onClick={() => void exportFocusedSession()} title="Export focused session as Markdown">
            ⤓ Export
          </button>
        </div>

        <OnboardingBanner />

        {activeView === "chat" ? (
          <div className="grid-wrap chat-grid-wrap">
            <ChatBrowserSplit>
              <ChatView />
            </ChatBrowserSplit>
          </div>
        ) : (
          <div className="grid-wrap">
            <PaneGrid />
            <BroadcastBar />
          </div>
        )}
      </div>

      {/* Overlays */}
      {activeView === "settings" && <SettingsView />}
      {activeView === "skills" && <SkillsLibrary />}
      {activeView === "cost" && <CostDashboard />}
      {projectSettingsFor && <ProjectSettingsPanel />}
      <PeekPanel />
      <CommandPalette />

      {pendingReplace && (
        <Modal
          title="All 6 panes are in use"
          onClose={() => setPendingReplace(null)}
          actions={
            <>
              <button onClick={() => setPendingReplace(null)}>Cancel</button>
              <button className="primary" onClick={() => void confirmReplaceLru()}>
                Replace least-recently-used pane
              </button>
            </>
          }
        >
          <p>
            Opening “{pendingSession?.title ?? "Untitled Session"}” needs a free pane. You can close
            a pane manually, or replace the one you used least recently (its process will be
            terminated; the session stays in history and can be resumed later).
          </p>
        </Modal>
      )}

      {gitPromptProject && (
        <Modal
          title="Initialize git?"
          onClose={() => setGitPromptProjectId(null)}
          actions={
            <>
              <button onClick={() => setGitPromptProjectId(null)}>Skip</button>
              <button
                className="primary"
                onClick={() => {
                  void markGitRepo(gitPromptProject.id);
                  setGitPromptProjectId(null);
                }}
              >
                Initialize git
              </button>
            </>
          }
        >
          <p>
            <span className="mono">{gitPromptProject.path}</span> isn't a git repository yet. Initialize
            git? (recommended — enables worktrees, git status badges, and diff peek)
          </p>
        </Modal>
      )}
    </div>
  );
}
