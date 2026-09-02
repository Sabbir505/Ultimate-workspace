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
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, ArrowRight, MessageCirclePlus } from "lucide-react";
import { Modal } from "./components/common/Modal";
import { ToastHost } from "./components/common/ToastHost";
import { OnboardingBanner } from "./components/onboarding/OnboardingBanner";
import { WorktreeNudgeBanner } from "./components/onboarding/WorktreeNudgeBanner";
import { LocalModelModal } from "./components/onboarding/LocalModelModal";
// ToolPanel (right-side tool/agents/artifact panel) statically imports
// react-markdown via SubagentPanel — lazy so it leaves the entry chunk
// (PERFORMANCE_AUDIT.md item 12).
const ToolPanel = lazy(() => import("./components/panes/ToolPanel").then((m) => ({ default: m.ToolPanel })));
import { PeekPanel } from "./components/peek/PeekPanel";
import { ProjectSettingsPanel } from "./components/sidebar/ProjectSettingsPanel";
import { Sidebar } from "./components/sidebar/Sidebar";
import { AppLogo } from "./components/common/AppLogo";
import { ModelDownloadIndicator } from "./components/settings/ModelDownloadIndicator";
import { ChatView } from "./components/chat/ChatView";
// In-app JS document engine (generate_document language:"javascript"): must
// be mounted wherever a chat can run, including the pop-out chat window.
import { DocCodeRunner } from "./components/chat/DocCodeRunner";
import { FolderNotch, GitHubNotch } from "./components/chat/ChatComposer";
import { useChatStore } from "./state/chat";
import { GitToolsSidebar } from "./components/chat/GitToolsSidebar";
const CommandPalette = lazy(() => import("./components/command-palette/CommandPalette").then((m) => ({ default: m.CommandPalette })));
import { useChatEvents } from "./hooks/useChatEvents";
import { useAutomationEvents } from "./hooks/useAutomationEvents";
import { useBudgetEvents } from "./hooks/useBudgetEvents";
import { useBrowserMcpEvents } from "./hooks/useBrowserMcpEvents";
import { useGitStatusPolling } from "./hooks/useGitStatusPolling";
import { useKeybindings } from "./hooks/useKeybindings";
import { useModelDownloadEvents } from "./hooks/useModelDownloadEvents";
import { usePtyEvents } from "./hooks/usePtyEvents";
import { usePaneMemory } from "./hooks/usePaneMemory";
import { useNewChatAction } from "./hooks/useNewChatAction";
import { useViewNav } from "./hooks/useViewNav";
import { useTheme } from "./hooks/useTheme";
import { confirmReplaceLru } from "./lib/sessionLauncher";
import { initWorkspacePersistence } from "./lib/workspaceRestore";
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
  const setActiveView = useUiStore((s) => s.setActiveView);
  const pendingReplace = useUiStore((s) => s.pendingReplace);
  const setPendingReplace = useUiStore((s) => s.setPendingReplace);
  const setGitPromptProjectId = useUiStore((s) => s.setGitPromptProjectId);
  const projectSettingsFor = useUiStore((s) => s.projectSettingsFor);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  // View + chat back/forward, exposed in the collapsed rail (and expanded
  // sidebar header) — restores both the view and the chat that was open.
  const { back: navBack, forward: navForward, canBack, canForward } = useViewNav();
  // New Chat from the collapsed rail — same action as the sidebar's "+"
  // (shared hook so both entry points stay in lockstep).
  const handleNewChat = useNewChatAction();
  const toolPanelCollapsed = useUiStore((s) => s.toolPanelCollapsed);
  const toggleToolPanel = useUiStore((s) => s.toggleToolPanel);
  const setToolPanelCollapsed = useUiStore((s) => s.setToolPanelCollapsed);
  const gitPromptProjectId = useUiStore((s) => s.gitPromptProjectId);
  const gitPromptProject = useProjectsStore((s) =>
    gitPromptProjectId ? s.projects.find((p) => p.id === gitPromptProjectId) ?? null : null,
  );
  const markGitRepo = useProjectsStore((s) => s.markGitRepo);
  // Chat header contents: the FOCUSED chat's title — in split view that's
  // whichever half the user last interacted with; without a split, the plain
  // active session. Project/git chips and the git sidebar follow the same
  // session (selectContextSessionId), so all shared chrome reflects the chat
  // the user is working in.
  const splitChatId = useChatStore((s) => s.splitChatSessionId);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  // Which split half the user last interacted with — the tool panel docks to
  // the RIGHT of that half (flex order), so each chat effectively carries its
  // own side panel. Pointer-down on a column updates it.
  const [splitFocus, setSplitFocus] = useState<"main" | "side">("side");
  const focusedSessionId =
    splitChatId && splitFocus === "side" ? splitChatId : activeChatSessionId;
  const chatTitle = useChatStore((s) => {
    const id = s.focusedChatSessionId ?? s.activeChatSessionId;
    return id ? (s.sessions.find((x) => x.id === id)?.title?.trim() || "New chat") : null;
  });
  // Pin the shared chrome to the focused chat (null = main view's session).
  useEffect(() => {
    useChatStore.getState().setFocusedChatSession(
      splitChatId && splitFocus === "side" ? splitChatId : null,
    );
  }, [splitChatId, splitFocus]);
  // Draggable split width: ratio of the chat area (excluding the tool panel)
  // given to the MAIN half. Persisted in the ui store across split sessions.
  const splitRatio = useUiStore((s) => s.chatSplitRatio);
  const setSplitRatio = useUiStore((s) => s.setChatSplitRatio);
  const chatGridRef = useRef<HTMLDivElement>(null);
  const [splitResizing, setSplitResizing] = useState(false);
  // Live-drag the split divider: ratio = pointer X within the chat area
  // (grid width minus the tool panel's own width). Clamped so neither half
  // can collapse; released capture ends the drag.
  const startSplitResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const grid = chatGridRef.current;
      if (!grid) return;
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      setSplitResizing(true);
      const onMove = (ev: PointerEvent) => {
        const panel = grid.querySelector<HTMLElement>(":scope > .tool-panel");
        const panelW = panel ? panel.offsetWidth : 0;
        const total = Math.max(240, grid.clientWidth - panelW);
        const left = grid.getBoundingClientRect().left;
        const ratio = (ev.clientX - left) / total;
        setSplitRatio(Math.min(0.8, Math.max(0.2, ratio)));
      };
      const onUp = () => {
        setSplitResizing(false);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [setSplitRatio],
  );

  // Title-bar maximize glyph state: the toolbar doubles as the window title
  // bar (decorations:false), so the maximize button must track the real
  // window state — the user can also maximize by dragging to the top edge or
  // double-clicking the drag region, so listen rather than assume.
  const [winMaximized, setWinMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    const refresh = () => void win.isMaximized().then(setWinMaximized).catch(() => {});
    void win
      .onResized(() => {
        // Defer: isMaximized can report stale state mid-resize.
        setTimeout(refresh, 60);
      })
      .then((u) => {
        unlisten = u;
      });
    refresh();
    return () => {
      unlisten?.();
    };
  }, []);

  // Pop-out chat window (roadmap #17): when the window is opened with
  // `?popout=chat&session=<id>`, render a standalone ChatView (no sidebar,
  // no tool panel) so the user can keep one chat in a dedicated window.
  const popout = useMemo(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.get("popout") === "chat") {
        return { kind: "chat" as const, session: q.get("session") };
      }
    } catch { /* ignore */ }
    return null;
  }, []);

  // Bootstrap: settings first (theme), then projects/sessions/harnesses, skills.
  useEffect(() => {
    void useSettingsStore.getState().load();
    // Workspace persistence wires its subscriptions and re-selects the last
    // project (which restores its saved pane layout) — it must run AFTER the
    // projects list exists, hence the loadAll().then chaining.
    void useProjectsStore
      .getState()
      .loadAll()
      .then(() => void initWorkspacePersistence());
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
  useAutomationEvents();
  useBudgetEvents();
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

  // Pop-out chat window: standalone ChatView without the shell (no sidebar,
  // no tool panel). Selecting the requested session happens inside a small
  // effect in the popout branch itself.
  if (popout?.kind === "chat") {
    return (
      <div className="popout-chat-root">
        <DocCodeRunner />
        <ChatView popoutSessionId={popout.session ?? undefined} />
      </div>
    );
  }

  return (
    <div className="app">
      <DocCodeRunner />
      <ToastHost />
      {/* Kept mounted so collapse/expand animates as a width slide instead
          of an unmount flash; the collapsed class hides it after the
          transition (visibility) so it can't be interacted with. */}
      <div className={`sidebar${sidebarCollapsed ? " collapsed" : ""}`} aria-hidden={sidebarCollapsed}>
        <Sidebar />
      </div>

      <div className="main">
        {/* The toolbar doubles as the window title bar (decorations:false):
            drag anywhere empty, double-click to maximize, and the
            window-control cluster sits at the far right edge. Interactive
            children stay clickable — the drag attribute only fires when the
            event target IS the drag-region element. */}
        <div className="toolbar" data-tauri-drag-region="">
          {/* Left: identity + view nav live in the SIDEBAR's header ("Conduit"
              + back/forward) — no toolbar duplicates. When the sidebar is
              collapsed (width 0) only the restore logo stays reachable here. */}
          {sidebarCollapsed && (
            <div className="sidebar-collapsed-bar">
              <button
                className="sidebar-restore"
                onClick={toggleSidebar}
                title="Show sidebar"
                aria-label="Show sidebar"
              >
                <AppLogo size={20} />
              </button>
              {/* View + chat back/forward stay reachable while the sidebar
                  is hidden — same buttons as the expanded header. */}
              <button
                type="button"
                className="sidebar-nav-btn"
                onClick={navBack}
                disabled={!canBack}
                title="Back"
                aria-label="Back"
              >
                <ArrowLeft size={14} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="sidebar-nav-btn"
                onClick={navForward}
                disabled={!canForward}
                title="Forward"
                aria-label="Forward"
              >
                <ArrowRight size={14} strokeWidth={1.8} />
              </button>
              {/* New Chat: inherits the previous chat's project/folder
                  binding (store-side); independent when there is none. */}
              <button
                type="button"
                className="sidebar-nav-btn"
                onClick={handleNewChat}
                title="New Chat"
                aria-label="New Chat"
              >
                <MessageCirclePlus size={15} strokeWidth={1.8} />
              </button>
            </div>
          )}
          {activeView === "chat" && (
            <>
              {/* Plain text title — deliberately no pill/border so it reads
                  as a label, not a control. Draggable like dead title-bar
                  space. */}
              <span
                className="toolbar-chat-title"
                data-tauri-drag-region=""
                title={chatTitle ?? undefined}
              >
                {chatTitle}
              </span>
              {/* Split view: the title above already follows the FOCUSED half
                  (main/split) — this is just the one-click close. */}
              {splitChatId && (
                <button
                  className="ghost toolbar-split-close"
                  onClick={() => useChatStore.getState().closeChatSplit()}
                  title="Close split view"
                  aria-label="Close split view"
                >
                  ✕
                </button>
              )}
              <FolderNotch />
              <GitHubNotch />
            </>
          )}
          <ModelDownloadIndicator />
          <span className="spacer" data-tauri-drag-region="" />
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
          {/* Window controls — the title bar's right edge, mirroring native
              Minimize / Maximize / Close order. */}
          <button
            className="titlebar-btn"
            onClick={() => void getCurrentWindow().minimize()}
            title="Minimize"
            aria-label="Minimize window"
          >
            <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
              <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth={1.2} />
            </svg>
          </button>
          <button
            className="titlebar-btn"
            onClick={() => void getCurrentWindow().toggleMaximize()}
            title={winMaximized ? "Restore" : "Maximize"}
            aria-label={winMaximized ? "Restore window" : "Maximize window"}
          >
            {winMaximized ? (
              <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
                <rect x="1" y="3" width="8" height="8" fill="none" stroke="currentColor" strokeWidth={1.2} />
                <path d="M3.5 3V1h8v8h-2" fill="none" stroke="currentColor" strokeWidth={1.2} />
              </svg>
            ) : (
              <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
                <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth={1.2} />
              </svg>
            )}
          </button>
          <button
            className="titlebar-btn titlebar-close"
            onClick={() => getCurrentWindow().close()}
            title="Close"
            aria-label="Close window"
          >
            <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1.5 1.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <OnboardingBanner />

        <WorktreeNudgeBanner />

        <LocalModelModal />

{/* Settings/Skills/Cost are OVERLAYS mounted on top of the chat — the chat
    grid must stay MOUNTED for those views (only "automations" is a real
    view swap). Unmounting here blanked the whole app and killed the
    terminal/browser panes every time a footer icon was clicked; the panes
    hide themselves via browserOcclusion (activeView !== "chat") instead. */}
{activeView !== "automations" ? (
        <div
          ref={chatGridRef}
          className={`grid-wrap chat-grid-wrap${splitChatId ? ` split-active${splitFocus === "main" ? " split-focus-main" : ""}${splitResizing ? " split-resizing" : ""}` : ""}`}
        >
          <div
            className="chat-split-main"
            style={splitChatId ? { flexGrow: splitRatio, flexBasis: 0 } : undefined}
            onPointerDownCapture={() => setSplitFocus("main")}
          >
            <ChatView />
          </div>
          {splitChatId && (
            <>
              <div
                className="chat-split-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Drag to resize the split chats"
                title="Drag to resize"
                onPointerDown={startSplitResize}
              />
              <div
                className="chat-split-side"
                style={{ flexGrow: 1 - splitRatio, flexBasis: 0 }}
                onPointerDownCapture={() => setSplitFocus("side")}
              >
                <ChatView splitSessionId={splitChatId} />
              </div>
            </>
          )}
          <Suspense fallback={null}>
            <ToolPanel />
          </Suspense>
        </div>
      ) : activeView === "automations" ? (
        <div className="grid-wrap chat-grid-wrap">
          <Suspense fallback={null}>
            <AutomationsView />
          </Suspense>
          <Suspense fallback={null}>
            <ToolPanel />
          </Suspense>
        </div>
      ) : null}
      </div>

      {/* Overlays — mounted lazily so the heaviest view (Settings) only
          downloads when the user actually opens it. The chat view is the
          default landing surface, so we keep it eager. */}
      {activeView === "settings" && (
        <Suspense fallback={<div className="overlay-loading"><span className="dev-diff-spinner" aria-hidden="true" /> Loading…</div>}>
          <SettingsView />
        </Suspense>
      )}
      {activeView === "skills" && (
        <Suspense fallback={<div className="overlay-loading"><span className="dev-diff-spinner" aria-hidden="true" /> Loading…</div>}>
          <SkillsLibrary />
        </Suspense>
      )}
      {activeView === "cost" && (
        <Suspense fallback={<div className="overlay-loading"><span className="dev-diff-spinner" aria-hidden="true" /> Loading…</div>}>
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
