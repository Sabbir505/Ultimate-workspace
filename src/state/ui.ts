// Ephemeral UI state: which overlay view is open, command palette, peek panel,
// and the "grid is full — replace LRU pane?" confirmation (§4.3 step 4).
import { create } from "zustand";

export type ActiveView = "grid" | "settings" | "skills" | "cost" | "chat";

export interface PeekState {
  open: boolean;
  mode: "file" | "diff";
  projectId: string | null;
  filePath: string | null;
}

export interface PendingReplace {
  sessionId: string;
  lruPaneId: string;
}

interface UiState {
  activeView: ActiveView;
  paletteOpen: boolean;
  peek: PeekState;
  pendingReplace: PendingReplace | null;
  projectSettingsFor: string | null; // projectId with an open Project Settings panel
  gitPromptProjectId: string | null; // projectId that should be prompted to init git (§4.1)
  sidebarCollapsed: boolean; // hide the sidebar to give the main area full width

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
}

export const useUiStore = create<UiState>((set) => ({
  activeView: "grid",
  paletteOpen: false,
  peek: { open: false, mode: "file", projectId: null, filePath: null },
  pendingReplace: null,
  projectSettingsFor: null,
  gitPromptProjectId: null,
  sidebarCollapsed: false,

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
}));
