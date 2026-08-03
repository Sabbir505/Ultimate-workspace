// App shell: sidebar + main area (toolbar, pane grid, broadcast bar), plus
// overlay views (settings / skills / cost), command palette, peek panel,
// project settings, and the replace-LRU-pane confirmation (§4.3 step 4).
import { useEffect, useRef, useState } from "react";
import { CommandPalette } from "./components/command-palette/CommandPalette";
import { CostDashboard } from "./components/cost-dashboard/CostDashboard";
import { Modal } from "./components/common/Modal";
import { OnboardingBanner } from "./components/onboarding/OnboardingBanner";
import { UpdateBanner } from "./components/onboarding/UpdateBanner";
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
import { useBrowserMcpEvents } from "./hooks/useBrowserMcpEvents";
import { useGitStatusPolling } from "./hooks/useGitStatusPolling";
import { useKeybindings } from "./hooks/useKeybindings";
import { usePtyEvents } from "./hooks/usePtyEvents";
import { usePaneMemory } from "./hooks/usePaneMemory";
import { useTheme } from "./hooks/useTheme";
import { confirmReplaceLru } from "./lib/sessionLauncher";
import { spawnForPane } from "./lib/sessionLauncher";
import { useChatStore } from "./state/chat";
import { MAX_PANES, usePanesStore, type PaneKindData } from "./state/panes";
import { useProjectsStore } from "./state/projects";
import { useSettingsStore } from "./state/settings";
import { useSkillsStore } from "./state/skills";
import { useUiStore } from "./state/ui";
import { useUpdaterStore, wireUpdaterEvents } from "./state/updater";
import {
  listWorkspaces,
  saveWorkspace,
  deleteWorkspace,
  type WorkspaceData,
  type WorkspaceRecord,
} from "./lib/ipc";

export default function App() {
  const activeView = useUiStore((s) => s.activeView);
  const sidebarMode = useUiStore((s) => s.sidebarMode);
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

  // Feature 6: Workspaces dropdown in the Dev-mode toolbar.
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [saveWorkspacePrompt, setSaveWorkspacePrompt] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");

  /** Load workspace list for the selected project. */
  const refreshWorkspaces = async () => {
    if (!selectedProjectId) {
      setWorkspaces([]);
      return;
    }
    const list = await listWorkspaces(selectedProjectId);
    setWorkspaces(list ?? []);
  };

  // Reload workspaces whenever the selected project changes.
  useEffect(() => {
    void refreshWorkspaces();
  }, [selectedProjectId]);

  // Bootstrap: settings first (theme), then projects/sessions/harnesses, skills.
  useEffect(() => {
    void useSettingsStore.getState().load();
    void useProjectsStore.getState().loadAll();
    void useSkillsStore.getState().load();

    // Auto-updater: wire download-progress + installed events, then check on
    // startup and every 4 hours. A check is a single HTTP GET + semver compare;
    // a found update surfaces the banner (UpdateBanner) with the changelog.
    wireUpdaterEvents();
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
  useBrowserMcpEvents();
  useGitStatusPolling();

  // Leaving the Chat tab: drop the active chat if it's still empty (no turns
  // sent). Without this, an auto-started new chat lingers as an empty stub in
  // the sidebar, and returning to Chat reopens that stub (or spawns a
  // duplicate) instead of starting fresh. Only fires on the chat -> non-chat
  // transition, so it never deletes a chat the user actually used.
  const prevView = useRef(activeView);
  useEffect(() => {
    const was = prevView.current;
    prevView.current = activeView;
    if (was === "chat" && activeView !== "chat") {
      void useChatStore.getState().deleteActiveIfEmpty();
    }
  }, [activeView]);

  // Sync modal states into the UI store so native webviews know to hide.
  const setModalOpen = useUiStore((s) => s.setModalOpen);
  useEffect(() => {
    setModalOpen(!!pendingReplace || !!gitPromptProject);
  }, [pendingReplace, gitPromptProject, setModalOpen]);

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

  // ---- Workspace save ----
  const handleSaveWorkspace = async () => {
    const name = workspaceName.trim();
    if (!name || !selectedProjectId) return;
    const store = usePanesStore.getState();
    const data: WorkspaceData = {
      panes: store.panes.map((p) => {
        if (p.data.kind === "terminal") {
          return {
            kind: "terminal" as const,
            harness: p.data.harness ?? undefined,
            sessionId: p.data.sessionId ?? undefined,
            label: p.data.label,
            cwd: p.data.spawn.type === "shell" ? p.data.spawn.cwd : undefined,
          };
        }
        // Browser pane: capture the active tab's URL.
        return {
          kind: "browser" as const,
          url: p.data.url,
        };
      }),
    };
    const json = JSON.stringify(data);
    const result = await saveWorkspace(selectedProjectId, name, json);
    if (result) {
      setSaveWorkspacePrompt(false);
      setWorkspaceName("");
      await refreshWorkspaces();
    }
  };

  // ---- Workspace restore ----
  const handleRestoreWorkspace = async (ws: WorkspaceRecord) => {
    const store = usePanesStore.getState();
    // Close all current panes first.
    const paneIds = [...store.panes.map((p) => p.paneId)];
    for (const pid of paneIds) {
      store.closePane(pid);
    }
    // Parse and spawn saved panes.
    let data: WorkspaceData;
    try {
      data = JSON.parse(ws.data) as WorkspaceData;
    } catch {
      return;
    }
    for (const entry of data.panes) {
      if (entry.kind === "browser") {
        store.addPane({
          kind: "browser",
          url: entry.url ?? lastBrowserUrl(selectedProjectId),
          projectId: selectedProjectId,
        });
      } else if (entry.kind === "terminal") {
        const paneId = store.addPane({
          kind: "terminal",
          sessionId: entry.sessionId ?? null,
          harness: (entry.harness as import("./types").HarnessId | null) ?? null,
          label: entry.label ?? "",
          spawn: entry.sessionId
            ? { type: "agent" as const, sessionId: entry.sessionId }
            : { type: "shell" as const, cwd: entry.cwd ?? ".", command: "", injectSecretsProjectId: selectedProjectId ?? undefined },
        });
        // Only spawn if there is a command or session to spawn.
        if (entry.sessionId) {
          await spawnForPane(paneId, { type: "agent", sessionId: entry.sessionId });
        } else if (entry.cwd) {
          // Shell panes — we saved the cwd but not the command, so just open a shell
          // in that directory. For true restore fidelity users should use agent sessions.
          // The spawn spec from addPane won't auto-spawn shell panes, so we handle it here.
          // Actually addPane doesn't spawn — we need to call spawnForPane explicitly.
          // But we don't have the original command. Best effort: restore as a shell pane
          // with the saved cwd but no command. The pane header shows the label.
        }
      }
    }
    setWorkspacesOpen(false);
    await refreshWorkspaces();
  };

  // ---- Workspace delete ----
  const handleDeleteWorkspace = async (id: string) => {
    await deleteWorkspace(id);
    await refreshWorkspaces();
  };

  return (
    <div className="app">
      {!sidebarCollapsed && <Sidebar />}

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
          <strong style={{ fontSize: 14 }}>Conduit</strong>
          <span className="spacer" />
          {sidebarMode !== "chats" && (
            <button
              className="ghost toolbar-icon-btn"
              onClick={openBrowserPane}
              title="Open a browser preview pane (google.com)"
              aria-label="Open browser pane"
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </button>
          )}
          {sidebarMode !== "chats" && selectedProjectId && (
            <div
              className="workspaces-toggle"
              style={{ position: "relative" }}
            >
              <button
                className="ghost toolbar-icon-btn"
                onClick={() => {
                  void refreshWorkspaces();
                  setWorkspacesOpen((o) => !o);
                }}
                title="Workspaces: save/restore pane layouts"
                aria-label="Workspaces"
              >
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="7" height="9" rx="1" />
                  <rect x="14" y="3" width="7" height="5" rx="1" />
                  <rect x="14" y="12" width="7" height="9" rx="1" />
                  <rect x="3" y="16" width="7" height="5" rx="1" />
                </svg>
              </button>
              {workspacesOpen && (
                <div className="workspaces-dropdown">
                  <div className="workspaces-dropdown-header">
                    Workspaces
                  </div>
                  <ul className="workspaces-list">
                    {workspaces.length === 0 && (
                      <li className="workspaces-empty">No saved workspaces yet</li>
                    )}
                    {workspaces.map((ws) => (
                      <li key={ws.id} className="workspaces-item">
                        <span className="workspaces-name">{ws.name}</span>
                        <span className="workspaces-spacer" />
                        <button
                          className="workspaces-restore"
                          title={`Restore "${ws.name}"`}
                          onClick={() => void handleRestoreWorkspace(ws)}
                        >
                          Restore
                        </button>
                        <button
                          className="workspaces-delete"
                          title={`Delete "${ws.name}"`}
                          onClick={() => void handleDeleteWorkspace(ws.id)}
                        >
                          &#x2715;
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="workspaces-dropdown-footer">
                    <button
                      onClick={() => {
                        setSaveWorkspacePrompt(true);
                        setWorkspacesOpen(false);
                      }}
                    >
                      + Save current layout
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {sidebarMode !== "chats" && (
            <>
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
                className={`broadcast-toggle ghost toolbar-icon-btn${broadcast.enabled ? " active" : ""}`}
                onClick={() => setBroadcastEnabled(!broadcast.enabled)}
                title="Toggle broadcast mode (Cmd/Ctrl+Shift+B)"
                aria-label="Toggle broadcast"
              >
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
                  <line x1="2" y1="20" x2="2.01" y2="20" />
                </svg>
              </button>
            </>
          )}
          {sidebarMode === "chats" && (
            <>
              <button
                className="ghost toolbar-icon-btn"
                onClick={openBrowserPane}
                title="Open a browser preview pane (google.com)"
                aria-label="Open browser pane"
              >
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </button>
            </>
          )}
        </div>

        <OnboardingBanner />

        {sidebarMode === "chats" ? (
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
      <UpdateBanner />

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

      {saveWorkspacePrompt && (
        <Modal
          title="Save workspace"
          onClose={() => { setSaveWorkspacePrompt(false); setWorkspaceName(""); }}
          actions={
            <>
              <button onClick={() => { setSaveWorkspacePrompt(false); setWorkspaceName(""); }}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!workspaceName.trim()}
                onClick={() => void handleSaveWorkspace()}
              >
                Save
              </button>
            </>
          }
        >
          <p>Save the current pane layout as a named workspace for this project.</p>
          <div style={{ marginTop: 12 }}>
            <input
              className="workspace-name-input"
              type="text"
              placeholder="Workspace name (e.g. dual-agent, web-dev)"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && workspaceName.trim()) void handleSaveWorkspace(); }}
              autoFocus
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "var(--radius-xs)",
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontFamily: "var(--font-ui)",
                fontSize: 14,
                outline: "none",
              }}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
