// Ephemeral UI state: which overlay view is open, command palette, peek panel,
// and the "grid is full — replace LRU pane?" confirmation (§4.3 step 4).
import { create } from "zustand";

export type ActiveView = "chat" | "settings" | "skills" | "cost" | "automations";

/** Tabs in the right-side tool panel (mockups 01/03). */
export type ToolPanelTab =
  | "terminal"
  | "browser"
  | "files" // "Changes" — DevDiffPanel (changed files + inline diffs)
  | "pulls" // "Pull Requests" — PullsPanel (GitHub PR list/create/review)
  | "canvas"
  | "branch" // Branch switcher + git graph
  | "commit" // Commit/push panel
  | "plans" // Agent plan/step timeline
  | "progress" // Task progress panel
  | "agents" // Subagent view panel
  | "artifact"; // A generated code artifact (tsx/jsx/html) rendered in-pane

/** One open tab in the right tool panel. Multiple instances of the same
 *  `kind` can coexist — e.g. several terminals pointed at different panes,
 *  several agents each showing a different subagent, etc. */
export interface ToolPanelTabInstance {
  /** Unique id within this app session (e.g. "t3"). */
  instanceId: string;
  kind: ToolPanelTab;
  /** For terminal/browser tabs: the paneId this tab points at. */
  paneId?: string;
  /** For agents tabs: the subagent this tab shows. */
  subagentId?: string;
  /** For artifact tabs: the on-disk artifact file to preview. */
  artifactPath?: string;
  artifactFilename?: string;
  /** For inline (chat code-fence) artifacts: the live preview payload. */
  artifactInline?: { kind: "jsx" | "tsx"; code: string };
}

/** Live progress of a model download from the Hugging Face model market.
 *  Keyed by download id (repo::filename). Updated by local-model:download:progress
 *  events; persisted globally so the user sees progress even after navigating
 *  away from the Model Market tab. */
export interface ModelDownloadProgress {
  id: string;
  state: "starting" | "downloading" | "verifying" | "done" | "error" | "cancelled";
  downloaded: number;
  total: number | null;
  bps: number;
  finalPath: string | null;
  error: string | null;
}

export interface PeekState {
  open: boolean;
  mode: "file" | "diff";
  projectId: string | null;
  filePath: string | null;
  /** Optional working directory to run git against when this peek was
   *  opened from a per-pane entry point (e.g. the Changes panel for a
   *  worktree-scoped session). When set, the diff is computed
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
  /** When set, the next SettingsView mount opens directly on this category
   *  (e.g. "connectors" from the sidebar's Connectors row). SettingsView
   *  consumes and clears it. */
  settingsCategory: string | null;
  /** One-shot deep-link consumed by the Local Models settings panel: open
   *  directly on the "market" tab (used by the local-model onboarding
   *  banner). Cleared after the first consume. */
  localModelsOpenMarket: boolean;
  /** When true, the Changes (diff) panel is hidden and replaced with a
   *  thin restore strip (matches the browser pane's minimize UX). */
  diffPanelCollapsed: boolean;
  /** User-resized width of the diff side panel, in pixels. Persists across
   *  rerenders so a manual resize sticks (scoped to a single side panel). */
  diffPanelWidth: number;
  /** True when ANY modal is open (artifacts library, etc.) so native webviews
   *  know to hide themselves. DERIVED from `openModalIds` — writers register
   *  their own modal id via setModalOpen(id, open) so competing modals can't
   *  stomp each other (M22): with a single shared boolean, closing modal A
   *  set it false while modal B was still open and the native webview
   *  painted over B. */
  modalOpen: boolean;
  /** Ids of the currently open modals — `modalOpen` is true while non-empty. */
  openModalIds: string[];
  /** Active tab in the right-side tool panel. */
  toolPanelTab: ToolPanelTab;
  /** When true, the tool panel is hidden and replaced with a thin restore
   *  strip (same UX as the diff panel / browser pane minimize). Tab contents
   *  stay mounted so terminals and browser webviews keep running. */
  toolPanelCollapsed: boolean;
  /** User-resized width of the tool panel, in pixels (280–640). */
  toolPanelWidth: number;
  /** Whether the Git tools sidebar (right-side vertical panel) is collapsed. */
  gitSidebarCollapsed: boolean;
  /** Plan markdown content to show in the Canvas tab. Set when a plan
   *  row is clicked in the Git tools sidebar. */
  planCanvasContent: string | null;
  planCanvasTitle: string | null;
  /** File path to diff in the ToolPanel's Changes tab. Set when a peek
   *  icon is clicked on a dirty file listing (branch switch modal, etc.). */
  diffPanelFile: string | null;
  diffPanelCwd: string | null;
  /** Global model download progress from the Hugging Face market, keyed by
   *  download id (repo::filename). Updated by local-model:download:progress
   *  events so the user sees progress even after leaving the Model Market. */
  modelDownloads: Record<string, ModelDownloadProgress>;
  /** Apply a download-progress event payload to the global download map.
   *  Completed/cancelled/errored downloads are removed on a short delay so
   *  the user can see the terminal state. */
  updateModelDownload: (p: ModelDownloadProgress) => void;

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
  setSettingsCategory: (category: string | null) => void;
  setLocalModelsOpenMarket: (open: boolean) => void;
  setDiffPanelCollapsed: (collapsed: boolean) => void;
  toggleDiffPanel: () => void;
  setDiffPanelWidth: (width: number) => void;
  /** Register/unregister a modal id; `modalOpen` derives from the id set.
   *  Idempotent — re-passing the current state returns the same store slice
   *  so effect loops don't churn. */
  setModalOpen: (id: string, open: boolean) => void;
  setToolPanelTab: (tab: ToolPanelTab) => void;
  /** Open tabs in the right-side tool panel — supports MULTIPLE instances of
   *  the same kind (several terminals, several browsers, several agents, …).
   *  Each instance carries its own kind and optional target (paneId for
   *  terminal/browser, subagentId for agents) so they stay distinct. */
  openTabs: ToolPanelTabInstance[];
  /** Monotonic id counter for new tab instances. */
  nextTabId: number;
  /** Active tab instance id. */
  activeTabId: string | null;
  /** Add a tab (spawning a new instance of that kind) and activate it. */
  addTab: (kind: ToolPanelTab, target?: { paneId?: string; subagentId?: string }) => void;
  /** Open a generated code artifact as its own main tab (auto-opens). Dedupes
   *  by path: if a matching artifact tab is already open, just activates it. */
  openArtifactTab: (artifact: {
    path: string;
    filename: string;
    inline?: { kind: "jsx" | "tsx"; code: string };
  }) => void;
  /** Close a specific open tab by instance id. Does nothing if unknown. */
  closeTab: (instanceId: string) => void;
  /** Activate (focus) an existing open tab instance. */
  activateTab: (instanceId: string) => void;
  /** Move a tab instance to a new index (drag-to-reorder). */
  reorderTab: (instanceId: string, toIndex: number) => void;
  /** Currently selected subagent id, or null for the "agents" tab. */
  activeSubagentId: string | null;
  setActiveSubagentId: (id: string | null) => void;
  setToolPanelCollapsed: (collapsed: boolean) => void;
  toggleToolPanel: () => void;
  toggleGitSidebar: () => void;
  setPlanCanvas: (content: string | null, title: string | null) => void;
  setDiffPanelFile: (file: string | null, cwd: string | null) => void;
  setToolPanelWidth: (width: number) => void;
  /** Transient toast notifications (bottom-right stack). Errors from IPC
   *  calls that used to die in console.warn land here instead. */
  toasts: Toast[];
  pushToast: (kind: ToastKind, message: string, detail?: string) => void;
  dismissToast: (id: number) => void;
}

export type ToastKind = "error" | "info" | "success";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
}

let nextToastId = 1;
/** Errors stay up longer than info/success — the user needs time to read
 *  what failed; successes are just confirmations. */
const TOAST_TTL_MS: Record<ToastKind, number> = { error: 9000, info: 5000, success: 4000 };

export const useUiStore = create<UiState>((set) => ({
  activeView: "chat",
  paletteOpen: false,
  peek: { open: false, mode: "file", projectId: null, filePath: null, cwd: null },
  pendingReplace: null,
  projectSettingsFor: null,
  gitPromptProjectId: null,
  sidebarCollapsed: false,
  settingsCategory: null,
  localModelsOpenMarket: false,
  modalOpen: false,
  openModalIds: [],
  diffPanelCollapsed: false,
  diffPanelWidth: 280,
  toasts: [],
  toolPanelTab: "terminal",
  // Open tabs in the right tool panel. Multi-instance — you can have several
  // terminals, several browsers, several agents, etc. Each tab instance has
  // its own kind + optional paneId/subagentId.
  openTabs: [],
  nextTabId: 1,
  activeTabId: null,
  activeSubagentId: null,
  // Collapsed by default — the header split icon opens it on demand.
  toolPanelCollapsed: true,
  toolPanelWidth: 532,
  // Open by default — it's the primary git surface now.
  gitSidebarCollapsed: true,
  planCanvasContent: null,
  planCanvasTitle: null,
  diffPanelFile: null,
  diffPanelCwd: null,
  modelDownloads: {},

  updateModelDownload: (p) =>
    set((s) => {
      const next = { ...s.modelDownloads, [p.id]: p };
      // Remove terminal downloads after a short visible window (3s) so the
      // user sees the "done" / "error" / "cancelled" state before it vanishes.
      // Only delete when STILL terminal: if the user restarted the same file
      // (ids are repo::filename) within the window, the fresh entry is
      // downloading again and must survive the stale timer.
      if (p.state === "done" || p.state === "error" || p.state === "cancelled") {
        window.setTimeout(() => {
          useUiStore.setState((s2) => {
            const current = s2.modelDownloads[p.id];
            const stillTerminal =
              current != null &&
              (current.state === "done" ||
                current.state === "error" ||
                current.state === "cancelled");
            if (!stillTerminal) return s2; // no-op slice — zustand skips notify
            const cleaned = { ...s2.modelDownloads };
            delete cleaned[p.id];
            return { modelDownloads: cleaned };
          });
        }, 3000);
      }
      return { modelDownloads: next };
    }),

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
  setSettingsCategory: (settingsCategory) => set({ settingsCategory }),
  setLocalModelsOpenMarket: (localModelsOpenMarket) => set({ localModelsOpenMarket }),
  setDiffPanelCollapsed: (diffPanelCollapsed) => set({ diffPanelCollapsed }),
  toggleDiffPanel: () => set((s) => ({ diffPanelCollapsed: !s.diffPanelCollapsed })),
  setDiffPanelWidth: (diffPanelWidth) => set({ diffPanelWidth: Math.max(180, Math.min(720, diffPanelWidth)) }),
  setModalOpen: (id, open) =>
    set((s) => {
      const has = s.openModalIds.includes(id);
      if (open === has) return s; // no-op: don't churn renderers
      const openModalIds = open
        ? [...s.openModalIds, id]
        : s.openModalIds.filter((x) => x !== id);
      return { openModalIds, modalOpen: openModalIds.length > 0 };
    }),
  setToolPanelTab: (toolPanelTab) => set({ toolPanelTab }),
  // Add a new tab INSTANCE of the given kind (multiple same-kind tabs allowed).
  addTab: (kind, target) =>
    set((s) => {
      const instanceId = `t${s.nextTabId}`;
      const tab: ToolPanelTabInstance = {
        instanceId,
        kind,
        paneId: target?.paneId,
        subagentId: target?.subagentId,
      };
      const openTabs = [...s.openTabs, tab];
      // Bounded strip — drop the oldest (front) instances. This is lenient:
      // closing old tabs, not erroring. Case of the user opening a lot of
      // same-kind panes.
      if (openTabs.length > 8) openTabs.splice(0, openTabs.length - 8);
      return {
        openTabs,
        nextTabId: s.nextTabId + 1,
        activeTabId: instanceId,
        toolPanelTab: kind,
        // Opening an agent tab focuses that subagent in the panel.
        ...(kind === "agents" ? { activeSubagentId: target?.subagentId ?? s.activeSubagentId } : {}),
      };
    }),
  // Open a generated code artifact (tsx/jsx/html) as its own tab. If one is
  // already open for the same path, just activate/dedupe it — don't stack
  // duplicate tabs for the same file.
  openArtifactTab: (artifact) =>
    set((s) => {
      // Dedupe by path when it's an on-disk artifact.
      if (artifact.path && !artifact.inline) {
        const existing = s.openTabs.find(
          (t) => t.kind === "artifact" && t.artifactPath === artifact.path,
        );
        if (existing) {
          return {
            activeTabId: existing.instanceId,
            toolPanelTab: "artifact",
            toolPanelCollapsed: false,
          };
        }
      }
      const instanceId = `t${s.nextTabId}`;
      const tab: ToolPanelTabInstance = {
        instanceId,
        kind: "artifact",
        artifactPath: artifact.path,
        artifactFilename: artifact.filename,
        artifactInline: artifact.inline,
      };
      const openTabs = [...s.openTabs, tab];
      if (openTabs.length > 8) openTabs.splice(0, openTabs.length - 8);
      return {
        openTabs,
        nextTabId: s.nextTabId + 1,
        activeTabId: instanceId,
        toolPanelTab: "artifact",
        // Auto-expand the panel so the user sees the preview immediately.
        toolPanelCollapsed: false,
      };
    }),
  // Close a tab by instance id.
  closeTab: (instanceId) =>
    set((s) => {
      const idx = s.openTabs.findIndex((t) => t.instanceId === instanceId);
      if (idx === -1) return {};
      const openTabs = [...s.openTabs];
      openTabs.splice(idx, 1);
      // If we closed the active tab, switch to an adjacent one.
      let activeTabId = s.activeTabId;
      let toolPanelTab = s.toolPanelTab;
      if (s.activeTabId === instanceId) {
        const next = openTabs[Math.min(idx, openTabs.length - 1)];
        activeTabId = next?.instanceId ?? null;
        toolPanelTab = next?.kind ?? "terminal";
      }
      return { openTabs, activeTabId, toolPanelTab };
    }),
  // Activate (focus) an existing tab instance.
  activateTab: (instanceId) =>
    set((s) => {
      const tab = s.openTabs.find((t) => t.instanceId === instanceId);
      if (!tab) return {};
      return { activeTabId: instanceId, toolPanelTab: tab.kind };
    }),
  // Move a tab instance to a new index (clamped). Used for drag-to-reorder.
  reorderTab: (instanceId, toIndex) =>
    set((s) => {
      const fromIndex = s.openTabs.findIndex((t) => t.instanceId === instanceId);
      if (fromIndex === -1) return {};
      const openTabs = [...s.openTabs];
      const [tab] = openTabs.splice(fromIndex, 1);
      const clamped = Math.max(0, Math.min(openTabs.length, toIndex));
      openTabs.splice(clamped, 0, tab);
      return { openTabs };
    }),
  setActiveSubagentId: (activeSubagentId) => set({ activeSubagentId }),
  setToolPanelCollapsed: (toolPanelCollapsed) => set({ toolPanelCollapsed }),
  toggleToolPanel: () => set((s) => ({ toolPanelCollapsed: !s.toolPanelCollapsed })),
  toggleGitSidebar: () => set((s) => ({ gitSidebarCollapsed: !s.gitSidebarCollapsed })),
  setPlanCanvas: (content, title) => set({ planCanvasContent: content, planCanvasTitle: title }),
  setDiffPanelFile: (diffPanelFile, diffPanelCwd) => set({ diffPanelFile, diffPanelCwd }),
  setToolPanelWidth: (toolPanelWidth) =>
    set({ toolPanelWidth: Math.max(280, Math.min(900, toolPanelWidth)) }),
  pushToast: (kind, message, detail) => {
    const id = nextToastId++;
    // Cap the stack so a failing poll loop can't accumulate hundreds.
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message, detail }] }));
    setTimeout(() => {
      useUiStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, TOAST_TTL_MS[kind]);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
