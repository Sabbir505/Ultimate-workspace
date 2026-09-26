// Projects sidebar — the second panel that opens beside the main sidebar
// when "Projects" is clicked under the Vault row. Restores the retired
// Projects tree in inbox form: every project is a row with its chats nested
// beneath it (the same ChatSessionRow used by Chat History, so pinning,
// rename, unread, delete, export and split-pane drag all work identically),
// the most recent 5 chats per project with a "Show more" that reveals 5 at a
// time, a per-project New Chat (+) that binds the new chat to that project,
// and a stash toggle that drops the project to the bottom of the list.
import { useCallback, useEffect, useMemo, useState } from "react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useShallow } from "zustand/react/shallow";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderPlus,
  Folders,
  MessageCirclePlus,
  X,
} from "lucide-react";

import { toastError, toastSuccess, exportChatZip } from "../../lib/ipc";
import { useProjectsStore } from "../../state/projects";
import { useProjectsSidebarStore } from "../../state/projectsSidebar";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { seedSelectionFrom } from "../../lib/lastSelection";
import { ChatSessionRowMemo, type ChatSessionRowData } from "../chat/ChatSessionRow";

/** Chats visible per project before "Show more" — and the step size of
 *  each subsequent reveal. */
const PAGE_SIZE = 5;

export function ProjectsSidebar() {
  const open = useProjectsSidebarStore((s) => s.open);
  const stashed = useProjectsSidebarStore((s) => s.stashed);
  const toggleStashed = useProjectsSidebarStore((s) => s.toggleStashed);
  const setOpen = useProjectsSidebarStore((s) => s.setOpen);

  const projects = useProjectsStore((s) => s.projects);
  const gitStatuses = useProjectsStore((s) => s.gitStatuses);
  const expanded = useProjectsStore((s) => s.expanded);
  const toggleExpanded = useProjectsStore((s) => s.toggleExpanded);
  const addProjectAtPath = useProjectsStore((s) => s.addProjectAtPath);

  const chatSessions = useChatStore((s) => s.sessions);
  const sessionProjects = useChatStore((s) => s.sessionProjects);
  const cwdOverrides = useChatStore((s) => s.cwdOverrides);
  // Every streaming id — the nested rows need the spinner even when the
  // chat is open elsewhere (same rule as the main sidebar).
  const streamingIds = useChatStore(useShallow((s) => Object.keys(s.streaming)));
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const lastSelection = useChatStore((s) => s.lastSelection);
  const chatConfig = useChatStore((s) => s.config);
  const selectSession = useChatStore((s) => s.selectSession);
  const newChat = useChatStore((s) => s.newChat);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const renameChat = useChatStore((s) => s.renameChat);
  const setStarred = useChatStore((s) => s.setStarred);
  const setUnread = useChatStore((s) => s.setUnread);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const chatLoaded = useChatStore((s) => s.loaded);

  const setActiveView = useUiStore((s) => s.setActiveView);

  // How many chats each project reveals — grows by PAGE_SIZE per "Show more"
  // click. Component state (not the store): the panel stays mounted across
  // open/close, so the user's paging survives closing the panel, and it
  // intentionally resets on app restart — the freshest 5 is the right
  // default view again.
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!chatLoaded) void loadSessions();
  }, [chatLoaded, loadSessions]);

  // Group the chat sessions by project id (row column first, in-memory
  // binding cache second — same two paths the main sidebar reads). Starred
  // chats float to the top of their project, then most-recent: identical
  // ordering to the Chat History inbox so a pinned chat behaves the same in
  // both lists.
  const chatsByProject = useMemo(() => {
    const byProject: Record<string, ChatSessionRowData[]> = {};
    for (const s of chatSessions) {
      const projectId = s.projectId ?? sessionProjects[s.id] ?? null;
      if (!projectId) continue;
      const branchName = s.worktreePath
        ? `relay/${s.id}` // isolated-worktree branch naming (P0 §3.1.1)
        : gitStatuses[projectId]?.branch ?? null;
      const overridePath = cwdOverrides[s.id] ?? null;
      const folderName = overridePath
        ? overridePath.split(/[\/]/).filter(Boolean).pop() ?? null
        : null;
      const project = projects.find((p) => p.id === projectId) ?? null;
      (byProject[projectId] ??= []).push({
        id: s.id,
        title: s.title ?? "Untitled Chat",
        lastActiveAt: s.lastActiveAt,
        starred: s.starred ?? false,
        unread: s.unread ?? false,
        worktreePath: s.worktreePath ?? null,
        // The parent project row already names the project — the nested
        // row's second line shows the branch + provider icon only.
        projectName: project ? null : folderName,
        branchName,
        agent: s.agent ?? null,
        provider: s.provider ?? null,
      });
    }
    for (const list of Object.values(byProject)) {
      list.sort(
        (a, b) =>
          Number(b.starred) - Number(a.starred) || b.lastActiveAt - a.lastActiveAt,
      );
    }
    return byProject;
  }, [chatSessions, sessionProjects, gitStatuses, cwdOverrides, projects]);

  // Stashed projects sink to the bottom of the list; the rest keep the
  // store's order (newest first — addProjectAtPath prepends).
  const orderedProjects = useMemo(() => {
    const active: typeof projects = [];
    const stashedProjects: typeof projects = [];
    for (const p of projects) {
      (stashed.includes(p.id) ? stashedProjects : active).push(p);
    }
    return { active, stashedProjects };
  }, [projects, stashed]);

  const handleSelectChat = useCallback(
    (id: string) => {
      void selectSession(id).catch((err) => toastError("Couldn't open that chat", err));
      setActiveView("chat");
    },
    [selectSession, setActiveView],
  );

  const handleDeleteChat = useCallback(
    (id: string) => {
      deleteChat(id).catch((e) => toastError("Couldn't delete the chat", e));
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

  const handleOpenSplitChat = useCallback((id: string) => {
    void useChatStore.getState().openChatSplit(id);
  }, []);

  // New chat bound to THIS project — same composer seeding as the sidebar's
  // global "+" (last committed pick, falling back to the provider defaults),
  // the only difference being the explicit project binding.
  const handleNewChatForProject = useCallback(
    (projectId: string) => {
      const seed = seedSelectionFrom(lastSelection, chatConfig);
      void newChat(seed.provider, seed.model, projectId, seed.agent)
        .then((session) => {
          if (session) setActiveView("chat");
        })
        .catch((e) => toastError("Couldn't create the chat", e));
    },
    [newChat, lastSelection, chatConfig, setActiveView],
  );

  const handleAddProject = useCallback(async () => {
    setAdding(true);
    try {
      const picked = await pickFolder({ directory: true });
      if (typeof picked === "string") {
        const project = await addProjectAtPath(picked);
        if (project) toastSuccess(`Added "${project.name}"`);
      }
    } catch (e) {
      toastError("Couldn't add the project", e);
    } finally {
      setAdding(false);
    }
  }, [addProjectAtPath]);

  const renderProjectNode = (project: (typeof projects)[number], isStashed: boolean) => {
    const isOpen = !!expanded[project.id];
    const chats = chatsByProject[project.id] ?? [];
    const visibleCount = visibleCounts[project.id] ?? PAGE_SIZE;
    const visible = chats.slice(0, visibleCount);
    const branch = gitStatuses[project.id]?.branch ?? null;
    const hasMore = chats.length > visible.length;
    return (
      <div className={`sidebar-project-node${isStashed ? " is-stashed" : ""}`} key={project.id}>
        <div
          className="sidebar-project-row"
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onClick={() => {
            toggleExpanded(project.id);
            useProjectsStore.getState().selectProject(project.id);
          }}
          onKeyDown={(e) => {
            // Only when the row itself is focused: the nested New-chat/Stash
            // buttons' keydowns bubble here too, and preventDefault would
            // swallow their Enter/Space activation — toggling the project
            // instead of creating the chat / stashing it.
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleExpanded(project.id);
              // Parity with the click path, which also selects the project.
              useProjectsStore.getState().selectProject(project.id);
            }
          }}
          title={project.path}
        >
          <ChevronRight
            size={12}
            strokeWidth={2}
            className={`projects-sidebar-caret${isOpen ? " open" : ""}`}
          />
          <Folders size={13} strokeWidth={1.8} className="sidebar-project-folder" />
          <span className="sidebar-project-name">{project.name}</span>
          {branch && (
            <span className="projects-sidebar-branch" title={branch}>
              {branch}
            </span>
          )}
          <span className="sidebar-project-actions">
            <button
              type="button"
              className="sidebar-project-action-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleNewChatForProject(project.id);
              }}
              title={`New chat in ${project.name}`}
              aria-label={`New chat in ${project.name}`}
            >
              <MessageCirclePlus size={13} strokeWidth={2} />
            </button>
            <button
              type="button"
              className={`sidebar-project-action-btn${isStashed ? " is-stashed" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleStashed(project.id);
              }}
              title={isStashed ? "Unstash — restore to list" : "Stash — move to bottom"}
              aria-label={isStashed ? `Unstash ${project.name}` : `Stash ${project.name}`}
              aria-pressed={isStashed}
            >
              {isStashed ? (
                <ArchiveRestore size={13} strokeWidth={2} />
              ) : (
                <Archive size={13} strokeWidth={2} />
              )}
            </button>
          </span>
        </div>
        {isOpen && (
          <div className="projects-sidebar-chats">
            {chats.length === 0 ? (
              <span className="projects-sidebar-nochats">No chats yet</span>
            ) : (
              <>
                {visible.map((s) => (
                  <ChatSessionRowMemo
                    key={s.id}
                    session={s}
                    active={s.id === activeChatSessionId}
                    working={streamingIds.includes(s.id)}
                    onSelect={handleSelectChat}
                    onDelete={handleDeleteChat}
                    onRename={handleRenameChat}
                    onToggleStar={handleToggleStar}
                    onSetUnread={handleSetUnread}
                    onExport={handleExportChat}
                    onOpenSplit={handleOpenSplitChat}
                  />
                ))}
                {(hasMore || visibleCount > PAGE_SIZE) && (
                  <button
                    type="button"
                    className="sidebar-projects-more"
                    onClick={() =>
                      setVisibleCounts((m) => ({
                        ...m,
                        [project.id]: hasMore ? visibleCount + PAGE_SIZE : PAGE_SIZE,
                      }))
                    }
                  >
                    {hasMore ? "Show more" : "Show less"}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="projects-sidebar-inner" aria-hidden={!open}>
      <div className="projects-sidebar-header">
        <span className="sidebar-section-label">
          <Folders size={14} strokeWidth={1.8} className="sidebar-section-label-icon" />
          Projects
        </span>
        <span className="projects-sidebar-header-actions">
          <button
            type="button"
            className="sidebar-quiet-btn p-1.5 rounded-md bg-transparent dark:bg-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white transition-all duration-150 active:scale-95"
            onClick={() => void handleAddProject()}
            disabled={adding}
            title="Add project folder"
            aria-label="Add project folder"
          >
            <FolderPlus size={14} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="sidebar-quiet-btn p-1.5 rounded-md bg-transparent dark:bg-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white transition-all duration-150 active:scale-95"
            onClick={() => setOpen(false)}
            title="Close projects panel"
            aria-label="Close projects panel"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </span>
      </div>

      <div className="flex-1 overflow-y-auto sidebar-thin-scroll min-h-0 projects-sidebar-scroll">
        {projects.length === 0 ? (
          <div className="projects-sidebar-empty">
            <Folders size={20} className="projects-sidebar-empty-icon" strokeWidth={1.5} />
            <span>No projects yet</span>
            <button
              type="button"
              className="projects-sidebar-empty-add"
              onClick={() => void handleAddProject()}
              disabled={adding}
            >
              {adding ? "Adding…" : "Add a project folder"}
            </button>
          </div>
        ) : (
          <>
            {orderedProjects.active.map((p) => renderProjectNode(p, false))}
            {orderedProjects.stashedProjects.length > 0 && (
              <>
                {orderedProjects.active.length > 0 && (
                  <div className="projects-sidebar-stash-divider" aria-hidden />
                )}
                {orderedProjects.stashedProjects.map((p) => renderProjectNode(p, true))}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
