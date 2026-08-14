// App shell: sidebar + main area (toolbar, chat layout with the right tool
// panel), plus overlay views (settings / skills / cost), command palette,
// peek panel, project settings, and the replace-LRU-pane confirmation
// (§4.3 step 4).
//
// Lazy-load each overlay view (Settings, Skills, Cost) so the initial bundle
// stays small — these panels are heavy (Settings is the largest) and only
// load when the user actually navigates to them.
//
// CommandPalette is also lazy: it pulls in fuzzy search + relative-time libs
// (~6 KB) and is invisible until the user hits Cmd/Ctrl+K. Sidebar stays
// eager because it's the first thing visible on every page.
import { lazy, Suspense, useEffect, useRef } from "react";
import { Modal } from "./components/common/Modal";
import { ToastHost } from "./components/common/ToastHost";
import { OnboardingBanner } from "./components/onboarding/OnboardingBanner";
// ToolPanel (right-side tool/agents/artifact panel) statically imports
// react-markdown via SubagentPanel — lazy so it leaves the entry chunk
// (PERFORMANCE_AUDIT.md item 12).
const ToolPanel = lazy(() => import("./components/panes/ToolPanel").then((m) => ({ default: m.ToolPanel })));
import { PeekPanel } from "./components/peek/PeekPanel";
import { ProjectSettingsPanel } from "./components/sidebar/ProjectSettingsPanel";
import { Sidebar } from "./components/sidebar/Sidebar";
import { PanelIcon } from "./components/common/PanelIcon";
import { ModelDownloadIndicator } from "./components/settings/ModelDownloadIndicator";
import { ChatView } from "./components/chat/ChatView";
import { GitToolsSidebar } from "./components/chat/GitToolsSidebar";
const CommandPalette = lazy(() => import("./components/command-palette/CommandPalette").then((m) => ({ default: m.CommandPalette })));
import { useChatEvents } from "./hooks/useChatEvents";
import { useBrowserMcpEvents } from "./hooks/useBrowserMcpEvents";
import { useGitStatusPolling } from "./hooks/useGitStatusPolling";
import { useKeybindings } from "./hooks/useKeybindings";
import { useModelDownloadEvents } from "./hooks/useModelDownloadEvents";
import { usePtyEvents } from "./hooks/usePtyEvents";
import { usePaneMemory } from "./hooks/usePaneMemory";
import { useTheme } from "./hooks/useTheme";
import { confirmReplaceLru } from "./lib/sessionLauncher";
import { useProjectsStore } from "./state/projects";
import { useSettingsStore } from "./state/settings";
import { useSkillsStore } from "./state/skills";
import { useUiStore } from "./state/ui";
import { useUpdaterStore, wireUpdaterEvents, SHOW_FAKE_UPDATE } from "./state/updater";

// Lazy-loaded overlay views. They're only fetched the first time the user
// opens them, so the initial chat page skips downloading ~700 KB of
// settings + cost + skills code (Settings is the largest single chunk).
const SettingsView = lazy(() => import("./components/settings/SettingsView").then((m) => ({ default: m.SettingsView })));
const SkillsLibrary = lazy(() => import("./components/skills-library/SkillsLibrary").then((m) => ({ default: m.SkillsLibrary })));
const CostDashboard = lazy(() => import("./components/cost-dashboard/CostDashboard").then((m) => ({ default: m.CostDashboard })));
const AutomationsView = lazy(() => import("./components/automations/AutomationsView").then((m) => ({ default: m.AutomationsView })));

export default function App() {
  const activeView = useUiStore((s) => s.activeView);
  const pendingReplace = useUiStore((s) => s.pendingReplace);
  const setPendingReplace = useUiStore((s) => s.setPendingReplace);
  const setGitPromptProjectId = useUiStore((s) => s.setGitPromptProjectId);
  const projectSettingsFor = useUiStore((s) => s.projectSettingsFor);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toolPanelCollapsed = useUiStore((s) => s.toolPanelCollapsed);
  const toggleToolPanel = useUiStore((s) => s.toggleToolPanel);
  const gitPromptProjectId = useUiStore((s) => s.gitPromptProjectId);
  const gitPromptProject = useProjectsStore((s) =>
    gitPromptProjectId ? s.projects.find((p) => p.id === gitPromptProjectId) ?? null : null,
  );
  const markGitRepo = useProjectsStore((s) => s.markGitRepo);

  // Bootstrap: settings first (theme), then projects/sessions/harnesses, skills.
  useEffect(() => {
    void useSettingsStore.getState().load();
    void useProjectsStore.getState().loadAll();
    void useSkillsStore.getState().load();

    // Auto-updater: wire download-progress + installed events, then check on
    // startup and every 4 hours. A check is a single HTTP GET + semver compare;
    // a found update surfaces the green Update button in the sidebar header.
    // Skipped entirely when the dev-only fake-update flag is on, so the real
    // check's "up to date" response doesn't clobber the mock seed.
    wireUpdaterEvents();
    if (SHOW_FAKE_UPDATE) return;
    const updaterStore = useUpdaterStore.getState();
    void updaterStore.check();
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    const timer = window.setInterval(() => void updaterStore.check(), FOUR_HOURS);
    return () => window.clearInterval(timer);
  }, []);

  useTheme();
  useKeybindings();
  usePtyEvents();
  useChatEvents();
  usePaneMemory();
  useModelDownloadEvents();
  useBrowserMcpEvents();
  useGitStatusPolling();

  // Sync modal states into the UI store so native webviews know to hide.
  // Each modal registers its OWN id (M22) — closing one must not re-expose
  // webviews while another is still open.
  const setModalOpen = useUiStore((s) => s.setModalOpen);
  useEffect(() => {
    setModalOpen("app:pending-replace", !!pendingReplace);
    setModalOpen("app:git-prompt", !!gitPromptProject);
  }, [pendingReplace, gitPromptProject, setModalOpen]);

  const pendingSession = pendingReplace
    ? useProjectsStore.getState().sessions.find((s) => s.id === pendingReplace.sessionId)
    : null;

  return (
    <div className="app">
      <ToastHost />
      {!sidebarCollapsed && <div className="sidebar"><Sidebar /></div>}

      <div className="main">
        <div className="toolbar">
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
          <ModelDownloadIndicator />
          <span className="spacer" />
          <button
            className={`ghost toolbar-icon-btn${toolPanelCollapsed ? "" : " active"}`}
            onClick={toggleToolPanel}
            title="Toggle side panel"
            aria-label="Toggle side panel"
          >
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="15" y1="4" x2="15" y2="20" />
            </svg>
          </button>
        </div>

        <OnboardingBanner />

        {activeView === "chat" ? (
          <div className="grid-wrap chat-grid-wrap">
            <ChatView />
            <Suspense fallback={null}>
              <ToolPanel />
            </Suspense>
          </div>
        ) : activeView === "automations" ? (
          <Suspense fallback={null}>
            <AutomationsView />
          </Suspense>
        ) : null}
      </div>

      {/* Overlays — mounted lazily so the heaviest view (Settings) only
          downloads when the user actually opens it. The chat view is the
          default landing surface, so we keep it eager. */}
      {activeView === "settings" && (
        <Suspense fallback={null}>
          <SettingsView />
        </Suspense>
      )}
      {activeView === "skills" && (
        <Suspense fallback={null}>
          <SkillsLibrary />
        </Suspense>
      )}
      {activeView === "cost" && (
        <Suspense fallback={null}>
          <CostDashboard />
        </Suspense>
      )}
      {projectSettingsFor && <ProjectSettingsPanel />}
      <PeekPanel />
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>

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
