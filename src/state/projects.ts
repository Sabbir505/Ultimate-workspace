// Projects + sessions store. Projects, their session history, git status
// badges (§7.11), harness install status (§9), and sidebar expansion state.
import { create } from "zustand";
import {
  addProject,
  createSession,
  deleteSession,
  getGitStatus,
  initGitRepo,
  listHarnesses,
  listProjects,
  listSessions,
  removeProject,
  renameProject,
  updateSessionTitle,
} from "../lib/ipc";
import type { GitStatusInfo, HarnessId, HarnessStatus, Project, SessionRecord } from "../types";

interface ProjectsState {
  loaded: boolean;
  projects: Project[];
  sessions: SessionRecord[];
  gitStatuses: Record<string, GitStatusInfo>; // keyed by project id
  harnesses: HarnessStatus[];
  expanded: Record<string, boolean>; // projectId -> expanded in sidebar
  selectedProjectId: string | null;

  loadAll: () => Promise<void>;
  refreshHarnesses: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  addProjectAtPath: (path: string) => Promise<Project | null>;
  removeProjectById: (projectId: string) => Promise<void>;
  renameProjectById: (projectId: string, name: string) => Promise<void>;
  markGitRepo: (projectId: string) => Promise<void>;
  createSessionFor: (projectId: string, harness: HarnessId) => Promise<SessionRecord | null>;
  removeSession: (sessionId: string) => Promise<void>;
  setSessionTitle: (sessionId: string, title: string) => Promise<void>;
  setHarnessSessionId: (sessionId: string, harnessSessionId: string) => void;
  refreshGitStatus: () => Promise<void>;
  toggleExpanded: (projectId: string) => void;
  setExpanded: (projectId: string, expanded: boolean) => void;
  selectProject: (projectId: string | null) => void;
  projectById: (projectId: string | null) => Project | null;
  sessionsFor: (projectId: string) => SessionRecord[];
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  loaded: false,
  projects: [],
  sessions: [],
  gitStatuses: {},
  harnesses: [],
  expanded: {},
  selectedProjectId: null,

  loadAll: async () => {
    const [projects, sessions, harnesses] = await Promise.all([
      listProjects(),
      listSessions(),
      listHarnesses(),
    ]);
    set({
      loaded: true,
      projects: projects ?? [],
      sessions: sessions ?? [],
      harnesses: harnesses ?? [],
    });
    void get().refreshGitStatus();
  },

  refreshHarnesses: async () => {
    const harnesses = await listHarnesses();
    if (harnesses) set({ harnesses });
  },

  refreshSessions: async () => {
    const sessions = await listSessions();
    if (sessions) set({ sessions });
  },

  addProjectAtPath: async (path) => {
    const project = await addProject(path);
    if (project) {
      set((s) => ({
        projects: [project, ...s.projects.filter((p) => p.id !== project.id)],
        selectedProjectId: project.id,
        expanded: { ...s.expanded, [project.id]: true },
      }));
    }
    return project;
  },

  removeProjectById: async (projectId) => {
    await removeProject(projectId);
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== projectId),
      sessions: s.sessions.filter((sess) => sess.projectId !== projectId),
      selectedProjectId: s.selectedProjectId === projectId ? null : s.selectedProjectId,
    }));
  },

  renameProjectById: async (projectId, name) => {
    await renameProject(projectId, name);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? { ...p, name } : p)),
    }));
  },

  markGitRepo: async (projectId) => {
    await initGitRepo(projectId);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? { ...p, isGitRepo: true } : p)),
    }));
    void get().refreshGitStatus();
  },

  createSessionFor: async (projectId, harness) => {
    const session = await createSession(projectId, harness);
    if (session) set((s) => ({ sessions: [session, ...s.sessions] }));
    return session;
  },

  removeSession: async (sessionId) => {
    await deleteSession(sessionId);
    set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== sessionId) }));
  },

  setSessionTitle: async (sessionId, title) => {
    await updateSessionTitle(sessionId, title);
    set((s) => ({
      sessions: s.sessions.map((sess) => (sess.id === sessionId ? { ...sess, title } : sess)),
    }));
  },

  setHarnessSessionId: (sessionId, harnessSessionId) =>
    set((s) => ({
      sessions: s.sessions.map((sess) => (sess.id === sessionId ? { ...sess, harnessSessionId } : sess)),
    })),

  refreshGitStatus: async () => {
    // Poll git status for every project visible in the sidebar (§7.11).
    const projects = get().projects;
    const entries = await Promise.all(
      projects.map(async (p) => [p.id, await getGitStatus(p.path)] as const),
    );
    const gitStatuses: Record<string, GitStatusInfo> = {};
    for (const [id, status] of entries) if (status) gitStatuses[id] = status;
    set({ gitStatuses });
  },

  toggleExpanded: (projectId) =>
    set((s) => ({ expanded: { ...s.expanded, [projectId]: !s.expanded[projectId] } })),

  setExpanded: (projectId, expanded) => set((s) => ({ expanded: { ...s.expanded, [projectId]: expanded } })),

  selectProject: (projectId) => set({ selectedProjectId: projectId }),

  projectById: (projectId) => (projectId ? (get().projects.find((p) => p.id === projectId) ?? null) : null),

  sessionsFor: (projectId) =>
    get()
      .sessions.filter((s) => s.projectId === projectId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt),
}));
