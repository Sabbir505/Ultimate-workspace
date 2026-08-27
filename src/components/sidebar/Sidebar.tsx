// Sidebar (Â§5): unified single-mode layout â€” New Chat, Artifacts, Connectors,
// Automations (stub), Projects, Chat history, then footer links to Settings /
// Skills Library / Cost Dashboard. Handles the "Add Project" first-launch flow
// (Â§4.1) â€” the not-a-git-repo prompt itself renders at the App top level
// (App.tsx) so it centers on screen like the other modals.
//
// Visual style: white / frosted glass (light) with a matching dark variant.
// The <aside> shell is bg-white/95 in light, bg-slate-900/60 in dark, both
// with backdrop-blur. Interactive surfaces are bg-gray-100 (light) /
// bg-white/10 (dark), darkening slightly on hover. Selected items get a
// darker bg + border. Text uses gray-700/gray-900 (light) and slate-200/
// white (dark). All Tailwind classes use dark: variants keyed to
// [data-theme="dark"] so a single source of truth covers both themes.
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";

import { toastError, toastSuccess, exportChatZip, popOutChat, getMobilePairingInfo, type MobilePairingInfo } from "../../lib/ipc";
import {
  ArrowLeft,
  ArrowRight,
  DollarSign,
  Folder,
  Library,
  MessageSquare,
  Plus,
  Search,
  Settings,
  CalendarClock,
  X,
  QrCode,
} from "lucide-react";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { useArtifactsStore } from "../../state/artifacts";
import { ArtifactLibrary } from "./ArtifactLibrary";
import { ChatSessionRowMemo as ChatSessionRow, type ChatSessionRowData } from "../chat/ChatSessionRow";
import { PanelIcon } from "../common/PanelIcon";
import { relativeTime, shortRelativeTime } from "../../lib/relativeTime";
import { UpdateButton } from "./UpdateButton";
import { seedFakeUpdate, SHOW_FAKE_UPDATE } from "../../state/updater";

export function Sidebar() {
  const [projectsCollapsed, setProjectsCollapsed] = useState(true);
  // Quiet projects list: show a capped set and reveal the rest on demand.
  const visibleProjectCount = 6;
  const [showAllProjects, setShowAllProjects] = useState(false);
  const projects = useProjectsStore((s) => s.projects);
  const loaded = useProjectsStore((s) => s.loaded);
  const addProjectAtPath = useProjectsStore((s) => s.addProjectAtPath);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const selectProject = useProjectsStore((s) => s.selectProject);
  const expanded = useProjectsStore((s) => s.expanded);
  const toggleExpanded = useProjectsStore((s) => s.toggleExpanded);
  const setExpanded = useProjectsStore((s) => s.setExpanded);
  const removeProjectById = useProjectsStore((s) => s.removeProjectById);
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const setGitPromptProjectId = useUiStore((s) => s.setGitPromptProjectId);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  // Browser-style back/forward over visited views.
  const viewHistory = useUiStore((s) => s.viewHistory);
  const viewIndex = useUiStore((s) => s.viewIndex);
  const navBack = useUiStore((s) => s.navBack);
  const navForward = useUiStore((s) => s.navForward);

  // Chat store
  const chatSessions = useChatStore((s) => s.sessions);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const chatStreaming = useChatStore(
    useCallback((s) => {
      if (!activeChatSessionId) return {};
      const next: Record<string, string> = {};
      const id = activeChatSessionId;
      if (id in s.streaming) next[id] = s.streaming[id];
      return next;
    }, [activeChatSessionId]),
  );
  const chatConfig = useChatStore((s) => s.config);
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

  // â”€â”€ Pairing QR modal (sidebar footer quick access) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const [pairingModalOpen, setPairingModalOpen] = useState(false);
  const [pairingInfo, setPairingInfo] = useState<MobilePairingInfo | null>(null);
  const [pairingQr, setPairingQr] = useState<string>("");
  const [pairingLoading, setPairingLoading] = useState(false);
  const pairingTimer = useRef<number | null>(null);

  const loadPairingInfo = useCallback(async () => {
    try {
      const info = await getMobilePairingInfo();
      setPairingInfo(info);
      // Prefer: tailnet direct (no HTTPS serve needed) â†’ HTTPS serve â†’ local USB bridge.
      const url = info?.tailnetUrl ?? info?.tailscaleUrl ?? info?.localUrl ?? "";
      if (url) {
        const { default: QRCode } = await import("qrcode");
        const dataUrl = await QRCode.toDataURL(url, { width: 240, margin: 1 });
        setPairingQr(dataUrl);
      } else {
        setPairingQr("");
      }
    } catch {
      setPairingInfo(null);
      setPairingQr("");
    } finally {
      setPairingLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!pairingModalOpen) return;
    setPairingLoading(true);
    void loadPairingInfo();
    // Poll while modal is open so QR stays fresh if serve state changes.
    pairingTimer.current = window.setInterval(() => void loadPairingInfo(), 3000);
    return () => {
      if (pairingTimer.current) window.clearInterval(pairingTimer.current);
    };
  }, [pairingModalOpen, loadPairingInfo]);

  const closePairingModal = useCallback(() => {
    if (pairingTimer.current) window.clearInterval(pairingTimer.current);
    setPairingModalOpen(false);
  }, []);

  const openPairingModal = useCallback(() => {
    setPairingModalOpen(true);
  }, []);

  // DEV-ONLY mock update for visual review (see SHOW_FAKE_UPDATE in state/updater).
  useEffect(() => {
    if (!SHOW_FAKE_UPDATE) return;
    seedFakeUpdate();
  }, []);

  const handleNewChat = useCallback(() => {
    const provider = chatConfig?.provider ?? "openai_compatible";
    void newChat(provider, chatConfig?.model ?? "").then((session) => {
      if (session) setActiveView("chat");
    });
  }, [newChat, chatConfig, setActiveView]);

  const handleProjectClick = useCallback(
    (projectId: string) => {
      // Only toggle expansion â€” do NOT select the project here.
      // Selecting triggers the project-store subscription which rebinds
      // the active chat to this project, stealing it from its original
      // project. Project selection happens implicitly when the user clicks
      // a nested chat or uses the "New chat for project" button.
      toggleExpanded(projectId);
    },
    [toggleExpanded],
  );

  // Start a brand-new chat explicitly bound to this project, and expand the
  // project so the new chat is visible under it.
  const handleNewChatForProject = useCallback(
    (projectId: string) => {
      selectProject(projectId);
      setExpanded(projectId, true);
      const provider = chatConfig?.provider ?? "openai_compatible";
      void newChat(provider, chatConfig?.model ?? "", projectId).then((session) => {
        if (session) setActiveView("chat");
      });
    },
    [selectProject, setExpanded, newChat, chatConfig, setActiveView],
  );

  // Remove a project from the sidebar. The backend cascade also deletes every
  // chat nested under it, so confirm first â€” this is destructive.
  const handleRemoveProject = useCallback(
    (projectId: string, projectName: string) => {
      const ok = window.confirm(
        `Remove project "${projectName}"?\n\nThis also deletes all chats nested under it. This cannot be undone.`,
      );
      if (!ok) return;
      void removeProjectById(projectId);
    },
    [removeProjectById],
  );

  const handleSelectChat = useCallback(
    (id: string) => {
      void selectSession(id).catch((err) => toastError("Couldn't open that chat", err));
      setActiveView("chat");
    },
    [selectSession, setActiveView],
  );

  const handleDeleteChat = useCallback(
    (id: string) => {
      void deleteChat(id);
    },
    [deleteChat],
  );

  const handleRenameChat = useCallback(
    (id: string, title: string) => {
      void renameChat(id, title);
    },
    [renameChat],
  );

  const handleToggleStar = useCallback(
    (id: string, starred: boolean) => {
      void setStarred(id, starred);
    },
    [setStarred],
  );

  const handleSetUnread = useCallback(
    (id: string, unread: boolean) => {
      void setUnread(id, unread);
    },
    [setUnread],
  );

  const handleExportChat = useCallback((id: string) => {
    exportChatZip(id)
      .then((saved) => {
        if (saved) toastSuccess("Chat exported to .zip");
      })
      .catch((err) => toastError("Chat export failed", err));
  }, []);

  // Pop a chat out into its own OS window (roadmap #17).
  const handlePopOutChat = useCallback((id: string) => {
    popOutChat(id).catch((err) => toastError("Could not open chat window", err));
  }, []);

  useEffect(() => {
    if (!chatLoaded) {
      void loadSessions();
      void loadConfig();
    }
  }, [chatLoaded, loadSessions, loadConfig]);

  const addProject = async () => {
    try {
      const picked = await open({ directory: true, multiple: false, title: "Add Project" });
      if (typeof picked !== "string") return;
      const project = await addProjectAtPath(picked);
      if (project && !project.isGitRepo) setGitPromptProjectId(project.id);
    } catch (err) {
      console.warn("folder picker failed", err);
    }
  };

  // Flat "Chat History" list shows only chats NOT bound to a project. Chats
  // bound to a project render nested under that project's expandable row.
  const chatRowData: ChatSessionRowData[] = useMemo(
    () =>
      chatSessions
        .filter((s) => s.projectId == null)
        .map((s) => ({
          id: s.id,
          title: s.title ?? "Untitled Chat",
          lastActiveAt: s.lastActiveAt,
          lastMessage: undefined,
          starred: s.starred ?? false,
          unread: s.unread ?? false,
          worktreePath: s.worktreePath ?? null,
        })),
    [chatSessions],
  );

  // Chats grouped by project id (starred first, then most-recent), for the
  // nested dropdown rows under each project.
  const chatsByProject = useMemo(() => {
    const map = new Map<string, { id: string; title: string; lastActiveAt: number; starred: boolean; unread: boolean; worktreePath: string | null }[]>();
    for (const s of chatSessions) {
      if (!s.projectId) continue;
      const arr = map.get(s.projectId) ?? [];
      arr.push({
        id: s.id,
        title: s.title ?? "Untitled Chat",
        lastActiveAt: s.lastActiveAt,
        starred: s.starred ?? false,
        unread: s.unread ?? false,
        worktreePath: s.worktreePath ?? null,
      });
      map.set(s.projectId, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => Number(b.starred) - Number(a.starred) || b.lastActiveAt - a.lastActiveAt);
    }
    return map;
  }, [chatSessions]);

  // PERF (PERFORMANCE_AUDIT.md mi27/F5): virtualize the flat chat-history
  // list â€” 100+ sessions used to mount 100+ ChatSessionRow subtrees (each
  // with hover action buttons + context menu wiring), making sidebar scroll
  // stutter. Rows self-measure via measureElement.
  const chatListRef = useRef<HTMLDivElement>(null);
  const chatListVirtualizer = useVirtualizer({
    count: chatRowData.length,
    getScrollElement: () => chatListRef.current,
    estimateSize: () => 60,
    overscan: 8,
  });

  return (
    <aside className="flex flex-col h-full bg-white/95 dark:bg-[#141414] backdrop-blur-xl border-r border-gray-200 dark:border-white/20 overflow-hidden select-none">
      {/* â”€â”€ Consolidated Header: branding + search + collapse in one block â”€â”€ */}
      <div data-tauri-drag-region className="p-3 border-b border-gray-200 dark:border-white/20">
        {/* Branding + back/forward view navigation (browser-style), with the
            collapse control on this row too. */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex items-center flex-shrink-0">
              <button
                type="button"
                className="sidebar-nav-btn"
                onClick={navBack}
                disabled={viewIndex <= 0}
                title="Back"
                aria-label="Back"
              >
                <ArrowLeft size={14} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="sidebar-nav-btn"
                onClick={navForward}
                disabled={viewIndex >= viewHistory.length - 1}
                title="Forward"
                aria-label="Forward"
              >
                <ArrowRight size={14} strokeWidth={1.8} />
              </button>
            </span>
            <strong className="text-sm font-bold text-gray-900 dark:text-white select-none truncate">Conduit</strong>
          </div>
          <div className="flex items-center flex-shrink-0">
            <UpdateButton />
            <button
              className="p-2 rounded-lg bg-transparent border border-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white transition-all duration-150 active:scale-95"
              onClick={toggleSidebar}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <PanelIcon />
            </button>
          </div>
        </div>
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

      {/* â”€â”€ Pinned upper block (non-scrolling) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="flex-shrink-0">
        {/* Global Views: Artifacts pill + Schedule button (automations) */}
        <div className="flex flex-col gap-1 px-2 pt-2 pb-0">
          <ArtifactLibrary />
          <div className="chat-new-btn-row">
            <button
              type="button"
              onClick={() => setActiveView("automations")}
              className={`artifact-lib-title ${activeView === "automations" ? "is-active" : ""}`}
              style={{ width: "100%" }}
              title="Open automations"
              aria-label="Open automations"
            >
              <CalendarClock size={14} strokeWidth={1.8} className="artifact-lib-title-icon" />
              <span className="artifact-lib-title-label">Automations</span>
            </button>
          </div>
        </div>

        {/* Projects — pb matches the pt of the Chat History header below so
            the header-to-header gap equals the Automations→Projects rhythm
            (8px). The old py-1.5 stacked the header's mb-1 + 6px block
            padding + 2px = 12px of dead space above Chat History. */}
        <div className="px-2 pt-1.5 pb-0.5">
          {/* Same geometry as the Artifacts/Schedule rows: full-width pill
              label + trailing "+" so hover/active fills identically. */}
          <div className="sidebar-section-header flex items-center gap-1 mb-1">
            <button
              type="button"
              onClick={() => setProjectsCollapsed((c) => !c)}
              className="sidebar-section-label"
              title={projectsCollapsed ? "Expand projects" : "Collapse projects"}
              aria-expanded={!projectsCollapsed}
              aria-controls="projects-list"
            >
              <Folder size={14} strokeWidth={1.8} className="sidebar-section-label-icon" />
              Projects
            </button>
            <button
              onClick={() => void addProject()}
              className="p-2 rounded-md bg-transparent border border-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white transition-all duration-150 active:scale-95"
              title="Add Project"
              aria-label="Add Project"
            >
              <Plus size={13} strokeWidth={2} />
            </button>
          </div>
          {/* Always-mounted collapse wrapper: the grid-rows 0frâ†’1fr transition
              animates smoothly without measuring content height. */}
          <div
            className={`sidebar-projects-collapse${projectsCollapsed ? "" : " open"}`}
            aria-hidden={projectsCollapsed}
          >
            <div id="projects-list" className="sidebar-projects-collapse-inner">
              {loaded && projects.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-4 px-2 rounded-lg bg-gray-50 dark:bg-white/10 border border-gray-200 dark:border-white/20">
                  <Folder size={20} className="text-gray-400 dark:text-slate-300" strokeWidth={1.5} />
                  <span className="text-xs text-gray-600 dark:text-slate-200">No projects yet</span>
                  <button
                    onClick={() => void addProject()}
                    className="px-3 py-1.5 rounded-md bg-gray-100 dark:bg-white/15 border border-gray-200 dark:border-white/30 text-xs font-medium text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-white/25 transition-all duration-150 active:scale-95"
                  >
                    Add Project
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-0.5 sidebar-projects-scroll">
                  {/* Quiet list, like a launcher: cap the visible projects and
                      reveal the rest via "Show more" instead of scrolling a
                      long nested tree. */}
                  {(showAllProjects || projects.length <= visibleProjectCount
                    ? projects
                    : projects.slice(0, visibleProjectCount)
                  ).map((project) => {
                    // Default to expanded: a missing key means "expanded".
                    // Only an explicit `false` collapses the project.
                    const isExpanded = expanded[project.id] !== false;
                    const projectChats = chatsByProject.get(project.id) ?? [];
                    return (
                      <div key={project.id} className="sidebar-project-node">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => handleProjectClick(project.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleProjectClick(project.id);
                            }
                          }}
                          title={project.path}
                          className={`sidebar-project-row ${project.id === selectedProjectId ? "is-selected" : ""}`}
                        >
                          <Folder size={14} strokeWidth={1.7} className="sidebar-project-folder" />
                          <span className="sidebar-project-name">{project.name}</span>
                          {/* Hover-only actions: new chat for this project (+)
                              and remove (x). Both stopPropagation so they don't
                              toggle/expand the row. */}
                          <span className="sidebar-project-actions">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleNewChatForProject(project.id);
                              }}
                              className="sidebar-project-action-btn"
                              title="New chat for this project"
                              aria-label="New chat for this project"
                            >
                              <Plus size={14} strokeWidth={2} />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveProject(project.id, project.name);
                              }}
                              className="sidebar-project-action-btn sidebar-project-action-danger"
                              title="Remove project"
                              aria-label="Remove project"
                            >
                              <X size={14} strokeWidth={2} />
                            </button>
                          </span>
                        </div>
                        {isExpanded && projectChats.length > 0 && (
                          <div className="sidebar-project-chats">
                            {projectChats.map((c) => {
                              const active = c.id === activeChatSessionId;
                              const working = c.id in chatStreaming;
                              return (
                                <div
                                  key={c.id}
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => handleSelectChat(c.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      handleSelectChat(c.id);
                                    }
                                  }}
                                  className={`sidebar-project-chat-row ${active ? "is-active" : ""} ${c.unread ? "is-unread" : ""}`}
                                  title={c.title}
                                >
                                  {/* Quiet rows: no icon while idle â€” the
                                      status slot only appears when there is
                                      something to say (running/star/unread). */}
                                  {(working || c.starred || c.unread) && (
                                    <span className="sidebar-project-chat-status">
                                      {working ? (
                                        <span className="sidebar-project-chat-working" />
                                      ) : c.starred ? (
                                        <span className="sidebar-project-chat-star">â˜…</span>
                                      ) : (
                                        <span className="sidebar-project-chat-unread-dot" />
                                      )}
                                    </span>
                                  )}
                                  <span className="sidebar-project-chat-title">{c.title}</span>
                                  <span className="sidebar-project-chat-time">{shortRelativeTime(c.lastActiveAt)}</span>
                                  {project.isGitRepo && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void toggleSessionWorktree(c.id);
                                      }}
                                      className={`sidebar-project-chat-worktree ${c.worktreePath ? "is-active" : ""}`}
                                      title={
                                        c.worktreePath
                                          ? `Isolated worktree (${c.worktreePath}). Click to join the main working tree.`
                                          : "Isolate this chat in its own git worktree (branch conduit/<id>)"
                                      }
                                      aria-label={
                                        c.worktreePath ? "Join main working tree" : "Isolate in worktree"
                                      }
                                    >
                                      {c.worktreePath ? "â›“" : "ðŸªµ"}
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {projects.length > visibleProjectCount && (
                    <button
                      type="button"
                      className="sidebar-projects-more"
                      onClick={() => setShowAllProjects((v) => !v)}
                    >
                      {showAllProjects ? "Show less" : "Show more"}
                    </button>
                  )}
                 </div>
               )}
            </div>
          </div>
        </div>
      </div>

      {/* â”€â”€ Recent History â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {/* Label stays pinned; only the chat list below scrolls. */}
      <div className="px-2 pt-0.5 pb-1 flex-shrink-0">
          <div className="sidebar-section-header flex items-center gap-1 mb-1">
            <span className="sidebar-section-label">
              <MessageSquare size={14} strokeWidth={1.8} className="sidebar-section-label-icon" />
              Chat History
            </span>
          {/* New Chat â€” same "+" affordance as the Projects header */}
          <button
            onClick={handleNewChat}
            className="p-2 rounded-md bg-transparent border border-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white transition-all duration-150 active:scale-95"
            title="New Chat"
            aria-label="New Chat"
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
      {/* â”€â”€ Scrolling chat list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="flex-1 overflow-y-auto sidebar-thin-scroll min-h-0" ref={chatListRef}>
        {chatRowData.length === 0 ? (
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
              const s = chatRowData[vi.index];
              return (
                <div
                  key={s.id}
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
                  <ChatSessionRow
                    session={s}
                    active={s.id === activeChatSessionId}
                    working={s.id in chatStreaming}
                    onSelect={handleSelectChat}
                    onDelete={handleDeleteChat}
                    onRename={handleRenameChat}
                    onToggleStar={handleToggleStar}
                    onSetUnread={handleSetUnread}
                    onExport={handleExportChat}
                    onPopOut={handlePopOutChat}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* â”€â”€ Pinned Footer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="flex-shrink-0 flex flex-row justify-center gap-2 p-2 border-t border-gray-200 dark:border-white/20">
        <button
          className={`p-2 rounded-lg transition-all duration-150 active:scale-95 ${
            activeView === "skills"
              ? "bg-gray-200 dark:bg-white/15 border border-gray-300 dark:border-white/30 text-gray-900 dark:text-white"
              : "bg-transparent dark:bg-transparent border border-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white"
          }`}
          onClick={() => setActiveView(activeView === "skills" ? "chat" : "skills")}
          title="Skills Library"
          aria-label="Skills Library"
        >
          <Library size={16} strokeWidth={1.8} />
        </button>
        <button
          className={`p-2 rounded-lg transition-all duration-150 active:scale-95 ${
            activeView === "cost"
              ? "bg-gray-200 dark:bg-white/15 border border-gray-300 dark:border-white/30 text-gray-900 dark:text-white"
              : "bg-transparent dark:bg-transparent border border-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white"
          }`}
          onClick={() => setActiveView(activeView === "cost" ? "chat" : "cost")}
          title="Cost"
          aria-label="Cost"
        >
          <DollarSign size={16} strokeWidth={1.8} />
        </button>
        <button
          className={`p-2 rounded-lg transition-all duration-150 active:scale-95 ${
            pairingModalOpen
              ? "bg-gray-200 dark:bg-white/15 border border-gray-300 dark:border-white/30 text-gray-900 dark:text-white"
              : "bg-transparent dark:bg-transparent border border-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white"
          }`}
          onClick={openPairingModal}
          title="Phone pairing QR"
          aria-label="Phone pairing QR"
        >
          <QrCode size={16} strokeWidth={1.8} />
        </button>
        <button
          className={`p-2 rounded-lg transition-all duration-150 active:scale-95 ${
            activeView === "settings"
              ? "bg-gray-200 dark:bg-white/15 border border-gray-300 dark:border-white/30 text-gray-900 dark:text-white"
              : "bg-transparent dark:bg-transparent border border-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white"
          }`}
          onClick={() => setActiveView(activeView === "settings" ? "chat" : "settings")}
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={16} strokeWidth={1.8} />
        </button>
      </div>

      {/* â”€â”€ Pairing QR modal (sidebar quick access) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          Rendered via portal to document.body so it overlays the entire app
          (the sidebar's backdrop-blur creates its own containing block,
          which would trap a position:fixed overlay inside the rail). */}
      {pairingModalOpen &&
        createPortal(
          <div className="pairing-modal" onClick={closePairingModal}>
            <div className="pairing-modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="pairing-modal-head">
                <span className="pairing-modal-title">Phone pairing</span>
                <button className="pairing-modal-close" onClick={closePairingModal} aria-label="Close">
                  <X size={16} />
                </button>
              </div>
              {pairingLoading ? (
                <p className="muted" style={{ fontSize: 12 }}>Loadingâ€¦</p>
              ) : pairingInfo?.running && pairingQr ? (
                <>
                  <div className="pairing-modal-qr">
                    <img src={pairingQr} alt="Pairing QR" width={240} height={240} />
                  </div>
<p className="pairing-modal-hint">
                  Scan with the mobile app to pair. Works over Tailscale
                  {pairingInfo.tailnetUrl || pairingInfo.tailscaleUrl ? " (cross-network)" : " (local)"}.
                  Token rotates each time the relay restarts.
                </p>
                <div className="field">
                  <label className="field-label" style={{ fontSize: 11 }}>URL</label>
                  <code className="pairing-modal-url" style={{ color: "var(--text-dim)" }}>
                    {pairingInfo.tailnetUrl ?? pairingInfo.tailscaleUrl ?? pairingInfo.localUrl}
                  </code>
                </div>
                </>
              ) : (
                <p className="muted" style={{ fontSize: 12 }}>
                  Relay is not running. Open Settings â†’ Remote to start it.
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
