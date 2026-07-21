// Sidebar (§5): search trigger, projects with sessions, footer links to
// Skills Library / Cost Dashboard / Settings. Handles the "Add Project"
// first-launch flow (§4.1) — the not-a-git-repo prompt itself renders at the
// App top level (App.tsx) so it centers on screen like the other modals.
//
// When in chat mode, the sidebar-scroll switches to a chat-session list
// powered by useChatStore.
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { ProjectItem } from "./ProjectItem";
import { ChatSessionRow, type ChatSessionRowData } from "../chat/ChatSessionRow";

type SidebarMode = "projects" | "chats";

export function Sidebar() {
  const projects = useProjectsStore((s) => s.projects);
  const loaded = useProjectsStore((s) => s.loaded);
  const addProjectAtPath = useProjectsStore((s) => s.addProjectAtPath);
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const setGitPromptProjectId = useUiStore((s) => s.setGitPromptProjectId);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  // Chat store
  const chatSessions = useChatStore((s) => s.sessions);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const chatConfig = useChatStore((s) => s.config);
  const chatLoaded = useChatStore((s) => s.loaded);
  const selectSession = useChatStore((s) => s.selectSession);
  const newChat = useChatStore((s) => s.newChat);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadConfig = useChatStore((s) => s.loadConfig);

  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("projects");

  const handleNewChat = useCallback(() => {
    // Use hardcoded openai_compatible provider as default for testing
    const provider = chatConfig?.provider ?? "openai_compatible";
    const model = chatConfig?.model ?? "kimi-k2.6";
    void newChat(provider, model).then((session) => {
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

  const switchToMode = useCallback(
    (mode: SidebarMode) => {
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
    [setActiveView, chatLoaded, loadSessions, loadConfig],
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
  }));

  return (
    <aside className="sidebar">
      <div className="sidebar-search">
        <button onClick={() => setPaletteOpen(true)}>⌕ Search… (Cmd/Ctrl+K)</button>
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
                  onSelect={handleSelectChat}
                  onDelete={handleDeleteChat}
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
        <button className="ghost" onClick={toggleSidebar} title="Hide sidebar">
          ▤ Collapse sidebar
        </button>
      </div>
    </aside>
  );
}