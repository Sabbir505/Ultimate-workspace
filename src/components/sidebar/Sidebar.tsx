// Sidebar (§5): search trigger, projects with sessions, footer links to
// Skills Library / Cost Dashboard / Settings. Handles the "Add Project"
// first-launch flow (§4.1) — the not-a-git-repo prompt itself renders at the
// App top level (App.tsx) so it centers on screen like the other modals.
//
// When in chat mode, the sidebar-scroll switches to a chat-session list
// powered by useChatStore.
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { ProjectItem } from "./ProjectItem";
import { ChatSessionRow, type ChatSessionRowData } from "../chat/ChatSessionRow";
import { ArtifactLibrary } from "./ArtifactLibrary";
import { PanelIcon } from "../common/PanelIcon";

export function Sidebar() {
  const projects = useProjectsStore((s) => s.projects);
  const loaded = useProjectsStore((s) => s.loaded);
  const addProjectAtPath = useProjectsStore((s) => s.addProjectAtPath);
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const setGitPromptProjectId = useUiStore((s) => s.setGitPromptProjectId);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const sidebarMode = useUiStore((s) => s.sidebarMode);
  const setSidebarMode = useUiStore((s) => s.setSidebarMode);

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


  const handleNewChat = useCallback(() => {
    // Fall back to a compatible provider when no config is saved yet;
    // sending will prompt the user to configure a key in Settings.
    const provider = chatConfig?.provider ?? "openai_compatible";
    // No model is selected by default — the user must pick one before sending.
    void newChat(provider, "").then((session) => {
      if (session) setActiveView("chat");
    });
  }, [newChat, chatConfig, setActiveView]);

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

  const switchToMode = useCallback(
    (mode: "projects" | "chats") => {
      setSidebarMode(mode);
      if (mode === "projects") {
        setActiveView("grid");
      } else {
        // Entering chat mode: load sessions and config if not loaded.
        if (!chatLoaded) {
          void loadSessions();
          void loadConfig();
        }
        setActiveView("chat");
      }
    },
    [setActiveView, setSidebarMode, chatLoaded, loadSessions, loadConfig],
  );

  const addProject = async () => {
    try {
      const picked = await open({ directory: true, multiple: false, title: "Add Project" });
      if (typeof picked !== "string") return;
      const project = await addProjectAtPath(picked);
      // §4.1 step 3: offer git init for non-repo folders (accept or skip).
      if (project && !project.isGitRepo) setGitPromptProjectId(project.id);
    } catch (err) {
      // Dialog plugin unavailable outside Tauri — ignore.
      console.warn("folder picker failed", err);
    }
  };

  // Convert ChatSession to ChatSessionRowData for the row component.
  const chatRowData: ChatSessionRowData[] = chatSessions.map((s) => ({
    id: s.id,
    title: s.title ?? "Untitled Chat",
    lastActiveAt: s.lastActiveAt,
    lastMessage: undefined,
    starred: s.starred ?? false,
    unread: s.unread ?? false,
  }));

  return (
    <aside className="sidebar">
      <div className="sidebar-search">
        <button onClick={() => setPaletteOpen(true)}>⌕ Search… (Cmd/Ctrl+K)</button>
        <button
          className="sidebar-collapse-btn"
          onClick={toggleSidebar}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <PanelIcon />
        </button>
      </div>

      {/* Mode selector: dev (projects) / chat */}
      <div className="sidebar-mode-toggle">
        <button
          className={`sidebar-mode-pill${sidebarMode === "projects" ? " active" : ""}`}
          onClick={() => switchToMode("projects")}
        >
          Dev
        </button>
        <button
          className={`sidebar-mode-pill${sidebarMode === "chats" ? " active" : ""}`}
          onClick={() => switchToMode("chats")}
        >
          Chat
        </button>
      </div>

      <div className="sidebar-scroll">
        {sidebarMode === "projects" ? (
          <>
            <div className="sidebar-section-label">PROJECTS</div>
            {loaded && projects.length === 0 ? (
              <div className="empty-state">
                <div>No projects yet</div>
                <button className="primary" onClick={() => void addProject()}>
                  Add Project
                </button>
              </div>
            ) : (
              <>
                {projects.map((project) => (
                  <ProjectItem key={project.id} project={project} />
                ))}
                <div style={{ padding: "6px" }}>
                  <button className="ghost" onClick={() => void addProject()}>
                    + Add Project
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="sidebar-section-label">CHATS</div>
            <div className="chat-new-btn-row">
              <button className="primary" onClick={handleNewChat} style={{ width: "100%" }}>
                + New Chat
              </button>
            </div>
            <ArtifactLibrary />
            {chatRowData.length === 0 ? (
              <div className="empty-state">
                <div>No chats yet</div>
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
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          className={activeView === "skills" ? "active" : ""}
          onClick={() =>
            setActiveView(activeView === "skills" ? (sidebarMode === "chats" ? "chat" : "grid") : "skills")
          }
        >
          📚 Skills Library
        </button>
        <button
          className={activeView === "cost" ? "active" : ""}
          onClick={() =>
            setActiveView(activeView === "cost" ? (sidebarMode === "chats" ? "chat" : "grid") : "cost")
          }
        >
          💰 Cost
        </button>
        <button
          className={activeView === "settings" ? "active" : ""}
          onClick={() =>
            setActiveView(activeView === "settings" ? (sidebarMode === "chats" ? "chat" : "grid") : "settings")
          }
        >
          ⚙ Settings
        </button>
      </div>
    </aside>
  );
}