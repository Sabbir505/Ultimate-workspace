// Sidebar (§5): unified single-mode layout — New Chat, Artifacts, Connectors,
// Automations (stub), Projects, Chat history, then footer links to Settings /
// Skills Library / Cost Dashboard. Handles the "Add Project" first-launch flow
// (§4.1) — the not-a-git-repo prompt itself renders at the App top level
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

import {
  DollarSign,
  Folder,
  Library,
  MessageSquare,
  Plus,
  Search,
  Settings,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  X,
} from "lucide-react";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { useArtifactsStore } from "../../state/artifacts";
import { ArtifactLibrary } from "./ArtifactLibrary";
import { ChatSessionRowMemo as ChatSessionRow, type ChatSessionRowData } from "../chat/ChatSessionRow";
import { PanelIcon } from "../common/PanelIcon";
import { relativeTime } from "../../lib/relativeTime";

export function Sidebar() {
  const [projectsCollapsed, setProjectsCollapsed] = useState(true);
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

  // Chat store
  const chatSessions = useChatStore((s) => s.sessions);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const chatStreaming = useChatStore((s) => s.streaming);
  const chatConfig = useChatStore((s) => s.config);
  const chatLoaded = useChatStore((s) => s.loaded);
  const selectSession = useChatStore((s) => s.selectSession);
  const newChat = useChatStore((s) => s.newChat);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const renameChat = useChatStore((s) => s.renameChat);
  const setStarred = useChatStore((s) => s.setStarred);
  const setUnread = useChatStore((s) => s.setUnread);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadConfig = useChatStore((s) => s.loadConfig);

  // Artifacts count
  const artifactItems = useArtifactsStore((s) => s.items);

  const handleNewChat = useCallback(() => {
    const provider = chatConfig?.provider ?? "openai_compatible";
    void newChat(provider, chatConfig?.model ?? "").then((session) => {
      if (session) setActiveView("chat");
    });
  }, [newChat, chatConfig, setActiveView]);

  const handleProjectClick = useCallback(
    (projectId: string) => {
      // Only toggle expansion — do NOT select the project here.
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
  // chat nested under it, so confirm first — this is destructive.
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
      void selectSession(id);
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
        })),
    [chatSessions],
  );

  // Chats grouped by project id (starred first, then most-recent), for the
  // nested dropdown rows under each project.
  const chatsByProject = useMemo(() => {
    const map = new Map<string, { id: string; title: string; lastActiveAt: number; starred: boolean; unread: boolean }[]>();
    for (const s of chatSessions) {
      if (!s.projectId) continue;
      const arr = map.get(s.projectId) ?? [];
      arr.push({
        id: s.id,
        title: s.title ?? "Untitled Chat",
        lastActiveAt: s.lastActiveAt,
        starred: s.starred ?? false,
        unread: s.unread ?? false,
      });
      map.set(s.projectId, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => Number(b.starred) - Number(a.starred) || b.lastActiveAt - a.lastActiveAt);
    }
    return map;
  }, [chatSessions]);

  return (
    <aside className="flex flex-col h-full bg-white/95 dark:bg-[#141414] backdrop-blur-xl border-r border-gray-200 dark:border-white/20 overflow-hidden select-none">
      {/* ── Consolidated Header: branding + search + collapse in one block ── */}
      <div data-tauri-drag-region className="p-3 border-b border-gray-200 dark:border-white/20">
        {/* Branding */}
        <div className="flex items-center justify-between mb-2">
          <strong className="text-sm font-bold text-gray-900 dark:text-white select-none">Conduit</strong>
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

          {/* Collapse sidebar */}
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

      {/* ── Pinned upper block (non-scrolling) ──────────────────────────── */}
      <div className="flex-shrink-0">
        {/* Global Views: Artifacts pill + Schedule button (automations) */}
        <div className="flex flex-col gap-1 p-2">
          <ArtifactLibrary />
          <div className="chat-new-btn-row">
            <button
              type="button"
              onClick={() => setActiveView("automations")}
              className={`artifact-lib-title ${activeView === "automations" ? "is-active" : ""}`}
              style={{ width: "100%" }}
              title="Schedule automated runs"
              aria-label="Schedule automated runs"
            >
              <CalendarClock size={14} strokeWidth={1.8} className="artifact-lib-title-icon" />
              <span className="artifact-lib-title-label">Schedule</span>
            </button>
          </div>
        </div>

        {/* Projects Tree */}
        <div className="px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <button
              type="button"
              onClick={() => setProjectsCollapsed((c) => !c)}
              className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white transition-colors bg-transparent border-none p-0"
              title={projectsCollapsed ? "Expand projects" : "Collapse projects"}
              aria-expanded={!projectsCollapsed}
              aria-controls="projects-list"
            >
              {projectsCollapsed ? (
                <ChevronRight size={11} strokeWidth={2.2} />
              ) : (
                <ChevronDown size={11} strokeWidth={2.2} />
              )}
              Projects
              {projects.length > 0 && (
                <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-gray-400 dark:text-slate-400">
                  {projects.length}
                </span>
              )}
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
          {!projectsCollapsed && (
            <div id="projects-list">
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
                  {projects.map((project) => {
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
                          <span className="sidebar-project-caret">
                            {isExpanded ? (
                              <ChevronDown size={12} strokeWidth={2.2} />
                            ) : (
                              <ChevronRight size={12} strokeWidth={2.2} />
                            )}
                          </span>
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
                          {projectChats.length > 0 && (
                            <span className="sidebar-project-count">{projectChats.length}</span>
                          )}
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
                                  <span className="sidebar-project-chat-status">
                                    {working ? (
                                      <span className="sidebar-project-chat-working" />
                                    ) : c.starred ? (
                                      <span className="sidebar-project-chat-star">★</span>
                                    ) : c.unread ? (
                                      <span className="sidebar-project-chat-unread-dot" />
                                    ) : (
                                      <MessageSquare size={12} strokeWidth={1.6} className="sidebar-project-chat-icon" />
                                    )}
                                  </span>
                                  <span className="sidebar-project-chat-title">{c.title}</span>
                                  <span className="sidebar-project-chat-time">{relativeTime(c.lastActiveAt)}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Recent History ─────────────────────────────────────────────── */}
      {/* Label stays pinned; only the chat list below scrolls. */}
      <div className="px-3 pt-2 pb-1 flex-shrink-0">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5">
            <MessageSquare size={11} strokeWidth={1.8} className="text-gray-400 dark:text-slate-300" />
            <span className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-300">
              Chat History
            </span>
          </div>
          {/* New Chat — same "+" affordance as the Projects header */}
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
      {/* ── Scrolling chat list ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto sidebar-thin-scroll min-h-0">
        {chatRowData.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 px-3">
            <MessageSquare size={20} className="text-gray-300 dark:text-slate-400" strokeWidth={1.5} />
            <span className="text-xs text-gray-500 dark:text-slate-300">No chats yet</span>
          </div>
        ) : (
          chatRowData.map((s) => (
            <ChatSessionRow
              key={s.id}
              session={s}
              active={s.id === activeChatSessionId}
              working={s.id in chatStreaming}
              onSelect={handleSelectChat}
              onDelete={handleDeleteChat}
              onRename={handleRenameChat}
              onToggleStar={handleToggleStar}
              onSetUnread={handleSetUnread}
            />
          ))
        )}
      </div>

      {/* ── Pinned Footer ───────────────────────────────────────────────── */}
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
    </aside>
  );
}
