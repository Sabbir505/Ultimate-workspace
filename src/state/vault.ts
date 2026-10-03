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

export type VaultMode = "edit" | "preview";
export type VaultRail = "files" | "search" | "tags";

/** Debounce window for autosave after an edit keystroke. */
export const VAULT_SAVE_DEBOUNCE_MS = 600;

/** Debounce window for per-keystroke search queries. */
export const VAULT_SEARCH_DEBOUNCE_MS = 200;

/** Rail layout bounds (px). The drag handles clamp to these; the rails also
 *  flex-shrink toward their min when the view is squeezed (tool panel open
 *  on a narrow window) — the min is what always holds. Files tree and
 *  outline share the same bounds. */
export const VAULT_LEFT_RAIL = { default: 250, min: 250, max: 400 };
export const VAULT_RIGHT_RAIL = { default: 272, min: 250, max: 400 };

/** Note-split pane floors (px) — mirrored in vault.css
 *  (.vault-editor-pane / .vault-preview-pane min-width). The dividers clamp
 *  live against them so a drag stops at the floor instead of entering the
 *  container's clip zone. */
export const VAULT_EDITOR_MIN_PX = 220;
export const VAULT_PREVIEW_MIN_PX = 260;
/** Asset pane floor (vault.css .vault-asset-pane / :has(.pdf-viewer)). */
export const VAULT_ASSET_MIN_PX = 200;
export const VAULT_PDF_MIN_PX = 380;

interface VaultLayout {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  assetSplitPct: number;
  openNotes: string[];
  openAssets: string[];
  pinnedPaths: string[];
}

const LAYOUT_KEY = "relay.vault.layout";

/** Validate a persisted path list: strings only, non-empty, optionally
 *  capped (a tampered/hand-edited layout blob must not feed non-strings
 *  into the tabs/pins rails). */
function validPathList(v: unknown, cap?: number): string[] {
  if (!Array.isArray(v)) return [];
  const out = v.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return cap == null ? out : out.slice(0, cap);
}

function clampPct(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(80, Math.max(20, n));
}

/** Survives restarts; guarded because tests (and odd embeds) may lack storage. */
function loadLayout() {
  const fallback = { leftRailWidth: VAULT_LEFT_RAIL.default, rightRailWidth: VAULT_RIGHT_RAIL.default, leftRailCollapsed: false, assetSplitPct: 58, openNotes: [] as string[], openAssets: [] as string[], pinnedPaths: [] as string[] };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<VaultLayout>;
    return {
      leftRailWidth: clampWidth(p.leftWidth, VAULT_LEFT_RAIL),
      rightRailWidth: clampWidth(p.rightWidth, VAULT_RIGHT_RAIL),
      leftRailCollapsed: p.leftCollapsed === true,
      assetSplitPct: clampPct(p.assetSplitPct, 58),
      openNotes: validPathList(p.openNotes),
      openAssets: validPathList(p.openAssets),
      pinnedPaths: validPathList(p.pinnedPaths),
    };
  } catch {
    return fallback;
  }
}

function clampWidth(v: unknown, b: { min: number; max: number; default: number }): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : b.default;
  return Math.min(b.max, Math.max(b.min, n));
}

/** Height of the note head (path row + mode switch) above the note panes —
 *  part of the note side's minimum in the asset|note split. Measured ~37px;
 *  rounded up for zoom/font variation. */
const VAULT_NOTE_HEAD_PX = 40;
/** Width of a resize divider between panes. */
const VAULT_HANDLE_PX = 6;

/** Clamp the asset|note split percentage (asset share) against the persisted
 *  20–80 bounds AND the live px floors: the note side keeps its head + the
 *  live pane floor (the wider of editor/reading) + its divider; the asset
 *  side its own (380 for a pdf, 200 otherwise — mirrors the old CSS floors
 *  that the divider drag must respect before the asset yields). */
export function clampAssetSplitPct(pct: number, centerWidthPx: number, assetMinPx: number): number {
  const v = clampPct(pct, 58);
  const noteMinPx = VAULT_NOTE_HEAD_PX + Math.max(VAULT_EDITOR_MIN_PX, VAULT_PREVIEW_MIN_PX) + VAULT_HANDLE_PX;
  if (centerWidthPx > assetMinPx + noteMinPx + 12) {
    const lo = (assetMinPx / centerWidthPx) * 100;
    const hi = 100 - (noteMinPx / centerWidthPx) * 100;
    return Math.min(hi, Math.max(lo, v));
  }
  return v;
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
   *  can sit side by side — take notes while reading a pdf. This is the
   *  ACTIVE asset of the asset pane's own tab strip; the full list is
   *  `openAssets`. */
  assetPath: string | null;
  /** Open non-note assets, in tab order (mirrors `openNotes` for the note
   *  pane). `assetPath` is the active one. Persisted via the layout blob. */
  openAssets: string[];
  /** Asset|note split (percent to the asset) — user-resizable, persisted. */
  assetSplitPct: number;
  content: string;
  savedContent: string;
  mode: VaultMode;
  /** Last-chosen mode per note path — notes the user never toggled open as
   *  "preview" (the default). In-memory only: a fresh session previews. */
  noteModes: Record<string, VaultMode>;
  rail: VaultRail;
  /** Left/right rail widths (px) and the collapsed left rail — persisted. */
  leftRailWidth: number;
  rightRailWidth: number;
  leftRailCollapsed: boolean;
  rightRailOpen: boolean;
  /** Open note tabs, in strip order (persisted). activePath is always in
   *  here while a note is open. */
  openNotes: string[];
  /** Pinned notes — float to the top of the files rail and the switcher. */
  pinnedPaths: string[];
  /** "Insert template" picker modal. */
  templatePickerOpen: boolean;
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
  /** Switch the asset pane to another open asset (tab click). */
  setActiveAsset: (path: string) => void;
  /** Close one asset tab; when it is the active one the neighbor activates. */
  closeAssetTab: (path: string) => void;
  /** Drag-reorder the asset tab strip. */
  reorderAssetTab: (path: string, toIndex: number) => void;
  setContent: (text: string) => void;
  scheduleSave: () => void;
  saveNow: () => Promise<void>;
  closeNote: () => void;
  setMode: (mode: VaultMode) => void;
  setRail: (rail: VaultRail) => void;
  /** Width/split setters accept an updater form so drag handlers never apply
   *  two moves against the same stale base (React batches pointermove). */
  setLeftRailWidth: (w: number | ((cur: number) => number)) => void;
  setRightRailWidth: (w: number | ((cur: number) => number)) => void;
  setAssetSplitPct: (p: number | ((cur: number) => number)) => void;
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
  /** Close one tab; when it is the active note the neighbor activates. */
  closeNoteTab: (path: string) => void;
  /** Move an open-note tab to a new strip index (drag-to-reorder). */
  reorderNoteTab: (path: string, toIndex: number) => void;
  /** Toggle a note's pin (star). */
  pinNote: (path: string) => void;
  /** Open (creating from Templates/Daily.md if missing) today's daily note. */
  openDailyNote: () => Promise<void>;
  setTemplatePickerOpen: (open: boolean) => void;
  /** Restore a previously-recorded vault state (Back/Forward navigation).
   *  Reloads the snapshot note's content without recording a new step. */
  restoreSnapshot: (snap: {
    graphOpen: boolean;
    assetPath: string | null;
    openAssets: string[];
    activePath: string | null;
  }) => Promise<void>;
  /** Watcher event: paths were reindexed on disk. */
  onVaultChanged: (paths: string[]) => void;
  /** Full-rescan finished. */
  onScanned: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** The note the armed `saveTimer` belongs to. A timer must never write the
 *  buffer into whatever note is active when it finally fires — the editor
 *  keeps typing while a note switch flush/read is in flight, so a timer armed
 *  for note A can come due after `activePath` already moved to B (audit C6). */
let saveTimerPath: string | null = null;
/** The `vaultWriteNote` calls currently on the wire. A write already handed to
 *  IPC cannot be recalled by bumping `saveGeneration` (that only invalidates
 *  ARMED timers), so `deleteNote` drains this set before issuing the delete —
 *  otherwise an in-flight write lands after `vaultDeleteNote` and recreates the
 *  file with the edits the user just deleted. A SET, not a single slot: the
 *  debounce timer and a navigation flush can have two saves in flight at once,
 *  and awaiting only the newest would still let the older one resurrect the
 *  file. */
const inFlightNoteWrites = new Set<Promise<void>>();
/** Pending per-keystroke search (set by setSearchQuery). */
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

/** Clear an armed save timer without saving. */
function clearSaveTimer() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveTimerPath = null;
}

/** Flush the CURRENT note's pending edits before its buffer is replaced.
 *
 *  A dirty check, not a timer check: keystrokes typed while the previous
 *  flush/read was in flight were never covered by the old `if (saveTimer)`
 *  gate (audit H35), and a save that FAILED leaves no timer armed, so edits
 *  that never reached disk were silently abandoned. `saveNow` pairs the
 *  still-old `activePath` with the latest `content`, so stragglers land on
 *  the correct file. */
async function flushPendingSave(get: () => VaultStore): Promise<void> {
  clearSaveTimer();
  const { activePath, content, savedContent } = get();
  if (activePath && content !== savedContent) {
    await get().saveNow();
  }
}

/** Record the current note/asset/graph trio in the shell's back/forward
 *  timeline (ui store) — vault navigation joins view history, so the
 *  title-bar arrows step through notes/pdfs/graph states. */
function recordVaultNav(s: {
  graphOpen: boolean;
  assetPath: string | null;
  openAssets: string[];
  activePath: string | null;
}) {
  useUiStore.getState().recordVaultNav({
    graphOpen: s.graphOpen,
    assetPath: s.assetPath,
    openAssets: s.openAssets,
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

/** A vault path that names an asset rather than a note: it ends in a short
 *  alphanumeric extension that is NOT `.md`. Used by openNote to hand such
 *  targets to the asset pane instead of resolving/creating a note.
 *
 *  This is deliberately extension-SHAPED rather than an allowlist of known
 *  asset types: a vault can hold anything, and a type missing from an
 *  allowlist would fall through to the create branch and write `<name>.<x>.md`
 *  next to the original — the exact failure this guards. The cost is that a
 *  note stem containing a dot (`Notes.v2`) routes to the asset pane rather
 *  than auto-creating; that costs the user a click, while the other case
 *  pollutes their vault with junk files. Extension length is capped so a
 *  dotted FOLDER (`Archive.v2/Foo`, no trailing extension) is unaffected. */
const ASSET_PATH_RE = /\.(?!md$)[a-z0-9]{1,8}$/i;

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
  let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;
  const persistLayout = () => {
    // Drag handlers call this on every pointermove — debounce so a drag
    // writes storage once at the end instead of on every tick.
    if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
    layoutPersistTimer = setTimeout(() => {
      layoutPersistTimer = null;
      const s = get();
      saveLayout({
        leftWidth: s.leftRailWidth,
        rightWidth: s.rightRailWidth,
        leftCollapsed: s.leftRailCollapsed,
        assetSplitPct: s.assetSplitPct,
        openNotes: s.openNotes,
        openAssets: s.openAssets,
        pinnedPaths: s.pinnedPaths,
      });
    }, 250);
  };
  /** Resolve a setter argument (value or updater) against current state. */
  const resolve = <T,>(v: T | ((cur: T) => T), cur: T): T =>
    typeof v === "function" ? (v as (c: T) => T)(cur) : v;
  return ({
  root: null,
  stats: null,
  tree: [],
  activePath: null,
  assetPath: null,
  content: "",
  savedContent: "",
  mode: "preview",
  noteModes: {},
  rail: "files",
  templatePickerOpen: false,
  ...loadLayout(), // validated, includes openNotes/openAssets/pinnedPaths
  // Collapsed by default: on a fresh note every section reads "No links yet",
  // so the rail is a column of empty chrome crowding out the note. The toggle
  // is session-only (not in the layout blob) — opening it sticks for the run.
  rightRailOpen: false,
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
    // Tabs/pins/recents/modes are vault-scoped too: left as-is they would
    // resolve the previous vault's paths against the new one.
    set({ root, activePath: null, assetPath: null, content: "", savedContent: "", meta: null, graph: null, tags: [], openNotes: [], openAssets: [], pinnedPaths: [], noteModes: {} });
    // The editor caches whole-note reads for `#subpath` completion keyed by
    // path — drop them so the new vault never resolves the old vault's
    // text. Dynamic import: the editor chunk (CodeMirror) stays lazy.
    void import("../components/vault/VaultEditor")
      .then((m) => m.clearNoteContentCache())
      .catch(() => {});
    persistLayout();
    await get().loadTree();
    await get().refreshStats();
  },

  unbind: async () => {
    await vaultUnbind();
    // Tabs are vault-scoped paths in BOTH panes — leave either strip intact
    // and a re-bind would briefly render the previous vault's paths.
    set({ root: null, stats: null, tree: [], activePath: null, assetPath: null, openNotes: [], openAssets: [], content: "", savedContent: "", meta: null, graph: null, tags: [] });
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
    // A path carrying a non-markdown extension is an ASSET, never a note to
    // create. This diverts BEFORE resolution, which matters twice over:
    //   1. resolveNotePath matches by stem, so a stray `paper.pdf.md` already
    //      in the index would answer a `paper.pdf` request and open the junk
    //      note instead of the real PDF;
    //   2. if nothing resolved, the create branch below used to run and
    //      write `paper.pdf.md` into the user's vault — one junk file per
    //      click, for a file that was sitting right there in the tree.
    // Extensionless targets are unaffected, so `[[New Idea]]` and
    // `[[Folder/Note]]` still create Obsidian-style.
    const target = path.trim().replace(/^\.\//, "");
    if (ASSET_PATH_RE.test(target)) {
      set({ loadingNote: false });
      get().openFile(target);
      return;
    }
    // Unsaved work first: flush whatever is pending so nothing is lost.
    // Dirty-check based — keystrokes that landed while this await runs are
    // covered because saveNow pairs the OLD activePath with the latest
    // content (audit C6/H35).
    //
    // The generation is claimed BEFORE the flush (same order as
    // restoreSnapshot): claiming it after the await let two in-flight opens
    // resolve out of order — the LAST click to claim won, so the earlier one
    // overwrote it — and let a pending open resurrect a tab that
    // closeNoteTab had already closed (that path bumps synchronously, so a
    // later claim always beat a claim made after an await).
    const gen = ++openGeneration;
    await flushPendingSave(get);
    set({ loadingNote: true });
    const resolved = await resolveNotePath(path);
    if (gen !== openGeneration) return; // a newer open superseded this one
    if (!resolved) {
      // Unresolved link → CREATE the note, Obsidian-style. Nested targets
      // ("Folder/Note") create their parent folders backend-side; the note
      // opens immediately in the editor. This is what makes
      // `[[new idea]]` + click a flow.
      set({ loadingNote: false });
      await get().createNote(path);
      return;
    }
    // Opening anything closes the graph overlay — otherwise the note opens
    // "behind" the graph and nothing visibly changes.
    const s0 = get();
    set({
      activePath: resolved,
      graphOpen: false,
      // Notes open in preview by default; a note the user last toggled to
      // edit keeps that choice (per-note, session-scoped).
      mode: s0.noteModes[resolved] ?? "preview",
      // Tab strip: an opened note gets a tab (appended, no dupes),
      // persisted via the layout blob.
      openNotes: s0.openNotes.includes(resolved) ? s0.openNotes : [...s0.openNotes, resolved],
    });
    persistLayout();
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

  /** Show a non-note asset (pdf/image/…) in its own pane. The open NOTE
   *  stays put — the two sit side by side so you can take notes while
   *  reading. Touches none of the editor state: an asset must never leave
   *  text in the buffer for the next note's autosave to write. Closes the
   *  graph overlay.
   *
   *  Assets keep their own tab strip (`openAssets`), mirroring the note
   *  pane's `openNotes`: re-opening an already-open asset just focuses its
   *  tab instead of resetting it, so a second PDF no longer throws the first
   *  one away. `assetPath` is the ACTIVE tab. */
  openFile: (path) => {
    if (!path.trim()) return;
    const s = get();
    set({
      assetPath: path,
      graphOpen: false,
      openAssets: s.openAssets.includes(path) ? s.openAssets : [...s.openAssets, path],
    });
    persistLayout();
    recordVaultNav(get());
  },

  setActiveAsset: (path) => {
    if (!get().openAssets.includes(path)) return;
    set({ assetPath: path });
    recordVaultNav(get());
  },

  closeAsset: () => {
    const s = get();
    if (s.assetPath) get().closeAssetTab(s.assetPath);
  },

  closeAssetTab: (path) => {
    const s = get();
    const idx = s.openAssets.indexOf(path);
    const next = s.openAssets.filter((p) => p !== path);
    if (path !== s.assetPath) {
      set({ openAssets: next });
      persistLayout();
      return;
    }
    // Active tab closing: activate the neighbor (previous tab preferred,
    // like editors do). No tabs left → clear the asset pane.
    const neighbor = next[Math.max(0, idx - 1)] ?? null;
    set({ openAssets: next, assetPath: neighbor });
    persistLayout();
    recordVaultNav(get());
  },

  reorderAssetTab: (path, toIndex) => {
    const s = get();
    const from = s.openAssets.indexOf(path);
    if (from === -1) return;
    const next = [...s.openAssets];
    const [moved] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved);
    set({ openAssets: next });
    persistLayout();
  },

  setContent: (text) => set({ content: text }),

  scheduleSave: () => {
    const { content, savedContent, activePath } = get();
    if (!activePath || content === savedContent) return;
    if (saveTimer) clearTimeout(saveTimer);
    const gen = get().saveGeneration;
    const path = activePath;
    saveTimerPath = path;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveTimerPath = null;
      // A stale timer must not fire: either the buffer changed under it
      // (saveGeneration moved) or the NOTE it was armed for is no longer the
      // active one — writing now would land note A's text in note B's file
      // (audit C6).
      if (get().saveGeneration !== gen || get().activePath !== path) return;
      void get().saveNow();
    }, VAULT_SAVE_DEBOUNCE_MS);
  },

  saveNow: async () => {
    const { activePath, content, savedContent } = get();
    if (!activePath || content === savedContent) return;
    const gen = get().saveGeneration + 1;
    set({ saveGeneration: gen });
    const write = vaultWriteNote(activePath, content).then(() => {});
    // Publish the in-flight write so deleteNote can drain it before deleting.
    inFlightNoteWrites.add(write);
    try {
      await write;
      // Both post-write writes are SCOPED: the buffer can be replaced while
      // the IPC is in flight, and the stale `savedContent` then marks a note
      // the user never edited as dirty.
      //  · saveGeneration moved → a delete superseded this save (deleteNote
      //    bumps it), so the buffer it would stamp is already gone.
      //  · activePath moved → the buffer now holds a DIFFERENT note (tab
      //    close / navigation). The bytes did land on the right file, but
      //    stamping them here left the freshly-opened neighbour spuriously
      //    dirty (or, with no neighbour left, `content: ""` against a
      //    non-empty savedContent with no activePath to reconcile them).
      if (get().saveGeneration === gen && get().activePath === activePath) {
        set({ savedContent: content });
      }
      // The editor caches whole-note reads for `#subpath` completion keyed
      // by path — the just-saved text may have different headings/blocks, so
      // drop the stale entry (same dynamic-import bridge as bind()).
      void import("../components/vault/VaultEditor")
        .then((m) => m.invalidateNoteContent(activePath))
        .catch(() => {});
      void get().refreshStats();
    } catch (e) {
      useUiStore.getState().pushToast("error", "Vault save failed", String(e));
    } finally {
      inFlightNoteWrites.delete(write);
    }
  },

  closeNote: () => {
    const s = get();
    if (!s.activePath) return;
    get().closeNoteTab(s.activePath);
  },

  closeNoteTab: (path) => {
    const s = get();
    const idx = s.openNotes.indexOf(path);
    const next = s.openNotes.filter((p) => p !== path);
    if (path !== s.activePath) {
      set({ openNotes: next });
      persistLayout();
      return;
    }
    // Active tab closing: flush pending edits for it first, then activate
    // the neighbor (previous tab preferred, like editors do). No tabs left
    // → fully clear the note surface. Dirty-check flush (audit C6/H35).
    //
    // Deliberately NOT awaited: the switch below must not wait on the write
    // round-trip (tab closing stays instant). The flush is still correct —
    // `saveNow` snapshots the OLD activePath with the latest content
    // synchronously, and its completion is scoped in saveNow (it re-asserts
    // `savedContent` only while the buffer still holds the note it wrote).
    // Without that scope the completion landed AFTER the neighbor's
    // `vaultReadNote(...).then(...)` and stamped the closed note's bytes onto
    // the freshly-opened note's `savedContent`, marking it dirty for nothing;
    // with no neighbor left it left `content: ""` against a non-empty
    // `savedContent` and no `activePath` to reconcile them.
    void flushPendingSave(get);
    const neighbor = next[Math.max(0, idx - 1)] ?? null;
    set({ openNotes: next, activePath: neighbor, mode: s.noteModes[neighbor] ?? "preview" });
    if (!neighbor) {
      set({ content: "", savedContent: "", meta: null });
    } else {
      // Load the neighbor without pushing another history step.
      const gen = ++openGeneration;
      set({ loadingNote: true });
      void vaultReadNote(neighbor)
        .then((content) => {
          if (gen !== openGeneration) return;
          set({ content: content ?? "", savedContent: content ?? "", loadingNote: false });
          return vaultNoteMeta(neighbor).then((m) => {
            if (gen === openGeneration) set({ meta: m });
          });
        })
        .catch(() => {
          if (gen === openGeneration) set({ loadingNote: false });
        });
    }
    persistLayout();
    recordVaultNav(get());
  },

  reorderNoteTab: (path, toIndex) => {
    const s = get();
    const from = s.openNotes.indexOf(path);
    if (from === -1) return;
    const next = [...s.openNotes];
    const [moved] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved);
    set({ openNotes: next });
    persistLayout();
  },

  pinNote: (path) => {
    const s = get();
    const pinned = s.pinnedPaths.includes(path)
      ? s.pinnedPaths.filter((p) => p !== path)
      : [path, ...s.pinnedPaths];
    set({ pinnedPaths: pinned });
    persistLayout();
  },

  openDailyNote: async () => {
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dailyPath = `Daily/${iso}.md`;
    const existing = await resolveNotePath(dailyPath);
    if (!existing) {
      // Seed from Templates/Daily.md when present; {{date}}/{{title}}/{{time}}
      // get the same substitution Obsidian's core templates apply.
      let template: string | null = null;
      const tplPath = await resolveNotePath("Templates/Daily").catch(() => null);
      if (tplPath) template = await vaultReadNote(tplPath).catch(() => null);
      const body = (template ?? "")
        .replace(/\{\{date\}\}/g, iso)
        .replace(/\{\{title\}\}/g, iso)
        .replace(/\{\{time\}\}/g, d.toTimeString().slice(0, 5));
      try {
        await vaultCreateNote(dailyPath, body);
      } catch {
        // Exists on disk but not indexed yet — opening below still works.
      }
      await get().loadTree();
    }
    await get().openNote(dailyPath);
  },

  setTemplatePickerOpen: (open) => set({ templatePickerOpen: open }),

  setMode: (mode) =>
    set((s) => ({
      mode,
      // Remember the choice for THIS note so re-opening it (tab hop, link
      // click, back/forward) lands in the mode the user last used.
      noteModes: s.activePath ? { ...s.noteModes, [s.activePath]: mode } : s.noteModes,
    })),
  setRail: (rail) => {
    set({ rail });
    if (rail === "tags") void get().loadTags();
    if (rail === "search") void get().runSearch();
  },
  setLeftRailWidth: (w) => {
    set((s) => ({ leftRailWidth: clampWidth(resolve(w, s.leftRailWidth), VAULT_LEFT_RAIL) }));
    persistLayout();
  },
  setRightRailWidth: (w) => {
    set((s) => ({ rightRailWidth: clampWidth(resolve(w, s.rightRailWidth), VAULT_RIGHT_RAIL) }));
    persistLayout();
  },
  setAssetSplitPct: (p) => {
    set((s) => ({ assetSplitPct: clampPct(resolve(p, s.assetSplitPct), s.assetSplitPct) }));
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
      // "Already exists" (the file is on disk but the index hasn't caught
      // up yet — e.g. a link clicked before the watcher reindexed it):
      // open it instead of toasting an error, exactly like openDailyNote
      // tolerates the same race. Any other failure still surfaces.
      if (!String(e).includes("already exists")) {
        vaultToast("error", "Could not create note", String(e));
        return;
      }
    }
    await get().loadTree();
    await get().refreshStats();
    await get().openNote(withExt);
    // A brand-new note goes straight into the editor (recorded per-note so
    // leaving and returning keeps it there).
    get().setMode("edit");
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
    // edits (two divergent copies, silently). Dirty-check flush (audit
    // C6/H35) so edits from a FAILED save are not abandoned here.
    await flushPendingSave(get);
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
    // A pending autosave must never flush to a deleted path — the write
    // would resurrect the file. BEFORE the backend delete: drop the
    // debounce timer, bump `saveGeneration` (so any timer/racing saveNow
    // armed for this note is already void) and clear the buffer (content ===
    // savedContent also makes a racing saveNow a no-op), so neither the close
    // below nor a stray timer can write to the doomed path again. Deleting
    // discards the buffer by definition.
    //
    // Clearing the buffer only helps for writes that have not STARTED. A
    // `vaultWriteNote` already handed to IPC is recalled by neither the
    // generation bump nor the buffer clear: if it landed after the delete,
    // the note came back on disk carrying exactly the edits just deleted —
    // and this commit's awaited flushes in openNote / closeNoteTab /
    // renameNote / restoreSnapshot widened that window. Await the in-flight
    // write so it always lands BEFORE the delete.
    if (get().activePath === path) {
      if (saveTimer) {
        clearSaveTimer();
      }
      set({ saveGeneration: get().saveGeneration + 1, content: "", savedContent: "" });
      // Drain every write already on the wire (not just the newest) so none can
      // land after the delete.
      if (inFlightNoteWrites.size > 0) {
        await Promise.allSettled([...inFlightNoteWrites]);
      }
    }
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
    // Debounce per-keystroke searches: one IPC per quiet window instead of
    // one per character.
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchDebounce = null;
      void get().runSearch();
    }, VAULT_SEARCH_DEBOUNCE_MS);
  },

  runSearch: async () => {
    const q = get().searchQuery.trim();
    if (!q) {
      set({ searchHits: [] });
      return;
    }
    set({ searchLoading: true });
    // `?? []`: a nullish response must never reach the panel as null — the
    // render would crash on hits.map (observed on the IPC stub; a backend
    // regression would crash it for real).
    const hits = (await vaultSearch(q, 40).catch(() => [])) ?? [];
    // The query changed while we were in flight — a stale response must
    // never land after (or replace) a newer query's results.
    if (get().searchQuery.trim() !== q) return;
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
    // Generation-guard the whole restore (same mechanism as openNote): a
    // slow restore over an await must never overwrite the buffer of a note
    // a NEWER navigation opened — the next autosave would write the old
    // text into the new file.
    const gen = ++openGeneration;
    // Flush pending edits first — a restore must not drop them (dirty
    // check, same reason as openNote; audit C6/H35).
    await flushPendingSave(get);
    if (gen !== openGeneration) return; // a newer open superseded this restore
    if (get().activePath !== snap.activePath) {
      if (!snap.activePath) {
        set({ activePath: null, content: "", savedContent: "", meta: null });
      } else {
        const s0 = get();
        set({
          activePath: snap.activePath,
          loadingNote: true,
          mode: s0.noteModes[snap.activePath] ?? "preview",
          openNotes: s0.openNotes.includes(snap.activePath!) ? s0.openNotes : [...s0.openNotes, snap.activePath!],
        });
        const content = await vaultReadNote(snap.activePath).catch(() => null);
        // The snapshot may have been superseded mid-load — only land the
        // text if the restore is still the latest navigation.
        if (gen !== openGeneration) return;
        set({ content: content ?? "", savedContent: content ?? "", loadingNote: false, meta: null });
        persistLayout();
        if (get().activePath === snap.activePath) {
          void vaultNoteMeta(snap.activePath)
            .then((m) => {
              if (gen === openGeneration) set({ meta: m });
            })
            .catch(() => {});
        }
      }
    }
    set({
      graphOpen: snap.graphOpen,
      assetPath: snap.assetPath,
      // Restore the strip too, but never lose tabs opened SINCE the snapshot:
      // going back should revisit, not discard. The active asset always gets
      // a tab, even from a pre-tabs snapshot that recorded only assetPath.
      openAssets: [
        ...new Set([
          ...(snap.openAssets ?? []),
          ...(snap.assetPath ? [snap.assetPath] : []),
          ...get().openAssets,
        ]),
      ],
    });
    if (snap.graphOpen && !get().graph) void get().loadGraph();
  },
  });
});
