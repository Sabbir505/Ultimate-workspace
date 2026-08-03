// Ephemeral UI state: which overlay view is open, command palette, peek panel,
// and the "grid is full — replace LRU pane?" confirmation (§4.3 step 4).
import { create } from "zustand";

export type ActiveView = "grid" | "settings" | "skills" | "cost" | "chat";

export type SidebarMode = "projects" | "chats";

export interface PeekState {
  open: boolean;
  mode: "file" | "diff";
  projectId: string | null;
  filePath: string | null;
  /** Optional working directory to run git against when this peek was
   *  opened from a per-pane entry point (e.g. the Dev-tab diff side
   *  panel for a worktree-scoped session). When set, the diff is computed
   *  against THIS path (a worktree) rather than the project root.
   *  null/undefined falls back to `project.path` (the project root). */
  cwd: string | null;
}

export interface PendingReplace {
  sessionId: string;
  lruPaneId: string;
}

export interface UiState {
  activeView: ActiveView;
  paletteOpen: boolean;
  peek: PeekState;
  pendingReplace: PendingReplace | null;
  projectSettingsFor: string | null; // projectId with an open Project Settings panel
  gitPromptProjectId: string | null; // projectId that should be prompted to init git (§4.1)
  sidebarCollapsed: boolean; // hide the sidebar to give the main area full width
  sidebarMode: SidebarMode; // dev (projects) vs chat list — persists across collapse
  /** When true, the Dev-tab diff side panel is hidden and replaced with a
   *  thin restore strip (matches the browser pane's minimize UX). */
  diffPanelCollapsed: boolean;
  /** User-resized width of the diff side panel, in pixels. Persists across
   *  rerenders so a manual resize sticks (same as PaneGrid's gridFracs but
   *  scoped to a single side panel). */
  diffPanelWidth: number;
  /** True when ANY modal is open (artifacts library, etc.) so native webviews
   *  know to hide themselves. Modals that use local useState should call
   *  setModalOpen(true/false) around their open/close lifecycle. */
  modalOpen: boolean;
  /** Per-pane inline diff overlay. When `paneId` is set, the file at
   *  `filePath` is rendered as a unified diff over the focused pane (NOT in
   *  the global PeekPanel) — this is what the user asked for: clicking a
   *  file row in the right-side Files panel shows the diff in the pane the
   *  click came from, with the pane still visible/usable underneath. */
  paneDiff: { paneId: string; filePath: string; cwd: string } | null;

  setActiveView: (view: ActiveView) => void;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  openPeek: (peek: Omit<PeekState, "open">) => void;
  closePeek: () => void;
  setPendingReplace: (pending: PendingReplace | null) => void;
  setProjectSettingsFor: (projectId: string | null) => void;
  setGitPromptProjectId: (projectId: string | null) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setDiffPanelCollapsed: (collapsed: boolean) => void;
  toggleDiffPanel: () => void;
  setDiffPanelWidth: (width: number) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  setModalOpen: (open: boolean) => void;
  setPaneDiff: (diff: { paneId: string; filePath: string; cwd: string } | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeView: "grid",
  paletteOpen: false,
  peek: { open: false, mode: "file", projectId: null, filePath: null, cwd: null },
  pendingReplace: null,
  projectSettingsFor: null,
  gitPromptProjectId: null,
  sidebarCollapsed: false,
  sidebarMode: "projects",
  modalOpen: false,
  diffPanelCollapsed: false,
  diffPanelWidth: 280,
  paneDiff: null,

  setActiveView: (activeView) => set({ activeView }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  openPeek: (peek) => set({ peek: { ...peek, open: true } }),
  closePeek: () => set((s) => ({ peek: { ...s.peek, open: false } })),
  setPendingReplace: (pendingReplace) => set({ pendingReplace }),
  setProjectSettingsFor: (projectSettingsFor) => set({ projectSettingsFor }),
  setGitPromptProjectId: (gitPromptProjectId) => set({ gitPromptProjectId }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarMode: (sidebarMode) => set({ sidebarMode }),
  setDiffPanelCollapsed: (diffPanelCollapsed) => set({ diffPanelCollapsed }),
  toggleDiffPanel: () => set((s) => ({ diffPanelCollapsed: !s.diffPanelCollapsed })),
  setDiffPanelWidth: (diffPanelWidth) => set({ diffPanelWidth: Math.max(180, Math.min(720, diffPanelWidth)) }),
  setModalOpen: (modalOpen) => set({ modalOpen }),
  setPaneDiff: (paneDiff) => set({ paneDiff }),
}));
