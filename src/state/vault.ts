// Vault store — the state behind the Vault view (the local markdown
// knowledge base). Mirrors the backend contract: files on disk are the
// source of truth, so this store only caches what the UI is LOOKING at
// (tree, the active note's content, its index metadata) and never edits
// disk directly — every mutation is a vault_* IPC round-trip that also
// reindexes, then this store refreshes.
import { create } from "zustand";
import {
  vaultBind,
  vaultCreateFolder,
  vaultCreateNote,
  vaultDeleteFolder,
  vaultDeleteNote,
  vaultGetState,
  vaultAllTags,
  vaultGraph,
  vaultNoteMeta,
  vaultReadNote,
  vaultRenameNote,
  vaultRescan,
  vaultSearch,
  vaultTree,
  vaultUnbind,
  vaultStats,
  vaultWriteNote,
  type VaultGraphNode,
  type VaultGraphEdge,
  type VaultNoteMeta,
  type VaultSearchHit,
  type VaultStats,
  type VaultTreeNode,
} from "../lib/ipc";
import { useUiStore } from "./ui";

export type VaultMode = "edit" | "split" | "preview";
export type VaultRail = "files" | "search" | "tags";

/** Debounce window for autosave after an edit keystroke. */
export const VAULT_SAVE_DEBOUNCE_MS = 600;

interface VaultStore {
  /** Absolute vault root, null = nothing bound (the view shows the binder). */
  root: string | null;
  stats: VaultStats | null;
  tree: VaultTreeNode[];
  /** The open note: path + live editor text + last-saved text (dirty check). */
  activePath: string | null;
  content: string;
  savedContent: string;
  mode: VaultMode;
  rail: VaultRail;
  rightRailOpen: boolean;
  meta: VaultNoteMeta | null;
  loadingNote: boolean;
  searchQuery: string;
  searchHits: VaultSearchHit[];
  searchLoading: boolean;
  tags: { tag: string; count: number }[];
  graph: { nodes: VaultGraphNode[]; edges: VaultGraphEdge[] } | null;
  graphOpen: boolean;
  /** Switcher visibility (Ctrl+P inside the vault view). */
  switcherOpen: boolean;
  /** Monotonic save-generation counter — guards stale debounce timers. */
  saveGeneration: number;

  init: () => Promise<void>;
  bind: (path: string) => Promise<void>;
  unbind: () => Promise<void>;
  rescan: () => Promise<void>;
  refreshStats: () => Promise<void>;
  loadTree: () => Promise<void>;
  openNote: (path: string, subpath?: string | null) => Promise<void>;
  setContent: (text: string) => void;
  scheduleSave: () => void;
  saveNow: () => Promise<void>;
  closeNote: () => void;
  setMode: (mode: VaultMode) => void;
  setRail: (rail: VaultRail) => void;
  toggleRightRail: () => void;
  createNote: (path: string) => Promise<void>;
  renameNote: (from: string, to: string) => Promise<void>;
  deleteNote: (path: string) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  setSearchQuery: (q: string) => void;
  runSearch: () => Promise<void>;
  loadTags: () => Promise<void>;
  loadGraph: () => Promise<void>;
  setGraphOpen: (open: boolean) => void;
  setSwitcherOpen: (open: boolean) => void;
  /** Watcher event: paths were reindexed on disk. */
  onVaultChanged: (paths: string[]) => void;
  /** Full-rescan finished. */
  onScanned: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useVaultStore = create<VaultStore>((set, get) => ({
  root: null,
  stats: null,
  tree: [],
  activePath: null,
  content: "",
  savedContent: "",
  mode: "split",
  rail: "files",
  rightRailOpen: true,
  meta: null,
  loadingNote: false,
  searchQuery: "",
  searchHits: [],
  searchLoading: false,
  tags: [],
  graph: null,
  graphOpen: false,
  switcherOpen: false,
  saveGeneration: 0,

  init: async () => {
    const state = await vaultGetState().catch(() => null);
    if (!state) return;
    set({ root: state.root, stats: state.stats });
    if (state.root) {
      void get().loadTree();
      void get().refreshStats();
    }
  },

  bind: async (path) => {
    const root = await vaultBind(path);
    set({ root });
    await get().loadTree();
    await get().refreshStats();
  },

  unbind: async () => {
    await vaultUnbind();
    set({ root: null, stats: null, tree: [], activePath: null, content: "", savedContent: "", meta: null, graph: null, tags: [] });
  },

  rescan: async () => {
    await vaultRescan();
    await get().refreshStats();
  },

  refreshStats: async () => {
    const stats = await Promise.resolve(vaultStats())
      .then((v) => v)
      .catch(() => null);
    if (stats) set({ stats });
  },

  loadTree: async () => {
    const tree = await vaultTree().catch(() => []);
    set({ tree });
  },

  openNote: async (path, subpath) => {
    // Unsaved work first: flush whatever is pending so nothing is lost.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await get().saveNow();
    }
    set({ loadingNote: true, activePath: path });
    const content = await vaultReadNote(path).catch(() => "");
    set({ content, savedContent: content, loadingNote: false });
    void vaultNoteMeta(path)
      .then((meta) => set({ meta }))
      .catch(() => set({ meta: null }));
    if (subpath) {
      // Deep-link scroll: the preview listens for `vault:scroll-text` and
      // matches a heading by text within its own [data-note] scope, so the
      // dispatch must land AFTER the new note rendered — fire once when the
      // read has settled and once more for slow renders (idempotent).
      const text = subpath.replace(/^#+\^?/, "").trim();
      if (text) {
        const dispatch = () =>
          window.dispatchEvent(new CustomEvent("vault:scroll-text", { detail: { text } }));
        setTimeout(dispatch, 350);
        setTimeout(dispatch, 900);
      }
    }
  },

  setContent: (text) => set({ content: text }),

  scheduleSave: () => {
    const { content, savedContent, activePath } = get();
    if (!activePath || content === savedContent) return;
    if (saveTimer) clearTimeout(saveTimer);
    const gen = get().saveGeneration;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      // A stale timer (note switched since scheduling) must not fire.
      if (get().saveGeneration === gen) void get().saveNow();
    }, VAULT_SAVE_DEBOUNCE_MS);
  },

  saveNow: async () => {
    const { activePath, content, savedContent } = get();
    if (!activePath || content === savedContent) return;
    set({ saveGeneration: get().saveGeneration + 1 });
    try {
      await vaultWriteNote(activePath, content);
      set({ savedContent: content });
      void get().refreshStats();
    } catch (e) {
      useUiStore.getState().pushToast("error", "Vault save failed", String(e));
    }
  },

  closeNote: () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({ activePath: null, content: "", savedContent: "", meta: null });
  },

  setMode: (mode) => set({ mode }),
  setRail: (rail) => {
    set({ rail });
    if (rail === "tags") void get().loadTags();
    if (rail === "search") void get().runSearch();
  },
  toggleRightRail: () => set((s) => ({ rightRailOpen: !s.rightRailOpen })),

  createNote: async (path) => {
    const withExt = path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
    await vaultCreateNote(withExt, "");
    await get().loadTree();
    await get().refreshStats();
    await get().openNote(withExt);
    set({ mode: "edit" });
  },

  renameNote: async (from, to) => {
    const withExt = to.toLowerCase().endsWith(".md") ? to : `${to}.md`;
    await vaultRenameNote(from, withExt);
    await get().loadTree();
    if (get().activePath === from) {
      await get().openNote(withExt);
    } else {
      await get().loadTree();
    }
  },

  deleteNote: async (path) => {
    await vaultDeleteNote(path);
    if (get().activePath === path) get().closeNote();
    await get().loadTree();
    await get().refreshStats();
  },

  createFolder: async (path) => {
    await vaultCreateFolder(path);
    await get().loadTree();
  },

  deleteFolder: async (path) => {
    await vaultDeleteFolder(path);
    await get().loadTree();
  },

  setSearchQuery: (q) => {
    set({ searchQuery: q });
    void get().runSearch();
  },

  runSearch: async () => {
    const q = get().searchQuery.trim();
    if (!q) {
      set({ searchHits: [] });
      return;
    }
    set({ searchLoading: true });
    const hits = await vaultSearch(q, 40).catch(() => []);
    set({ searchHits: hits, searchLoading: false });
  },

  loadTags: async () => {
    const tags = await vaultAllTags().catch(() => []);
    set({ tags });
  },

  loadGraph: async () => {
    const [nodes, edges] = await vaultGraph(true, false);
    set({ graph: { nodes, edges } });
  },

  setGraphOpen: (graphOpen) => {
    set({ graphOpen });
    if (graphOpen) void get().loadGraph();
  },
  setSwitcherOpen: (switcherOpen) => set({ switcherOpen }),

  onVaultChanged: (paths) => {
    void get().loadTree();
    // The active note changed on disk: reload it unless the user has
    // unsaved edits (their buffer wins; the toast says what happened).
    const { activePath, content, savedContent } = get();
    const touched = activePath != null && paths.some((p) => p === activePath);
    if (touched) {
      if (content !== savedContent) {
        useUiStore.getState().pushToast("info", `"${activePath}" changed on disk — your unsaved edits are kept in the editor.`);
      } else {
        void vaultReadNote(activePath).then((text) => set({ content: text, savedContent: text }));
      }
    }
    if (activePath) {
      void vaultNoteMeta(activePath)
        .then((meta) => set({ meta }))
        .catch(() => {});
    }
    void get().refreshStats();
    if (get().graphOpen) void get().loadGraph();
  },

  onScanned: () => {
    void get().loadTree();
    void get().refreshStats();
  },
}));
