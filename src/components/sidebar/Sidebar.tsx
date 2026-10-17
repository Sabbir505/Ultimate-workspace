// Sidebar (Â§5): inbox-style layout â€” brand/search header, Artifacts,
// Automations, Skills & Loops, then the Chat History inbox (unbound chats in
// one flat list, two lines per row: title + working-spinner/relative time,
// then the project Â· branch context and the provider/harness/local-model brand
// icon). The full-screen/overlay entries (Vault / Wiki / Bots in the bottom
// bar; Cost / Pair / Logs / Settings there too) do not live in this rail.
// Chats bound
// to a project are nested under that project in the Projects panel, so they
// are filtered out of this list.
//
// Visual style: white / frosted glass (light) with a matching dark variant.
// The <aside> shell is bg-white/95 in light, bg-slate-900/60 in dark, both
// with backdrop-blur. Interactive surfaces are bg-gray-100 (light) /
// bg-white/10 (dark), darkening slightly on hover. Selected items get a
// darker bg + border. Text uses gray-700/gray-900 (light) and slate-200/
// white (dark). All Tailwind classes use dark: variants keyed to
// [data-theme="dark"] so a single source of truth covers both themes.
import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/react/shallow";

import { useChatRowActions } from "./chatRowActions";
import { preloadView } from "../../lib/viewPreload";
import {
  ArrowLeft,
  ArrowRight,
  MessageCirclePlus,
  MessageSquare,
  Search,
  CalendarClock,
  Folders,
  Library,
} from "lucide-react";
import { useProjectsStore } from "../../state/projects";
import { useProjectsSidebarStore } from "../../state/projectsSidebar";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { useArtifactsStore } from "../../state/artifacts";
import { useAppearanceStore } from "../../state/appearance";
import { useNewChatAction } from "../../hooks/useNewChatAction";
import { useViewNav } from "../../hooks/useViewNav";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { relativeTime } from "../../lib/relativeTime";
import {
  groupChatSessions,
  nestedParentId,
  type ChatGroupRow,
} from "../../lib/chatSessionGroups";
import { ArtifactLibrary } from "./ArtifactLibrary";
import {
  ChatSessionGroupHeader,
  ChatSessionRowMemo as ChatSessionRow,
  type ChatSessionRowData,
} from "../chat/ChatSessionRow";
import { AppVersion } from "./AppVersion";
import { UpdateButton } from "./UpdateButton";
import { BotPetDock } from "../pet/BotPetDock";

/** Stable empty map for the "needs input" selectors below: a fresh `{}` per
 *  notification would make zustand re-render on every store change (and the
 *  per-test mock stores omit these fields entirely). */
const EMPTY_MAP: Record<string, never> = {};

/** One entry of the virtualized Chat History list: a section header or a chat
 *  row (itself possibly nested under a parent). */
type ChatListEntry =
  | { kind: "header"; key: string; label: string }
  | { kind: "row"; key: string; row: ChatGroupRow<ChatSessionRowData> };

/** Sidebar header block: Relay wordmark (collapse control), back/forward,
 *  and the search trigger — with the optional user-uploaded art behind it
 *  (Settings → Appearance → Sidebar art). Extracted from Sidebar so the art
 *  rendering can be tested without the full list machinery. */
export function SidebarHeader() {
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const { backToChat, back: navBack, forward: navForward, canBack, canForward } = useViewNav();
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  // Full-page views (logs / automations / vault) swap the back/forward pair
  // for ONE back arrow — on those pages the only place to go is back to what
  // you were reading (navBack also restores the previous chat selection), so
  // Forward is dead weight and the pair just added noise.
  const inFullPageView =
    activeView === "logs" ||
    activeView === "automations" ||
    activeView === "vault" ||
    activeView === "wiki";
  const exitFullPageView = () => {
    // "Back to chat" means CHAT: skip over intermediate full-page views
    // (wiki → vault → Back must land on the chat you were reading, not on
    // vault again). Falls back to a plain chat view when the history behind
    // has no chat entry (deep link straight into the view).
    if (!backToChat()) setActiveView("chat");
  };
  const headerArt = useAppearanceStore((s) => s.artData);
  // Load once per app boot; the Appearance panel refreshes the store after
  // an import/clear so this picks the change up without a remount.
  const refreshArt = useAppearanceStore((s) => s.refresh);
  const artLoaded = useAppearanceStore((s) => s.loaded);
  useEffect(() => {
    if (!artLoaded) void refreshArt();
  }, [artLoaded, refreshArt]);
  return (
    <div
      data-tauri-drag-region
      className={`relative overflow-hidden p-3${headerArt ? " sidebar-header-art" : " border-b border-gray-200 dark:border-white/20"}`}
    >
      {headerArt && (
        // Art + scrim on their own masked layer: the mask feathers the whole
        // composite to transparent at the bottom, so the art melts into the
        // sidebar below instead of stopping at a hard header edge. The layer
        // ignores pointers so the drag region keeps working through it.
        <div
          aria-hidden
          className="sidebar-header-art-layer"
          style={{
            backgroundImage: `linear-gradient(180deg, rgba(8, 10, 14, 0.5), rgba(8, 10, 14, 0.72)), url(${headerArt})`,
          }}
        />
      )}
      <div className="relative">
      {/* The brand doubles as the collapse control (no separate panel icon);
          back/forward sit at the header's right edge. */}
      <div className="flex items-center justify-between mb-2">
        {/* min-w-0 so a long prerelease version (e.g. 0.6.1-staging.1)
            ellipsizes instead of pushing the nav cluster off the header. */}
        <span className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            className="sidebar-brand-btn sidebar-wordmark select-none px-1.5 py-0.5 -ml-1.5 rounded-md"
            onClick={toggleSidebar}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            Relay
          </button>
          <AppVersion />
        </span>
        <span className="flex items-center flex-shrink-0">
          <UpdateButton />
          {inFullPageView ? (
            <button
              type="button"
              className="sidebar-nav-btn"
              onClick={exitFullPageView}
              title="Back to chat"
              aria-label="Back to chat"
            >
              <ArrowLeft size={14} strokeWidth={1.8} />
            </button>
          ) : (
            <>
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
            </>
          )}
        </span>
      </div>
      {/* Docked bot pets, directly above the search box: one per bot that
          chose a pet (clicking one opens that bot). They live here OR on the
          composer — drag a pet to the other home to move them. */}
      <BotPetDock myHome="sidebar" compact />
      <div className="flex items-center gap-2">
        {/* Search / command palette trigger */}
        <button
          onClick={() => setPaletteOpen(true)}
          className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white transition-all duration-150 active:scale-95"
          title="Search (Cmd/Ctrl+K)"
        >
          <Search size={14} strokeWidth={1.8} />
          <span className="text-xs font-medium">Search</span>
        </button>
      </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const projects = useProjectsStore((s) => s.projects);
  // Per-project git status (branch) — polled by the projects store; rows
  // fall back to the project name alone when a branch isn't known yet.
  const gitStatuses = useProjectsStore((s) => s.gitStatuses);
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const setGitPromptProjectId = useUiStore((s) => s.setGitPromptProjectId);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  // Projects panel (second sidebar) — open state + toggle, persisted.
  const projectsPanelOpen = useProjectsSidebarStore((s) => s.open);
  const toggleProjectsSidebar = useProjectsSidebarStore((s) => s.toggleOpen);
  // Browser-style back/forward over views AND visited chats (shared with
  // the collapsed rail so both clusters behave identically).
  const { back: navBack, forward: navForward, canBack, canForward } = useViewNav();

  // Chat store
  const chatSessions = useChatStore((s) => s.sessions);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  // Per-chat project binding (newer of the two binding paths: DB column via
  // s.projectId, or the newer sessionProjects map).
  const sessionProjects = useChatStore((s) => s.sessionProjects);
  // Chats pointed at an arbitrary folder via the composer's folder notch —
  // shown on the inbox row's second line when there's no bound project.
  const cwdOverrides = useChatStore((s) => s.cwdOverrides);
  // Every session id currently streaming — the sidebar row needs the spinner
  // even for background sessions (a user working in chat A must still see
  // chat B is responding). The old selector filtered to the active session
  // only, so nested-project background chats never lit up.
  // useShallow: Object.keys allocates a fresh array per store notification
  // (i.e. every streamed token) — shallow-compare the ids so the sidebar only
  // re-renders when the SET of streaming sessions actually changes.
  const streamingIds = useChatStore(useShallow((s) => Object.keys(s.streaming)));
  // A session "needs input" while it holds a pending approval, question, or
  // plan proposal — the three event-driven cards that PAUSE its turn until the
  // user acts. (Errors are not input; they keep their own per-chat banner.)
  const pendingApprovals = useChatStore((s) => s.pendingApprovals ?? EMPTY_MAP);
  const pendingQuestions = useChatStore((s) => s.pendingQuestions ?? EMPTY_MAP);
  const pendingPlanProposals = useChatStore((s) => s.pendingPlanProposals ?? EMPTY_MAP);
  const chatsNeedingInput = useMemo(
    () =>
      new Set([
        ...Object.keys(pendingApprovals),
        ...Object.keys(pendingQuestions),
        ...Object.keys(pendingPlanProposals),
      ]),
    [pendingApprovals, pendingQuestions, pendingPlanProposals],
  );
  const chatConfig = useChatStore((s) => s.config);
  const lastSelection = useChatStore((s) => s.lastSelection);
  const chatLoaded = useChatStore((s) => s.loaded);
  const selectSession = useChatStore((s) => s.selectSession);
  const newChat = useChatStore((s) => s.newChat);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const renameChat = useChatStore((s) => s.renameChat);
  const setStarred = useChatStore((s) => s.setStarred);
  const setUnread = useChatStore((s) => s.setUnread);
  const toggleSessionWorktree = useChatStore((s) => s.toggleSessionWorktree);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadConfig = useChatStore((s) => s.loadConfig);

  // Artifacts count
  const artifactItems = useArtifactsStore((s) => s.items);

  const handleNewChat = useNewChatAction();

  // Shared with ProjectsSidebar (audit M: DRY) — the eight row actions and
  // their toasts lived twice and drifted.
  const {
    handleSelectChat,
    handleDeleteChat,
    handleRenameChat,
    handleToggleStar,
    handleSetUnread,
    handleExportChat,
    handleOpenSplitChat,
    handleForkChat,
  } = useChatRowActions();

  useEffect(() => {
    if (!chatLoaded) {
      void loadSessions();
      void loadConfig();
    }
  }, [chatLoaded, loadSessions, loadConfig]);

  // Inbox list: unbound chats only. A chat bound to a project lives nested
  // under that project in the Projects panel — listing it here too showed
  // every project chat in TWO places at once. A binding that points at a
  // project which no longer exists has no other home, so it stays here.
  // Starred chats float to the top, then most-recent.
  // nowTick: recomputes the precomputed timeLabels twice a minute so a row's
  // "2m ago" doesn't freeze when the app is idle (the store only pushes
  // session-list changes on real activity).
  const nowTick = useRelativeTimeTick();
  const chatRowData: ChatSessionRowData[] = useMemo(
    () =>
      chatSessions
        .filter((s) => {
          // A bot's sessions (its thread AND its runs) live in the Bots view
          // rail now: clicking a bot opens its thread, and its runs sit in the
          // bot's activity rail (docs/architecture/BOTS.md). Chat History is
          // for the user's own conversations, so no bot-bound session shows
          // here. A session unbound by `delete_bot` reappears as a plain chat.
          if (s.botId != null || s.botRole === "run") return false;
          const projectId = s.projectId ?? sessionProjects[s.id] ?? null;
          return projectId == null || !projects.some((p) => p.id === projectId);
        })
        .map((s) => {
          const projectId = s.projectId ?? sessionProjects[s.id] ?? null;
          const project = projectId
            ? projects.find((p) => p.id === projectId) ?? null
            : null;
          const overridePath = cwdOverrides[s.id] ?? null;
          const folderName = overridePath
            // Windows paths use backslashes — split on both separators.
            ? overridePath.split(/[\\/]/).filter(Boolean).pop() ?? null
            : null;
          const branchName = s.worktreePath
            ? `relay/${s.id}` // isolated-worktree branch naming (P0 §3.1.1)
            : projectId
              ? gitStatuses[projectId]?.branch ?? null
              : null;
          return {
            id: s.id,
            title: s.title ?? "Untitled Chat",
            lastActiveAt: s.lastActiveAt,
            timeLabel: relativeTime(s.lastActiveAt),
            lastMessage: undefined,
            starred: s.starred ?? false,
            unread: s.unread ?? false,
            worktreePath: s.worktreePath ?? null,
            projectName: project?.name ?? folderName ?? null,
            branchName,
            agent: s.agent ?? null,
            provider: s.provider ?? null,
            // Child provenance: an agent-spawned session or a sidechat nests
            // under its parent in the list below, not as a top-level row.
            parentId: nestedParentId(s.origin),
          };
        })
        .sort(
          (a, b) =>
            Number(b.starred) - Number(a.starred) || b.lastActiveAt - a.lastActiveAt,
        ),
    [chatSessions, sessionProjects, projects, gitStatuses, cwdOverrides, nowTick],
  );

  // Group the flat inbox into Needs input / Working / Completed and nest each
  // agent-spawned child under its parent (see ./chatSessionGroups). The render
  // list is the flat seq of section headers + rows so the windowed list can
  // virtualize headers and rows uniformly.
  const streamingSet = useMemo(() => new Set(streamingIds), [streamingIds]);
  const chatGroups = useMemo(
    () =>
      groupChatSessions(chatRowData, {
        isWorking: (r) => streamingSet.has(r.id),
        needsInput: (r) => chatsNeedingInput.has(r.id),
      }),
    [chatRowData, streamingSet, chatsNeedingInput],
  );
  const chatListEntries: ChatListEntry[] = useMemo(() => {
    const out: ChatListEntry[] = [];
    for (const section of chatGroups.sections) {
      out.push({ kind: "header", key: `header:${section.key}`, label: section.label });
      for (const row of section.rows) {
        out.push({ kind: "row", key: row.session.id, row });
      }
    }
    return out;
  }, [chatGroups]);

  // PERF (PERFORMANCE_AUDIT.md mi27/F5): virtualize the flat chat-history
  // list â€” 100+ sessions used to mount 100+ ChatSessionRow subtrees (each
  // with hover action buttons + context menu wiring), making sidebar scroll
  // stutter. Rows self-measure via measureElement.
  const chatListRef = useRef<HTMLDivElement>(null);
  const chatListVirtualizer = useVirtualizer({
    count: chatListEntries.length,
    getScrollElement: () => chatListRef.current,
    estimateSize: () => 80,
    overscan: 8,
    // Key cached row measurements by entry key, not list index. Switching
    // chats or creating one re-sorts the entries; with index-keyed
    // measurements the cached heights attach to whatever rows moved into
    // those index slots, leaving tall phantom gaps between history rows.
    getItemKey: (index) => chatListEntries[index].key,
  });

  return (
    <aside className="flex flex-col h-full overflow-hidden select-none">
      <SidebarHeader />

      {/* â”€â”€ Pinned upper block (non-scrolling) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="flex-shrink-0">
        {/* Global Views: Artifacts pill + Schedule button (automations) + Subagent */}
        <div className="flex flex-col gap-1 px-2 pt-2 pb-0">
          <ArtifactLibrary />
          <div className="chat-new-btn-row">
            <button
              type="button"
              onClick={() => setActiveView("automations")}
              onPointerEnter={() => preloadView("automations")}
              onFocus={() => preloadView("automations")}
              className={`artifact-lib-title ${activeView === "automations" ? "is-active" : ""}`}
              style={{ width: "100%" }}
              title="Open automations"
              aria-label="Open automations"
            >
              <CalendarClock size={14} strokeWidth={1.8} className="artifact-lib-title-icon" />
              <span className="artifact-lib-title-label">Automations</span>
            </button>
            {/* Skills & Loops — moved down from the window's bottom bar, so the
                library reads as part of the workspace's own nav stack. */}
            <button
              type="button"
              onClick={() => setActiveView("skills")}
              onPointerEnter={() => preloadView("skills")}
              onFocus={() => preloadView("skills")}
              className={`artifact-lib-title ${activeView === "skills" ? "is-active" : ""}`}
              style={{ width: "100%" }}
              title="Skills Library"
              aria-label="Skills Library"
            >
              <Library size={14} strokeWidth={1.8} className="artifact-lib-title-icon" />
              <span className="artifact-lib-title-label">Skills &amp; Loops</span>
            </button>
            {/* Vault / Wiki / Bots moved to the window's bottom bar
                (common/BottomBar) as icon-only entries. */}
            {/* Projects — toggles the nested projects panel that opens beside
                this sidebar (state in useProjectsSidebarStore, persisted). */}
            <button
              type="button"
              onClick={toggleProjectsSidebar}
              className={`artifact-lib-title ${projectsPanelOpen ? "is-active" : ""}`}
              style={{ width: "100%" }}
              title="Open projects"
              aria-label="Open projects"
            >
              <Folders size={14} strokeWidth={1.8} className="artifact-lib-title-icon" />
              <span className="artifact-lib-title-label">Projects</span>
            </button>
          </div>
        </div>
      </div>

      {/* â”€â”€ Recent History â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {/* Label stays pinned; only the chat list below scrolls. pt-1 keeps the
          gap below Projects identical to the 4px rhythm of the nav stack. */}
      <div className="px-2 pt-1 pb-1 flex-shrink-0">
          <div className="sidebar-section-header flex items-center gap-1 mb-1">
            <span className="sidebar-section-label">
              <MessageSquare size={14} strokeWidth={1.8} className="sidebar-section-label-icon" />
              Chat History
            </span>
          {/* New Chat â€” same "+" affordance as the Projects header */}
          <button
            onClick={handleNewChat}
            className="sidebar-quiet-btn p-2 rounded-md bg-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white transition-all duration-150 active:scale-95"
            title="New Chat"
            aria-label="New Chat"
          >
            <MessageCirclePlus size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      {/* â”€â”€ Scrolling chat list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="flex-1 overflow-y-auto sidebar-thin-scroll min-h-0" ref={chatListRef}>
        {chatListEntries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 px-3">
            <MessageSquare size={20} className="text-gray-300 dark:text-slate-400" strokeWidth={1.5} />
            <span className="text-xs text-gray-500 dark:text-slate-300">No chats yet</span>
          </div>
        ) : (
          <div
            style={{
              height: chatListVirtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {chatListVirtualizer.getVirtualItems().map((vi) => {
              const entry = chatListEntries[vi.index];
              return (
                <div
                  key={entry.key}
                  data-index={vi.index}
                  ref={chatListVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {entry.kind === "header" ? (
                    <ChatSessionGroupHeader label={entry.label} />
                  ) : (
                    <ChatSessionRow
                      session={entry.row.session}
                      active={entry.row.session.id === activeChatSessionId}
                      working={entry.row.working}
                      nested={entry.row.nested}
                      depth={entry.row.depth}
                      lastChild={entry.row.lastChild}
                      completed={entry.row.completed}
                      needsInput={entry.row.needsInput}
                      onSelect={handleSelectChat}
                      onDelete={handleDeleteChat}
                      onRename={handleRenameChat}
                      onToggleStar={handleToggleStar}
                      onSetUnread={handleSetUnread}
                      onExport={handleExportChat}
                      onOpenSplit={handleOpenSplitChat}
                      onFork={handleForkChat}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

    </aside>
  );
}
