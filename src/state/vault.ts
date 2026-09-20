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
  vaultMoveFile,
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

/** Rail layout bounds (px). The drag handles clamp to these; the rails also
 *  flex-shrink below their width when the tool panel squeezes the view. */
export const VAULT_LEFT_RAIL = { default: 224, min: 210, max: 400 };
export const VAULT_RIGHT_RAIL = { default: 272, min: 200, max: 440 };

interface VaultLayout {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  noteSplitPct: number;
  assetSplitPct: number;
}

const LAYOUT_KEY = "relay.vault.layout";

function clampPct(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(80, Math.max(20, n));
}

/** Survives restarts; guarded because tests (and odd embeds) may lack storage. */
function loadLayout() {
  const fallback = { leftRailWidth: VAULT_LEFT_RAIL.default, rightRailWidth: VAULT_RIGHT_RAIL.default, leftRailCollapsed: false, noteSplitPct: 50, assetSplitPct: 58 };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<VaultLayout>;
    return {
      leftRailWidth: clampWidth(p.leftWidth, VAULT_LEFT_RAIL),
      rightRailWidth: clampWidth(p.rightWidth, VAULT_RIGHT_RAIL),
      leftRailCollapsed: p.leftCollapsed === true,
      noteSplitPct: clampPct(p.noteSplitPct, 50),
      assetSplitPct: clampPct(p.assetSplitPct, 58),
    };
  } catch {
    return fallback;
  }
}

function clampWidth(v: unknown, b: { min: number; max: number; default: number }): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : b.default;
  return Math.min(b.max, Math.max(b.min, n));
}

function saveLayout(l: VaultLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    // private mode / storage full — layout just won't persist
  }
}

interface VaultStore {
  /** Absolute vault root, null = nothing bound (the view shows the binder). */
  root: string | null;
  stats: VaultStats | null;
  tree: VaultTreeNode[];
  /** The open item: path + live editor text + last-saved text (dirty check). */
  activePath: string | null;
  /** The open non-note asset (pdf/image/…), independent of the note so both
   *  can sit side by side — take notes while reading a pdf. */
  assetPath: string | null;
  /** Editor|preview split (percent to the editor) and asset|note split —
   *  both user-resizable and persisted. */
  noteSplitPct: number;
  assetSplitPct: number;
  content: string;
  savedContent: string;
  mode: VaultMode;
  rail: VaultRail;
  /** Left/right rail widths (px) and the collapsed left rail — persisted. */
  leftRailWidth: number;
  rightRailWidth: number;
  leftRailCollapsed: boolean;
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
  openFile: (path: string) => void;
  closeAsset: () => void;
  setContent: (text: string) => void;
  scheduleSave: () => void;
  saveNow: () => Promise<void>;
  closeNote: () => void;
  setMode: (mode: VaultMode) => void;
  setRail: (rail: VaultRail) => void;
  setLeftRailWidth: (w: number) => void;
  setRightRailWidth: (w: number) => void;
  setNoteSplitPct: (p: number) => void;
  setAssetSplitPct: (p: number) => void;
  toggleLeftRail: () => void;
  toggleRightRail: () => void;
  /** Drag & drop: move a file (note or asset) into a folder ("" = root).
   *  Notes go through renameNote so inbound links are rewritten. */
  moveEntry: (from: string, dir: string) => Promise<void>;
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
  /** Restore a previously-recorded vault state (Back/Forward navigation).
   *  Reloads the snapshot note's content without recording a new step. */
  restoreSnapshot: (snap: {
    graphOpen: boolean;
    assetPath: string | null;
    activePath: string | null;
  }) => Promise<void>;
  /** Watcher event: paths were reindexed on disk. */
  onVaultChanged: (paths: string[]) => void;
  /** Full-rescan finished. */
  onScanned: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Record the current note/asset/graph trio in the shell's back/forward
 *  timeline (ui store) — vault navigation joins view history, so the
 *  title-bar arrows step through notes/pdfs/graph states. */
function recordVaultNav(s: {
  graphOpen: boolean;
  assetPath: string | null;
  activePath: string | null;
}) {
  useUiStore.getState().recordVaultNav({
    graphOpen: s.graphOpen,
    assetPath: s.assetPath,
    activePath: s.activePath,
  });
}
/** Monotonic open-generation counter — guards async loads against note
 *  switches (a slow read must never land its text in a newer note's buffer
 *  with savedContent matched: the next keystroke would autosave the wrong
 *  file's content into the active note). */
let openGeneration = 0;

/** Deep-link scroll: the preview listens for `vault:scroll-text` and matches
 *  a heading by text within its own [data-note] scope, so the dispatch must
 *  land AFTER the note rendered — fire twice for slow renders (idempotent). */
function dispatchSubpathScroll(subpath?: string | null) {
  const text = (subpath ?? "").replace(/^#+\^?/, "").trim();
  if (!text) return;
  const dispatch = () =>
    window.dispatchEvent(new CustomEvent("vault:scroll-text", { detail: { text } }));
  setTimeout(dispatch, 350);
  setTimeout(dispatch, 900);
}

/**
 * Resolve a link target to a concrete note path. Wikilink-style targets
 * (extensionless stems, folder-qualified spellings) go through the backend
 * index — the CRUD backend takes EXACT vault-relative paths only, so
 * `[[My Note]]` must be resolved before any read/write, or the editor opens
 * a phantom empty note and the next autosave errors. Mirrors the Rust
 * resolver's precedence (exact basename → stem) with shortest-path ranking;
 * returns the target unchanged when it already spells a .md path.
 */
async function resolveNotePath(target: string): Promise<string | null> {
  const t = target.trim().replace(/^\.\//, "");
  if (!t) return null;
  if (/\.md$/i.test(t)) return t;
  try {
    const hits = await vaultSearch(`file:"${t}"`, 25).catch(() => []);
    const lc = t.toLowerCase();
    const ranked = hits
      .filter((h) => {
        const base = h.basename.toLowerCase();
        const dot = base.lastIndexOf(".");
        const stem = dot > 0 ? base.slice(0, dot) : base;
        return base === lc || stem === lc;
      })
      .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    return ranked[0]?.path ?? null;
  } catch {
    return null;
  }
}

function vaultToast(kind: "error" | "info", title: string, detail?: string) {
  useUiStore.getState().pushToast(kind, title, detail);
}

export const useVaultStore = create<VaultStore>((set, get) => {
  /** Snapshot the resizable layout to localStorage (guarded inside). */
  const persistLayout = () => {
    const s = get();
    saveLayout({
      leftWidth: s.leftRailWidth,
      rightWidth: s.rightRailWidth,
      leftCollapsed: s.leftRailCollapsed,
      noteSplitPct: s.noteSplitPct,
      assetSplitPct: s.assetSplitPct,
    });
  };
  return ({
  root: null,
  stats: null,
  tree: [],
  activePath: null,
  assetPath: null,
  content: "",
  savedContent: "",
  mode: "preview",
  rail: "files",
  ...loadLayout(),
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
    // A rebind (change vault) must not keep the previous vault's open note
    // in the editor — the next autosave would write it into the NEW vault.
    set({ root, activePath: null, assetPath: null, content: "", savedContent: "", meta: null, graph: null, tags: [] });
    await get().loadTree();
    await get().refreshStats();
  },

  unbind: async () => {
    await vaultUnbind();
    set({ root: null, stats: null, tree: [], activePath: null, assetPath: null, content: "", savedContent: "", meta: null, graph: null, tags: [] });
  },

  rescan: async () => {
    try {
      await vaultRescan();
    } catch (e) {
      vaultToast("error", "Could not rebuild the index", String(e));
      return;
    }
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
    // Same-note deep link (`[[#Heading]]`): nothing to load, just scroll.
    if (!path.trim()) {
      dispatchSubpathScroll(subpath);
      return;
    }
    // Unsaved work first: flush whatever is pending so nothing is lost.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await get().saveNow();
    }
    const gen = ++openGeneration;
    set({ loadingNote: true });
    const resolved = await resolveNotePath(path);
    if (gen !== openGeneration) return; // a newer open superseded this one
    if (!resolved) {
      set({ loadingNote: false });
      vaultToast("info", `No note named "${path}" in the vault.`, "Create it or check the spelling.");
      return;
    }
    // Opening anything closes the graph overlay — otherwise the note opens
    // "behind" the graph and nothing visibly changes.
    set({ activePath: resolved, graphOpen: false });
    recordVaultNav(get());
    const content = await vaultReadNote(resolved).catch(() => null);
    if (gen !== openGeneration) return;
    if (content == null) {
      set({ loadingNote: false });
      vaultToast("error", `Could not read "${resolved}".`);
      return;
    }
    set({ content, savedContent: content, loadingNote: false });
    void vaultNoteMeta(resolved)
      .then((meta) => {
        if (gen === openGeneration) set({ meta });
      })
      .catch(() => {
        if (gen === openGeneration) set({ meta: null });
      });
    dispatchSubpathScroll(subpath);
  },

  /** Open a non-note asset (pdf/image/audio/…). Notes and assets share
   *  activePath (the tree highlights either), but only openNote touches the
   *  editor buffer — an asset must never leave text in it for the next
   *  note's autosave to write. */
  /** Show a non-note asset (pdf/image/…) in its own pane. The open NOTE
   *  stays put — the two sit side by side so you can take notes while
   *  reading. Touches none of the editor state. Closes the graph overlay. */
  openFile: (path) => {
    if (!path.trim()) return;
    set({ assetPath: path, graphOpen: false });
    recordVaultNav(get());
  },

  closeAsset: () => {
    set({ assetPath: null });
    recordVaultNav(get());
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
    recordVaultNav(get());
  },

  setMode: (mode) => set({ mode }),
  setRail: (rail) => {
    set({ rail });
    if (rail === "tags") void get().loadTags();
    if (rail === "search") void get().runSearch();
  },
  setLeftRailWidth: (w) => {
    set({ leftRailWidth: clampWidth(w, VAULT_LEFT_RAIL) });
    persistLayout();
  },
  setRightRailWidth: (w) => {
    set({ rightRailWidth: clampWidth(w, VAULT_RIGHT_RAIL) });
    persistLayout();
  },
  setNoteSplitPct: (p) => {
    set({ noteSplitPct: clampPct(p, 50) });
    persistLayout();
  },
  setAssetSplitPct: (p) => {
    set({ assetSplitPct: clampPct(p, 58) });
    persistLayout();
  },
  toggleLeftRail: () => {
    set((s) => ({ leftRailCollapsed: !s.leftRailCollapsed }));
    persistLayout();
  },
  toggleRightRail: () => set((s) => ({ rightRailOpen: !s.rightRailOpen })),

  moveEntry: async (from, dir) => {
    const name = from.split("/").pop() ?? from;
    const to = dir ? `${dir}/${name}` : name;
    if (to === from) return;
    if (from.toLowerCase().endsWith(".md")) {
      // renameNote rewrites inbound links vault-wide AND reopens the note
      // when it was the active one — a move must not dangle links.
      await get().renameNote(from, to);
      return;
    }
    try {
      await vaultMoveFile(from, to);
    } catch (e) {
      vaultToast("error", "Could not move file", String(e));
      return;
    }
    await get().loadTree();
  },

  createNote: async (path) => {
    const withExt = path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
    try {
      await vaultCreateNote(withExt, "");
    } catch (e) {
      vaultToast("error", "Could not create note", String(e));
      return;
    }
    await get().loadTree();
    await get().refreshStats();
    await get().openNote(withExt);
    set({ mode: "edit" });
  },

  renameNote: async (from, to) => {
    // Non-note assets have no rename path: the backend rewrites vault-wide
    // links (notes only) and requires a .md target, so a pdf renamed here
    // would come out as "file.pdf.md" with every embed of it now dangling.
    if (!from.toLowerCase().endsWith(".md")) {
      vaultToast("info", "Only notes (.md) can be renamed from the vault view.", "Rename non-note files in your file manager.");
      return;
    }
    const withExt = to.toLowerCase().endsWith(".md") ? to : `${to}.md`;
    // Flush BEFORE the move: a pending autosave still targets `from`, and
    // firing it after the rename would recreate the old file with the fresh
    // edits (two divergent copies, silently).
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await get().saveNow();
    }
    try {
      await vaultRenameNote(from, withExt);
    } catch (e) {
      vaultToast("error", "Could not rename", String(e));
      return;
    }
    await get().loadTree();
    if (get().activePath === from) {
      await get().openNote(withExt);
    }
  },

  deleteNote: async (path) => {
    try {
      await vaultDeleteNote(path);
    } catch (e) {
      vaultToast("error", "Could not delete note", String(e));
      return;
    }
    if (get().activePath === path) get().closeNote();
    await get().loadTree();
    await get().refreshStats();
  },

  createFolder: async (path) => {
    try {
      await vaultCreateFolder(path);
    } catch (e) {
      vaultToast("error", "Could not create folder", String(e));
      return;
    }
    await get().loadTree();
  },

  deleteFolder: async (path) => {
    try {
      await vaultDeleteFolder(path);
    } catch (e) {
      vaultToast("error", "Could not delete folder", String(e));
      return;
    }
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
    // Attachments included: the graph shows assets too (legend filters them).
    const [nodes, edges] = await vaultGraph(true, true);
    set({ graph: { nodes, edges } });
  },

  setGraphOpen: (graphOpen) => {
    set({ graphOpen });
    if (graphOpen) void get().loadGraph();
    recordVaultNav(get());
  },
  setSwitcherOpen: (switcherOpen) => set({ switcherOpen }),

  onVaultChanged: (paths) => {
    void get().loadTree();
    // The active note changed on disk. The watcher ALSO fires for our own
    // autosaves (atomic_write's temp+rename is just file events to notify),
    // so "dirty + event" alone must not toast: only treat it as an external
    // edit when the disk text actually differs from what we last saved.
    const { activePath, content, savedContent } = get();
    const touched = activePath != null && paths.some((p) => p === activePath);
    if (touched && activePath != null) {
      const pathAtEvent = activePath;
      void vaultReadNote(pathAtEvent)
        .then((disk) => {
          const cur = get();
          if (cur.activePath !== pathAtEvent) return;
          if (cur.content !== cur.savedContent) {
            if (disk !== cur.savedContent) {
              vaultToast(
                "info",
                `"${pathAtEvent}" changed on disk — your unsaved edits are kept in the editor.`,
              );
            }
          } else if (disk !== cur.content) {
            set({ content: disk, savedContent: disk });
          }
        })
        .catch(() => {});
    }
    if (activePath) {
      const pathAtEvent = activePath;
      void vaultNoteMeta(pathAtEvent)
        .then((meta) => {
          if (get().activePath === pathAtEvent) set({ meta });
        })
        .catch(() => {});
    }
    void get().refreshStats();
    if (get().graphOpen) void get().loadGraph();
  },

  onScanned: () => {
    void get().loadTree();
    void get().refreshStats();
  },

  restoreSnapshot: async (snap) => {
    // Flush pending edits first — a restore must not drop them.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await get().saveNow();
    }
    if (get().activePath !== snap.activePath) {
      if (!snap.activePath) {
        set({ activePath: null, content: "", savedContent: "", meta: null });
      } else {
        set({ activePath: snap.activePath, loadingNote: true });
        const content = await vaultReadNote(snap.activePath).catch(() => null);
        // The snapshot may have been superseded mid-load — only land the
        // text if the restore is still the latest navigation.
        set({ content: content ?? "", savedContent: content ?? "", loadingNote: false, meta: null });
        if (get().activePath === snap.activePath) {
          void vaultNoteMeta(snap.activePath)
            .then((m) => set({ meta: m }))
            .catch(() => {});
        }
      }
    }
    set({ graphOpen: snap.graphOpen, assetPath: snap.assetPath });
    if (snap.graphOpen && !get().graph) void get().loadGraph();
  },
  });
});
