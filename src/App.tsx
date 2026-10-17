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
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { installTitleBarDrag } from "./lib/titleBarDrag";
import { isFullScreenView } from "./lib/viewKinds";
import { ArrowLeft, ArrowRight, MessageCirclePlus } from "lucide-react";
import { Modal } from "./components/common/Modal";
import { ConfirmDialogHost } from "./components/common/ConfirmDialogHost";
import { PanelIcon } from "./components/common/PanelIcon";
import { ToastHost } from "./components/common/ToastHost";
import { OnboardingBanner } from "./components/onboarding/OnboardingBanner";
import { WorktreeNudgeBanner } from "./components/onboarding/WorktreeNudgeBanner";
import { LocalModelModal } from "./components/onboarding/LocalModelModal";
import { initOnboarding, useOnboardingStore } from "./state/onboarding";
// ToolPanel (right-side tool/agents/artifact panel) statically imports
// react-markdown via SubagentPanel — lazy so it leaves the entry chunk
// (PERFORMANCE_AUDIT.md item 12).
const ToolPanel = lazy(() => import("./components/panes/ToolPanel").then((m) => ({ default: m.ToolPanel })));
import { PeekPanel } from "./components/peek/PeekPanel";
import { ProjectSettingsPanel } from "./components/sidebar/ProjectSettingsPanel";
import { ProjectsSidebar } from "./components/sidebar/ProjectsSidebar";
import { Sidebar } from "./components/sidebar/Sidebar";
import { AppLogo } from "./components/common/AppLogo";
import { NotificationBell } from "./components/common/NotificationBell";
import { BottomBar } from "./components/common/BottomBar";
import { TOOLBAR_SLOT_ID } from "./components/common/ToolbarHeader";
import { ModelDownloadIndicator } from "./components/settings/ModelDownloadIndicator";
import { ChatView } from "./components/chat/ChatView";
import { TtsPlayerBar } from "./components/chat/TtsPlayerBar";
import { ChatSelectionToolbar } from "./components/chat/ChatSelectionToolbar";
// In-app JS document engine (generate_document language:"javascript"): must
// be mounted wherever a chat can run, including the pop-out chat window.
// PERF (2026-09-06): the document-generation runners are only needed while a
// docgen/plan_document turn is executing — lazily loaded so their import
// graph (docdesign helpers, previously pdf.js via rasterize.ts) stays out of
// the entry chunk.
const DocCodeRunner = lazy(() => import("./components/chat/DocCodeRunner").then((m) => ({ default: m.DocCodeRunner })));
const DocDesignRunner = lazy(() => import("./components/chat/DocDesignRunner").then((m) => ({ default: m.DocDesignRunner })));
import { FolderNotch, GitHubNotch } from "./components/chat/ChatComposer";
import { ForkChatModal } from "./components/chat/ForkChatModal";
import { HotkeyOverlay } from "./components/hotkey-overlay/HotkeyOverlay";
import { useChatStore } from "./state/chat";
import { GitToolsSidebar } from "./components/chat/GitToolsSidebar";
const CommandPalette = lazy(() => import("./components/command-palette/CommandPalette").then((m) => ({ default: m.CommandPalette })));
import { useChatEvents } from "./hooks/useChatEvents";
import { useTtsAutoRead, useTtsStreamRead } from "./hooks/useTtsAutoRead";
import { VoiceLoopController } from "./hooks/useVoiceLoop";
import { useAutomationEvents } from "./hooks/useAutomationEvents";
import { useBotEvents } from "./hooks/useBotEvents";
import { useMainChatRestore } from "./hooks/useMainChatRestore";
import { warmCostRollups } from "./hooks/useCostRollups";
import { useBudgetEvents } from "./hooks/useBudgetEvents";
import { useUsageLimitEvents } from "./hooks/useUsageLimitEvents";
import { useMemoryEvents } from "./hooks/useMemoryEvents";
import { useBrowserMcpEvents } from "./hooks/useBrowserMcpEvents";
import { useGitStatusPolling } from "./hooks/useGitStatusPolling";
import { useKeybindings } from "./hooks/useKeybindings";
import { useModelDownloadEvents } from "./hooks/useModelDownloadEvents";
import { usePtyEvents } from "./hooks/usePtyEvents";
import { usePaneMemory } from "./hooks/usePaneMemory";
import { useNewChatAction } from "./hooks/useNewChatAction";
import { useViewNav } from "./hooks/useViewNav";
import { useTheme } from "./hooks/useTheme";
import { useWallpaper } from "./hooks/useWallpaper";
import { usePetStageSettings } from "./hooks/usePetStageSettings";
import { confirmReplaceLru } from "./lib/sessionLauncher";
import { checkAndNotifyHarnessUpdates } from "./lib/harnessUpdates";
import { checkAndNotifyBuildUpdates } from "./lib/buildUpdates";
import { initWorkspacePersistence } from "./lib/workspaceRestore";
import { initAppFocusTracking } from "./lib/appFocus";
import { monoFontStack, uiFontStack } from "./lib/fonts";
import {
  loadSettingsView,
  loadSkillsLibrary,
  loadCostDashboard,
  loadWikiView,
  loadAutomationsView,
  loadBotsView,
  loadVaultView,
  loadLogsView,
  preloadAllViews,
} from "./lib/viewPreload";
import { useProjectsStore } from "./state/projects";
import { useProjectsSidebarStore } from "./state/projectsSidebar";
import { useSettingsStore } from "./state/settings";
import { useSkillsStore } from "./state/skills";
import { useUiStore } from "./state/ui";
import { useUpdaterStore, wireUpdaterEvents } from "./state/updater";
import { useOcclusion } from "./hooks/useOcclusion";
import { tauriRuntimeAvailable } from "./lib/ipc";

// Lazy-loaded overlay views. They're only fetched the first time the user
// opens them, so the initial chat page skips downloading ~700 KB of
// settings + cost + skills code (Settings is the largest single chunk).
const SettingsView = lazy(() => loadSettingsView().then((m) => ({ default: m.SettingsView })));
const SkillsLibrary = lazy(() => loadSkillsLibrary().then((m) => ({ default: m.SkillsLibrary })));
const CostDashboard = lazy(() => loadCostDashboard().then((m) => ({ default: m.CostDashboard })));
const WikiView = lazy(() => loadWikiView().then((m) => ({ default: m.WikiView })));
const AutomationsView = lazy(() => loadAutomationsView().then((m) => ({ default: m.AutomationsView })));
// Bots (named persistent agents — docs/architecture/BOTS.md): the rail + the
// bot's own conversation. Real-view-swap like automations/vault, lazily loaded
// so the bots surface never rides in the entry chunk.
const BotsView = lazy(() => loadBotsView().then((m) => ({ default: m.BotsView })));
// Vault (markdown knowledge base) — same real-view-swap shape as
// automations, lazily loaded (CodeMirror + the markdown pipeline stay out
// of the entry chunk until the user opens the vault).
const VaultView = lazy(() => loadVaultView().then((m) => ({ default: m.VaultView })));
// Subagent (declarative subagents — research doc §C.5 item 3 / Phase 2.5): the
// agent registry plus the manual "Run" surface and run history. Real-view-swap
// like automations/vault, lazily loaded.
// Logs (local-model request log + gateway). Real-view-swap like subagent/vault,
// lazily loaded so the log table never rides in the entry chunk.
const LogsView = lazy(() => loadLogsView().then((m) => ({ default: m.LogsView })));
// Welcome wizard (PRD §9): lazy like the overlays — existing users never see
// it, so its chunk shouldn't ride along with the entry bundle.
const WelcomeWizard = lazy(() => import("./components/onboarding/WelcomeWizard").then((m) => ({ default: m.WelcomeWizard })));
// Split-chat pane tree (recursive resizable panes + drag-and-drop targets).
import { ChatPaneGrid } from "./components/chat/ChatPaneGrid";
import { mainPaneLeaf } from "./state/chat/paneTree";

export default function App() {
  const activeView = useUiStore((s) => s.activeView);
  const baseView = useUiStore((s) => s.baseView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  // First-run welcome wizard: visibility is decided by initOnboarding() in
  // the bootstrap effect below (after projects load), and replays re-open it
  // through the same store flag.
  const onboardingVisible = useOnboardingStore((s) => s.visible);
  const pendingReplace = useUiStore((s) => s.pendingReplace);
  const setPendingReplace = useUiStore((s) => s.setPendingReplace);
  const setGitPromptProjectId = useUiStore((s) => s.setGitPromptProjectId);
  const projectSettingsFor = useUiStore((s) => s.projectSettingsFor);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  // Full-screen views: the wiki / vault / bots surfaces carry their own
  // project rails, so the sidebar has nothing to offer there — both left
  // panels slide away (same collapse animation as the manual toggle) while
  // one is open. The toolbar grows a Back-to-chat arrow in exchange, since
  // the sidebar header's back control is hidden with the rail.
  const fullScreenView = isFullScreenView(baseView);
  const sidebarHidden = sidebarCollapsed || fullScreenView;
  // Second sidebar: the Projects panel beside the main sidebar. Kept mounted
  // (like .sidebar) so open/close animates as a width slide and the panel's
  // expansion/paging state survives closing it.
  const projectsSidebarOpen = useProjectsSidebarStore((s) => s.open);
  // View + chat back/forward, exposed in the collapsed rail (and expanded
  // sidebar header) — restores both the view and the chat that was open.
  const { back: navBack, forward: navForward, canBack, canForward, backToChat } = useViewNav();
  // Exit a full-screen view: land on the chat the user was reading, skipping
  // any intermediate full-page views (same rule as the sidebar header's
  // back arrow — wiki → vault → Back must land on the chat, not on vault).
  const exitFullScreenView = () => {
    if (!backToChat()) setActiveView("chat");
  };
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
  // Chat header contents: the FOCUSED chat's title — with split panes that's
  // whichever pane the user last interacted with; without one, the plain
  // active session. Project/git chips and the git sidebar follow the same
  // session (selectContextSessionId), so all shared chrome reflects the chat
  // the user is working in.
  const chatPaneTree = useChatStore((s) => s.chatPaneTree);
  const chatTitle = useChatStore((s) => {
    const id = s.focusedChatSessionId ?? s.activeChatSessionId;
    return id ? (s.sessions.find((x) => x.id === id)?.title?.trim() || "New chat") : null;
  });

  // Title-bar maximize glyph state: the toolbar doubles as the window title
  // bar (decorations:false), so the maximize button must track the real
  // window state — the user can also maximize by dragging to the top edge or
  // double-clicking the drag region, so listen rather than assume.
  const [winMaximized, setWinMaximized] = useState(false);
  useEffect(() => {
    // Outside the Tauri runtime (jsdom tests / plain `vite dev` browser
    // session) there is no window to track; `getCurrentWindow()` reads
    // `__TAURI_INTERNALS__` and throws — which crashed the whole shell.
    if (!tauriRuntimeAvailable()) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const refresh = () => void win.isMaximized().then(setWinMaximized).catch(() => {});
    void win
      .onResized(() => {
        // Defer: isMaximized can report stale state mid-resize.
        setTimeout(refresh, 60);
      })
      .then((u) => {
        // Unmount beat the subscription — unlisten now, or the backend
        // listener (and its closure) leaks for the app's lifetime.
        if (disposed) {
          u();
          return;
        }
        unlisten = u;
      });
    refresh();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Title-bar drag through child elements: the portaled view headers
  // (vault/automations/wiki) are full of h1/svg/chip children that Tauri's
  // own drag-region check ignores (it only fires when the event TARGET has
  // the attribute) — so the caption stopped dragging in those views. One
  // delegated handler restores it everywhere (see lib/titleBarDrag).
  useEffect(() => installTitleBarDrag(), []);

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

  // Bot pets are docked by BotPetDock in the two homes (the sidebar search bar
  // and each rendered chat composer) and moved between them by drag; the
  // single-home + drag state lives in state/botPets. The classic companion pet
  // is retired.

  // Bootstrap: settings first (theme), then projects/sessions/harnesses, skills.
  useEffect(() => {
    void useSettingsStore.getState().load();
    // Workspace persistence wires its subscriptions and re-selects the last
    // project (which restores its saved pane layout) — it must run AFTER the
    // projects list exists, hence the loadAll().then chaining. The welcome
    // wizard's first-run gate also needs the loaded project/session counts.
    void useProjectsStore
      .getState()
      .loadAll()
      .then(() => {
        void initOnboarding();
        void initWorkspacePersistence();
      });
    void useSkillsStore.getState().load();
    // Harness update check (quiet, once per app open): an out-of-date harness
    // CLI lands a bell-panel row that deep-links to Settings → Agent
    // harnesses, where the row's Run login button becomes Update.
    void checkAndNotifyHarnessUpdates();

    // Native-build update check (same quiet once-per-open flow): an out-of-
    // date whisper/TTS build lands a bell row deep-linking to Settings →
    // Local Models → Speech, where the build's Install button reads Update.
    void checkAndNotifyBuildUpdates();

    // Auto-updater: wire download-progress + installed events, then check on
    // startup and every 4 hours. A check is a single HTTP GET + semver compare;
    // a found update surfaces the green Update button in the sidebar header.
    wireUpdaterEvents();
    const updaterStore = useUpdaterStore.getState();
    void updaterStore.check();
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    const updaterTimer = window.setInterval(() => void updaterStore.check(), FOUR_HOURS);
    // Usage dashboard warm-up: the rollup cache is in-memory and per-session
    // (useCostRollups), so without a boot fetch the first dashboard open of
    // every launch is the cold path — spinner plus the full window
    // aggregation. Deferred a beat so it doesn't compete with the boot IPC
    // burst above; by the time the dashboard is opened there's a payload to
    // paint immediately.
    const warmTimer = window.setTimeout(() => warmCostRollups(), 2000);
    // Preload the lazy screen chunks once the app is interactive, so a first
    // click on any nav entry opens from cache instead of paying a full chunk
    // fetch (cold opens measured at 80–370 ms before this). Staggered so the
    // imports don't all land in one task.
    const cancelPreload = preloadAllViews();
    return () => {
      window.clearInterval(updaterTimer);
      window.clearTimeout(warmTimer);
      cancelPreload();
    };
  }, []);

  useTheme();
  useWallpaper();
  usePetStageSettings();
  useKeybindings();
  usePtyEvents();
  useChatEvents();
  // Mirrors the persisted read-aloud preference so a finishing turn can honour
  // it without an IPC round-trip (see hooks/useTtsAutoRead).
  useTtsAutoRead();
  useTtsStreamRead();
  useAutomationEvents();
  useBotEvents();
  useMainChatRestore();
  useBudgetEvents();
  useUsageLimitEvents();
  useMemoryEvents();
  usePaneMemory();
  useModelDownloadEvents();
  useBrowserMcpEvents();
  useGitStatusPolling();

  // Focus tracking (module singleton) — drives the "notify only when Relay
  // is in the background" rules for completion sounds + OS toasts.
  useEffect(() => {
    initAppFocusTracking();
  }, []);

  // Chat text zoom (Ctrl +/-/0): publish the multiplier as a CSS variable so
  // every chat surface (bubbles, composer, code blocks, tables) scales at
  // once. Runs in App so both the main window and pop-out chats get it.
  const chatZoom = useSettingsStore((s) => s.chatZoom);
  useEffect(() => {
    document.documentElement.style.setProperty("--chat-zoom", String(chatZoom));
  }, [chatZoom]);

  // App-wide zoom (Ctrl +/-/0): CSS zoom on the root element scales the
  // ENTIRE UI — sidebar, toolbar, panes, composer, settings — like a browser
  // zoom, independent of --chat-zoom which only scales chat text. Runs in App
  // so both the main window and pop-out chats get it.
  const appZoom = useSettingsStore((s) => s.appZoom);
  useEffect(() => {
    document.documentElement.style.setProperty("zoom", String(appZoom));
  }, [appZoom]);

  // Font family picks (Settings → Appearance): publish the resolved stacks as
  // the font tokens so the whole chrome + code/terminals follow. Inline vars
  // shadow tokens.css the same way custom theme colors do.
  const uiFont = useSettingsStore((s) => s.uiFont);
  const monoFont = useSettingsStore((s) => s.monoFont);
  useEffect(() => {
    document.documentElement.style.setProperty("--font-ui", uiFontStack(uiFont));
    document.documentElement.style.setProperty("--font-mono", monoFontStack(monoFont));
  }, [uiFont, monoFont]);

  // Sync modal states into the UI store so native webviews know to hide.
  // Each modal registers its OWN id (M22) — closing one must not re-expose
  // webviews while another is still open.
  useOcclusion("app:pending-replace", !!pendingReplace);
  useOcclusion("app:git-prompt", !!gitPromptProject);

  const pendingSession = pendingReplace
    ? useProjectsStore.getState().sessions.find((s) => s.id === pendingReplace.sessionId)
    : null;

  // Pop-out chat window: standalone ChatView without the shell (no sidebar,
  // no tool panel). Selecting the requested session happens inside a small
  // effect in the popout branch itself.
  if (popout?.kind === "chat") {
  return (
    <div className="popout-chat-root">
      <Suspense fallback={null}>
        <DocCodeRunner />
        <DocDesignRunner />
      </Suspense>
      <ChatSelectionToolbar />
      <ChatView popoutSessionId={popout.session ?? undefined} />
    </div>
  );
  }

  return (
    <div className="app">
      <Suspense fallback={null}>
        <DocCodeRunner />
        <DocDesignRunner />
      </Suspense>
      <ChatSelectionToolbar />
      <ToastHost />
      {/* Hands-free voice loop (renders nothing; listens to the shared
          voiceLoop store and drives the mic / TTS state machine). */}
      <VoiceLoopController />
      {/* Kept mounted so collapse/expand animates as a width slide instead
          of an unmount flash; the collapsed class hides it after the
          transition (visibility) so it can't be interacted with. */}
      <div className={`sidebar${sidebarHidden ? " collapsed" : ""}`} aria-hidden={sidebarHidden}>
        <Sidebar />
      </div>

      {/* Projects panel: the nested project/chat tree, right of the main
          sidebar. Same slide-collapse recipe as .sidebar (kept mounted). */}
      <div className={`projects-sidebar${projectsSidebarOpen && !fullScreenView ? "" : " collapsed"}`} aria-hidden={!projectsSidebarOpen || fullScreenView}>
        <ProjectsSidebar />
      </div>

      <div className="main">
        {/* The toolbar doubles as the window title bar (decorations:false):
            drag anywhere empty, double-click to maximize, and the
            window-control cluster sits at the far right edge. Interactive
            children stay clickable — the drag attribute only fires when the
            event target IS the drag-region element. */}
        <div className="toolbar" data-tauri-drag-region="">
          {/* Left: identity + view nav live in the SIDEBAR's header ("Relay"
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
          {/* Full-screen view (wiki / vault / bots): the sidebar — and with
              it the header's back arrow — is hidden, so the caption carries
              the Back-to-chat control instead. */}
          {fullScreenView && !sidebarCollapsed && (
            <div className="sidebar-collapsed-bar">
              <button
                type="button"
                className="sidebar-nav-btn"
                onClick={exitFullScreenView}
                title="Back to chat"
                aria-label="Back to chat"
              >
                <ArrowLeft size={14} strokeWidth={1.8} />
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
              {/* Split panes close from their own header ✕ (each pane is
                  independent) — no global toolbar close anymore. */}
              <FolderNotch />
              <GitHubNotch />
            </>
          )}
          <ModelDownloadIndicator />
          <span className="spacer" data-tauri-drag-region="" />
          {/* Landing pad for the full-page views' own header chrome —
              Automations / Subagent / Vault portal their header row in here (see
              common/ToolbarHeader), so the caption IS their header instead of
              a second bar stacked above one. It sits AFTER the spacer so a
              portaled header's own left/right groups span the full caption and
              its actions land just inside the window controls; the spacer
              collapses while it's occupied (see shell.css). Empty on the chat
              view, where the title above plays the same role. */}
          <div className="toolbar-view-slot" id={TOOLBAR_SLOT_ID} data-tauri-drag-region="" />
          {/* Notification bell — the durable record behind the title bar.
              Sits just before the side-panel toggle (the rightmost icon). */}
          <NotificationBell />
          <button
            className={`ghost toolbar-icon-btn${toolPanelCollapsed ? "" : " active"}`}
            onClick={toggleToolPanel}
            title="Toggle side panel"
            aria-label="Toggle side panel"
          >
            <PanelIcon side="right" size={16} />
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

        {onboardingVisible && (
          <Suspense fallback={null}>
            <WelcomeWizard />
          </Suspense>
        )}

{/* Settings/Skills/Cost are OVERLAYS mounted on top of the grid — the view
    underneath stays MOUNTED (only automations/vault/subagents/logs are real view
    swaps of the grid's content). Unmounting here blanked the whole app and killed
    the terminal/browser panes every time a footer icon was clicked; the
    panes hide themselves via browserOcclusion (overlay views occlude)
    instead. The grid follows baseView, so opening Settings from the vault
    overlays the vault instead of swapping it for the chat — and closing it
    restores where the user actually was.

    The ToolPanel + TtsPlayerBar are rendered ONCE below the view switch:
    every view hosts the same panel, and a per-branch instance would unmount
    on every chat↔vault↔automations switch — killing browser webviews (full
    page reload on the way back) and churning terminal ptys. */}
        <div className={`grid-wrap chat-grid-wrap${baseView === "chat" && chatPaneTree ? " split-active" : ""}`}>
          {baseView !== "automations" &&
          baseView !== "vault" &&
          baseView !== "logs" &&
          baseView !== "wiki" &&
          baseView !== "bots" ? (
            /* The split-chat pane tree (up to six full chat views, resizable
                gutters, drag-a-session-onto-an-edge). With no splits open the
                same renderer draws the single main pane — identical drop
                targets, so the FIRST drag can create the first split. */
            <ChatPaneGrid node={chatPaneTree ?? mainPaneLeaf()} />
          ) : baseView === "automations" ? (
            <Suspense fallback={null}>
              <AutomationsView />
            </Suspense>
          ) : baseView === "wiki" ? (
            /* Project wiki (§6.15) — a REAL view like automations/vault:
               fills the center area, sidebar + tool panel stay put. */
            <Suspense fallback={null}>
              <WikiView />
            </Suspense>
          ) : baseView === "bots" ? (
            /* Bots — the roster + the selected bot's REAL ChatView. The
               conversation is the same component the main pane renders, so
               tools/approvals/artifacts work identically and the thread also
               opens from chat history. */
            <Suspense fallback={null}>
              <BotsView />
            </Suspense>
          ) : baseView === "logs" ? (
            /* Local-model request log: captured bodies + telemetry. */
            <Suspense fallback={null}>
              <LogsView />
            </Suspense>
          ) : (
            <Suspense fallback={null}>
              <VaultView />
            </Suspense>
          )}
          <Suspense fallback={null}>
            <ToolPanel />
          </Suspense>
          {/* Read-aloud transport. Mounted at the shell, not inside ChatView:
              playback is global, so an artifact voiced from the tools pane must
              keep its controls here. */}
          <TtsPlayerBar />
        </div>
      </div>

      {/* Bottom bar (mirrored title bar): full-window-width strip hosting
          the workspace view entries (Skills / Cost / Pair / Logs /
          Settings). Absolute at the app's bottom edge — the three columns
          stop above it via --bottombar-h (shell.css). */}
      <BottomBar />

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
      <ForkChatModal />
      <HotkeyOverlay />
      {/* In-app confirm prompt (state/confirm.ts) — replaces window.confirm,
          which this webview build rejects (see the module's header). */}
      <ConfirmDialogHost />

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
