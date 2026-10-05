// Vault view — the knowledge-base surface (sidebar entry below Automations).
// Layout: left rail (Files / Search / Tags) · editor + preview center ·
// right rail (outline / backlinks / outgoing). The graph and the quick
// switcher overlay the center. When no vault is bound, a binder card offers
// folder pick (the same folder dialog the Knowledge panel uses).
//
// The editor/preview chunks (CodeMirror + the markdown pipeline) are loaded
// lazily so the entry bundle only pays for them when the vault is opened.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bold,
  Code,
  FilePlus2,
  FolderPlus,
  Network,
  Hash,
  Heading1,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Minus,
  Quote,
  RefreshCw,
  Search,
  Strikethrough,
  FolderInput,
  Eye,
  PencilLine,
  Redo2,
  SquareCode,
  Square,
  Star,
  Volume2,
  Headphones,
  Mic,
  ListTodo,
  Table,
  Undo2,
  FileText,
  X,
} from "lucide-react";
import { PanelIcon } from "../common/PanelIcon";
import { ToolbarHeader } from "../common/ToolbarHeader";
import { VaultIcon } from "../../lib/icons";
import { open as pickFolder, open as pickFile } from "@tauri-apps/plugin-dialog";
import type { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import {
  listenVaultChanged,
  listenVaultScanned,
  toastError,
  vaultReadNote,
  type VaultTreeNode,
} from "../../lib/ipc";
import { splitFrontmatter } from "../../lib/vaultFrontmatter";
import {
  useVaultStore,
  clampAssetSplitPct,
  VAULT_ASSET_MIN_PX,
  VAULT_PDF_MIN_PX,
  type VaultMode,
  type VaultRail,
  VAULT_LEFT_RAIL,
  VAULT_RIGHT_RAIL,
} from "../../state/vault";
import { useUiStore } from "../../state/ui";
import { VaultFileTree } from "./VaultFileTree";
import { VaultTabStrip } from "./VaultTabStrip";
import { VaultLinkHoverHost } from "./VaultLinkHover";
import { VaultNoteRail, VaultSearchPanel, VaultTagsPanel, VaultQuickSwitcher } from "./VaultQuickSwitcher";
import { VaultPreview } from "./VaultPreview";
import { VaultAssetView } from "./VaultAssetView";
import { stemOf } from "../../lib/vaultLinks";
import { useVaultReadAloud, useVaultDictation, VAULT_TOGGLE_DICTATION } from "./vaultVoice";

const VaultEditor = lazy(() => import("./VaultEditor").then((m) => ({ default: m.VaultEditor })));

// ---- editing toolbar actions (dispatch through the live CodeMirror view) --

type EditAction =
  | { type: "wrap"; before: string; after: string }
  | { type: "linePrefix"; prefix: string }
  | { type: "insert"; text: string };

function applyEdit(view: EditorView, action: EditAction) {
  if (action.type === "wrap") {
    const { from, to } = view.state.selection.main;
    const text = from === to ? "" : view.state.doc.sliceString(from, to);
    view.dispatch({
      changes: { from, to, insert: `${action.before}${text}${action.after}` },
      selection: { anchor: from + action.before.length, head: from + action.before.length + text.length },
    });
  } else if (action.type === "linePrefix") {
    const { from, to } = view.state.selection.main;
    const first = view.state.doc.lineAt(from).number;
    const last = view.state.doc.lineAt(to).number;
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let ln = first; ln <= last; ln += 1) {
      const line = view.state.doc.line(ln);
      if (!line.text.startsWith(action.prefix)) {
        changes.push({ from: line.from, to: line.from, insert: action.prefix });
      }
    }
    if (changes.length) view.dispatch({ changes });
  } else {
    const pos = view.state.selection.main.head;
    view.dispatch({ changes: { from: pos, insert: action.text }, selection: { anchor: pos + action.text.length } });
  }
  view.focus();
}

function EditorToolbar({
  onAction,
  onInsertImage,
  onView,
}: {
  onAction: (a: EditAction) => void;
  onInsertImage: () => void;
  /** Direct view access for history commands (undo/redo). */
  onView: (fn: (view: EditorView) => void) => void;
}) {
  const wrapBtn = (icon: ReactNode, title: string, before: string, after = before, key?: string) => (
    <button key={key ?? title} title={title} onClick={() => onAction({ type: "wrap", before, after })}>
      {icon}
    </button>
  );
  return (
    <div className="vault-editor-toolbar" role="toolbar" aria-label="Formatting">
      <button title="Undo (Ctrl+Z)" onClick={() => onView((v) => void undo(v))}>
        <Undo2 size={13} />
      </button>
      <button title="Redo (Ctrl+Shift+Z)" onClick={() => onView((v) => void redo(v))}>
        <Redo2 size={13} />
      </button>
      <span className="vault-editor-toolbar-sep" />
      <button title="Heading 1" onClick={() => onAction({ type: "linePrefix", prefix: "# " })}>
        <Heading1 size={13} />
      </button>
      <button title="Heading 2" onClick={() => onAction({ type: "linePrefix", prefix: "## " })}>
        <span className="vault-toolbar-h2">H2</span>
      </button>
      <button title="Heading 3" onClick={() => onAction({ type: "linePrefix", prefix: "### " })}>
        <span className="vault-toolbar-h3">H3</span>
      </button>
      <span className="vault-editor-toolbar-sep" />
      {wrapBtn(<Bold size={13} />, "Bold (**…**)", "**")}
      {wrapBtn(<Italic size={13} />, "Italic (*…*)", "*")}
      {wrapBtn(<Strikethrough size={13} />, "Strikethrough (~~…~~)", "~~")}
      {wrapBtn(<Highlighter size={13} />, "Highlight (==…==)", "==")}
      {wrapBtn(<Code size={13} />, "Inline code", "`")}
      <button
        title="Code block"
        onClick={() =>
          onAction({ type: "insert", text: "```\n\n```" })
        }
      >
        <SquareCode size={13} />
      </button>
      <span className="vault-editor-toolbar-sep" />
      <button title="Quote" onClick={() => onAction({ type: "linePrefix", prefix: "> " })}>
        <Quote size={13} />
      </button>
      <button title="Bullet list" onClick={() => onAction({ type: "linePrefix", prefix: "- " })}>
        <List size={13} />
      </button>
      <button title="Numbered list" onClick={() => onAction({ type: "linePrefix", prefix: "1. " })}>
        <ListOrdered size={13} />
      </button>
      <button title="Task (- [ ])" onClick={() => onAction({ type: "linePrefix", prefix: "- [ ] " })}>
        <ListTodo size={13} />
      </button>
      <span className="vault-editor-toolbar-sep" />
      <button
        title="Table (3 × 3)"
        onClick={() =>
          onAction({
            type: "insert",
            text: "| Column A | Column B | Column C |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |",
          })
        }
      >
        <Table size={13} />
      </button>
      <button title="Divider (---)" onClick={() => onAction({ type: "insert", text: "\n---\n" })}>
        <Minus size={13} />
      </button>
      <span className="vault-editor-toolbar-sep" />
      {wrapBtn(<Link2 size={13} />, "Wikilink ([[…]])", "[[", "]]", "wikilink")}
      <button title="Insert image (copied into the vault's assets/)" onClick={onInsertImage}>
        <ImagePlus size={13} />
      </button>
    </div>
  );
}

/** A col-resize divider. Pointer capture keeps the drag alive even when the
 *  cursor crosses the PDF iframe (which would otherwise swallow moves). */
function ResizeHandle({
  onDrag,
  onDragState,
}: {
  /** dx since the last move event (positive = cursor moved right). */
  onDrag: (dx: number) => void;
  onDragState: (dragging: boolean) => void;
}) {
  const start = useRef(0);
  const dragging = useRef(false);
  return (
    <div
      className="vault-resize-handle"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault();
        start.current = e.clientX;
        dragging.current = true;
        onDragState(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        onDrag(e.clientX - start.current);
        start.current = e.clientX;
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        onDragState(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        onDragState(false);
      }}
    />
  );
}

function Binder() {
  const bind = useVaultStore((s) => s.bind);
  const [busy, setBusy] = useState(false);
  const onPick = async () => {
    setBusy(true);
    try {
      const picked = await pickFolder({
        directory: true,
        multiple: false,
        title: "Choose a folder of markdown notes to use as your vault",
      });
      if (typeof picked === "string" && picked) {
        await bind(picked);
      }
    } catch (e) {
      toastError("Could not bind vault folder", String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="vault-binder">
      <div className="vault-binder-card">
        <FolderInput size={28} strokeWidth={1.5} />
        <h3>Bind a vault</h3>
        <p>
          A vault is any folder of markdown notes — plain <code>.md</code> files on disk, readable by
          Obsidian and every other markdown tool. Relay indexes it for links, backlinks, search and
          the graph, and your agents can read and write it with their vault tools.
        </p>
        <button className="primary" onClick={() => void onPick()} disabled={busy}>
          {busy ? <Loader2 className="spin" size={14} /> : <FolderInput size={14} />}
          {busy ? "Binding…" : "Choose folder…"}
        </button>
      </div>
    </div>
  );
}

function ModeSwitch() {
  const mode = useVaultStore((s) => s.mode);
  const setMode = useVaultStore((s) => s.setMode);
  const modes: { key: VaultMode; icon: typeof Eye; label: string }[] = [
    { key: "edit", icon: PencilLine, label: "Edit mode (Ctrl+E)" },
    { key: "preview", icon: Eye, label: "Preview mode (Ctrl+E)" },
  ];
  return (
    <div className="vault-mode-switch" role="tablist">
      {modes.map((m) => (
        <button
          key={m.key}
          role="tab"
          aria-selected={mode === m.key}
          className={mode === m.key ? "active" : ""}
          onClick={() => setMode(m.key)}
          title={m.label}
        >
          <m.icon size={13} />
        </button>
      ))}
    </div>
  );
}

/** Pinned shortcuts above the files tree — re-open a note without hunting
 *  through the tree. Rows reuse the outline-row scale; pinned rows carry a
 *  small unpin (✕). The list lives in the store (persisted). */
function VaultPinned() {
  const pinnedPaths = useVaultStore((s) => s.pinnedPaths);
  const openNote = useVaultStore((s) => s.openNote);
  const pinNote = useVaultStore((s) => s.pinNote);
  if (pinnedPaths.length === 0) return null;
  return (
    <div className="vault-rail-pinned">
      <div className="vault-rail-pin-section">
        <div className="vault-rail-pin-label">Pinned</div>
        {pinnedPaths.map((p) => (
          <div key={p} className="vault-rail-pin-row">
            <button className="vault-rail-pin-open" title={p} onClick={() => void openNote(p)}>
              {stemOf(p)}
            </button>
            <button className="vault-rail-pin-unpin" title="Unpin note" onClick={() => pinNote(p)}>
              <X size={10} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The "insert template" modal: every *.md note under Templates/ becomes a
 *  one-click insert at the editor cursor (via the vault:insert-text event).
 *  Reading goes through the normal vault IPC; frontmatter is stripped so a
 *  template's properties never land in the note body. Esc / backdrop close. */
function VaultTemplatePicker() {
  const open = useVaultStore((s) => s.templatePickerOpen);
  const setOpen = useVaultStore((s) => s.setTemplatePickerOpen);
  const tree = useVaultStore((s) => s.tree);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // Flatten the tree the same way the quick switcher does, keeping only
  // markdown notes under a Templates/ folder (case-insensitive).
  const templates = useMemo(() => {
    if (!open) return [];
    const out: { path: string; name: string }[] = [];
    const walk = (nodes: VaultTreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === "folder") walk(n.children);
        else if (n.kind === "note" && n.path.toLowerCase().startsWith("templates/") && /\.md$/i.test(n.path)) {
          out.push({ path: n.path, name: stemOf(n.path) });
        }
      }
    };
    walk(tree);
    return out;
  }, [open, tree]);

  if (!open) return null;

  const pick = async (path: string) => {
    try {
      const content = await vaultReadNote(path);
      const body = splitFrontmatter(content).body.replace(/^\n+/, "");
      window.dispatchEvent(new CustomEvent("vault:insert-text", { detail: body }));
    } catch (e) {
      toastError("Could not read template", e);
    }
    setOpen(false);
  };

  return (
    <div className="vault-template-picker-overlay" onClick={() => setOpen(false)}>
      <div className="vault-template-picker" onClick={(e) => e.stopPropagation()}>
        <div className="vault-template-picker-head">Insert template</div>
        {templates.length === 0 ? (
          <div className="vault-template-picker-empty">Put templates in a Templates/ folder</div>
        ) : (
          templates.map((t) => (
            <button key={t.path} className="vault-template-picker-row" title={t.path} onClick={() => void pick(t.path)}>
              <FileText size={13} />
              <span className="vault-template-picker-name">{t.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function VaultView() {
  const root = useVaultStore((s) => s.root);
  const stats = useVaultStore((s) => s.stats);
  const tree = useVaultStore((s) => s.tree);
  const bind = useVaultStore((s) => s.bind);
  const rail = useVaultStore((s) => s.rail);
  const setRail = useVaultStore((s) => s.setRail);
  const leftRailWidth = useVaultStore((s) => s.leftRailWidth);
  const rightRailWidth = useVaultStore((s) => s.rightRailWidth);
  const leftRailCollapsed = useVaultStore((s) => s.leftRailCollapsed);
  const setLeftRailWidth = useVaultStore((s) => s.setLeftRailWidth);
  const setRightRailWidth = useVaultStore((s) => s.setRightRailWidth);
  const toggleLeftRail = useVaultStore((s) => s.toggleLeftRail);
  const rightRailOpen = useVaultStore((s) => s.rightRailOpen);
  const toggleRightRail = useVaultStore((s) => s.toggleRightRail);
  const activePath = useVaultStore((s) => s.activePath);
  const assetPath = useVaultStore((s) => s.assetPath);
  const openAssets = useVaultStore((s) => s.openAssets);
  const closeAssetTab = useVaultStore((s) => s.closeAssetTab);
  const reorderAssetTab = useVaultStore((s) => s.reorderAssetTab);
  const assetSplitPct = useVaultStore((s) => s.assetSplitPct);
  const setAssetSplitPct = useVaultStore((s) => s.setAssetSplitPct);
  const content = useVaultStore((s) => s.content);
  const savedContent = useVaultStore((s) => s.savedContent);
  const loadingNote = useVaultStore((s) => s.loadingNote);
  const mode = useVaultStore((s) => s.mode);
  const setContent = useVaultStore((s) => s.setContent);
  const scheduleSave = useVaultStore((s) => s.scheduleSave);
  // Preview checkboxes toggle the task in the note source (1-based line
  // reported by the markdown renderer) and save like any edit.
  const onToggleTaskLine = useCallback(
    (line: number) => {
      const lines = content.split("\n");
      const target = lines[line - 1];
      if (target == null || !/^[\s>\-\d*+]*\[([ xX])\]/.test(target)) return;
      lines[line - 1] = target.replace(/\[([ xX])\]/, (_full, ch: string) => `[${ch === " " ? "x" : " "}]`);
      setContent(lines.join("\n"));
      scheduleSave();
    },
    [content, setContent, scheduleSave],
  );
  const saveNow = useVaultStore((s) => s.saveNow);
  const openNote = useVaultStore((s) => s.openNote);
  const openFile = useVaultStore((s) => s.openFile);
  const closeNote = useVaultStore((s) => s.closeNote);
  const closeNoteTab = useVaultStore((s) => s.closeNoteTab);
  const openNotes = useVaultStore((s) => s.openNotes);
  const pinnedPaths = useVaultStore((s) => s.pinnedPaths);
  const pinNote = useVaultStore((s) => s.pinNote);
  const templatePickerOpen = useVaultStore((s) => s.templatePickerOpen);
  const setTemplatePickerOpen = useVaultStore((s) => s.setTemplatePickerOpen);
  const createNote = useVaultStore((s) => s.createNote);
  const createFolder = useVaultStore((s) => s.createFolder);
  const reorderNoteTab = useVaultStore((s) => s.reorderNoteTab);
  const rescan = useVaultStore((s) => s.rescan);
  const graphOpen = useVaultStore((s) => s.graphOpen);
  const setGraphOpen = useVaultStore((s) => s.setGraphOpen);
  const graph = useVaultStore((s) => s.graph);
  const setSwitcherOpen = useVaultStore((s) => s.setSwitcherOpen);
  const onVaultChanged = useVaultStore((s) => s.onVaultChanged);
  const onScanned = useVaultStore((s) => s.onScanned);
  const init = useVaultStore((s) => s.init);
  const dirty = content !== savedContent && activePath != null;
  const isPinned = activePath != null && pinnedPaths.includes(activePath);
  const initialized = useRef(false);
  const [resizing, setResizing] = useState(false);

  // One-time init + event wiring.
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void init();
    const unlistens = [
      listenVaultChanged((p) => onVaultChanged(p.paths)).catch(() => {}),
      listenVaultScanned(() => onScanned()).catch(() => {}),
    ];
    return () => {
      void Promise.all(unlistens.map((u) => u.then((fn) => fn?.()).catch(() => {})));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl/Cmd+P quick switcher and Mod+S save are owned by the global
  // keybinding registry (vaultQuickSwitcher / vaultSaveNote — the save is
  // editable-exempt so it fires while typing in the editor).

  // Warn before closing with unsaved edits (autosave makes this rare).
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const completionItems = useMemo(() => {
    const notes: { stem: string; path: string }[] = [];
    const walk = (nodes: VaultTreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === "note") notes.push({ stem: stemOf(n.name), path: n.path });
        if (n.kind === "folder") walk(n.children);
      }
    };
    walk(tree);
    // Ambiguous stems insert their full path so the link resolves to the
    // note the user actually picked, not whichever same-named note wins.
    const stemCounts = new Map<string, number>();
    for (const n of notes) stemCounts.set(n.stem, (stemCounts.get(n.stem) ?? 0) + 1);
    return notes.map((n) => ({
      label: (stemCounts.get(n.stem) ?? 0) > 1 ? n.path : n.stem,
      detail: n.path,
    }));
  }, [tree]);

  const onOpenLink = useCallback(
    (target: string, subpath: string | null) => {
      void openNote(target, subpath);
    },
    [openNote],
  );

  const onOpenGraphNode = useCallback(
    (p: string) => {
      setGraphOpen(false);
      // Graph nodes include attachments now — route by kind.
      if (p.toLowerCase().endsWith(".md")) void openNote(p);
      else useVaultStore.getState().openFile(p);
    },
    [setGraphOpen, openNote],
  );

  // Drag-delta (px) → percentage of the center pane's live width.
  const centerRef = useRef<HTMLDivElement | null>(null);
  const dxToPct = useCallback((dx: number) => {
    const w = centerRef.current?.getBoundingClientRect().width ?? 1;
    return (dx / Math.max(1, w)) * 100;
  }, []);
  // The live CodeMirror view — the toolbar dispatches edits through it, and
  // the voice hooks (read-aloud selection, dictation) write through it too.
  const editorViewRef = useRef<EditorView | null>(null);
  const readAloud = useVaultReadAloud(editorViewRef);
  const dictation = useVaultDictation(editorViewRef);

  // The command palette and the Mod+Shift+V shortcut reach dictation through
  // an event (they live outside this component's React tree, which owns the
  // engine instance). Same escape hatch as `vault:insert-text`.
  useEffect(() => {
    const onToggle = () => {
      if (!dictation.canDictate) {
        useUiStore.getState().pushToast("info", "Switch to Edit mode to dictate");
        return;
      }
      dictation.toggleRecording();
    };
    window.addEventListener(VAULT_TOGGLE_DICTATION, onToggle);
    return () => window.removeEventListener(VAULT_TOGGLE_DICTATION, onToggle);
  }, [dictation.canDictate, dictation.toggleRecording]);

  /** Read a Blob as base64 (no data: prefix). */
  const blobToBase64 = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result);
        resolve(s.slice(s.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  const insertPastedImage = useCallback(
    async (file: File) => {
      const view = editorViewRef.current;
      if (!view || !activePath) return;
      try {
        const b64 = await blobToBase64(file);
        const rawExt = file.type.split("/")[1] || "png";
        const ext = rawExt === "jpeg" ? "jpg" : rawExt;
        const name = `pasted-${Date.now()}.${ext}`;
        const { vaultWriteBinary } = await import("../../lib/ipc");
        // Backend may suffix on collision — use the RETURNED path.
        const rel = await vaultWriteBinary(`assets/${name}`, b64);
        const depth = activePath.split("/").length - 1;
        const relToNote = depth === 0 ? rel : "../".repeat(depth) + rel;
        applyEdit(view, { type: "insert", text: `![[${relToNote}]]` });
      } catch (err) {
        toastError("Could not insert image", err);
      }
    },
    [activePath],
  );
  const insertImage = useCallback(async () => {
    const view = editorViewRef.current;
    if (!view) return;
    try {
      const picked = await pickFile({
        multiple: false,
        title: "Choose an image to insert",
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] }],
      });
      if (typeof picked !== "string" || !activePath) return;
      const base = picked.split(/[\\/]/).pop() ?? "image.png";
      const { vaultImportFile } = await import("../../lib/ipc");
      const rel = await vaultImportFile(picked, `assets/${base}`);
      // Embed as a path relative to the note (../ per folder depth).
      const depth = activePath.split("/").length - 1;
      const relToNote = depth === 0 ? rel : "../".repeat(depth) + rel;
      applyEdit(view, { type: "insert", text: `![[${relToNote}]]` });
    } catch (e) {
      toastError("Could not insert image", e);
    }
  }, [activePath]);

  // Template inserts: the picker dispatches "vault:insert-text" with the
  // template text; drop it at the editor cursor through the live view —
  // the same dispatch shape as the toolbar's insert action (insert at the
  // selection head, cursor after the insert, refocus). No editor mounted
  // (preview mode, no note) → skip silently.
  useEffect(() => {
    const onInsertText = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      const view = editorViewRef.current;
      if (!view || typeof text !== "string" || text === "") return;
      applyEdit(view, { type: "insert", text });
    };
    window.addEventListener("vault:insert-text", onInsertText);
    return () => window.removeEventListener("vault:insert-text", onInsertText);
  }, []);

  if (!root) {
    return (
      <div className="vault-view">
        <Binder />
      </div>
    );
  }

  const vaultName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;

  const changeVault = async () => {
    try {
      const picked = await pickFolder({
        directory: true,
        multiple: false,
        title: "Choose a different folder to use as your vault",
      });
      if (typeof picked === "string" && picked && picked !== root) {
        await bind(picked);
      }
    } catch (e) {
      toastError("Could not bind vault folder", String(e));
    }
  };

  return (
    <div className="vault-view">
      {/* Header — rides in the window title bar, not above the page (see
          common/ToolbarHeader), so the vault name and the file actions sit
          beside the window controls. The name is a drag region; the actions
          stay clickable. */}
      <ToolbarHeader>
        <header className="vault-header">
          <div className="vault-header-left" data-tauri-drag-region="">
            {/* The safe mark the sidebar uses — the other full-page headers
                carry their icon into the caption, this one had none. */}
            <span className="vault-header-icon" data-tauri-drag-region="">
              <VaultIcon size={16} strokeWidth={1.8} />
            </span>
            <span className="vault-title" data-tauri-drag-region="" title={root}>{vaultName}</span>
            {stats ? (
              <span className="vault-stats-chip">
                {stats.notes} notes · {stats.links} links{stats.unresolved > 0 ? ` · ${stats.unresolved} unresolved` : ""}
              </span>
            ) : null}
          </div>
          <div className="vault-header-actions">
            <button title="New note (vault root)" onClick={() => void createNote("Untitled.md")}>
              <FilePlus2 size={14} />
            </button>
            <button title="New folder (vault root)" onClick={() => void createFolder("New folder")}>
              <FolderPlus size={14} />
            </button>
            <button title="Quick switcher (Ctrl+P)" onClick={() => setSwitcherOpen(true)}>
              <Search size={14} />
            </button>
            <button
              className={graphOpen ? "active" : ""}
              title="Graph view"
              onClick={() => setGraphOpen(!graphOpen)}
            >
              <Network size={14} />
            </button>
            <button title="Rebuild index" onClick={() => void rescan()}>
              <RefreshCw size={14} />
            </button>
            {/* Change vault replaces unbind-and-rebind — one obvious action
                for "this is the wrong folder". */}
            <button title="Change vault folder…" onClick={() => void changeVault()}>
              <FolderInput size={14} />
            </button>
          </div>
        </header>
      </ToolbarHeader>

      <div className={`vault-body${resizing ? " resizing" : ""}`}>
        <aside
          className={`vault-left-rail${leftRailCollapsed ? " collapsed" : ""}`}
          style={{
            width: leftRailCollapsed ? 28 : leftRailWidth,
            minWidth: leftRailCollapsed ? 28 : VAULT_LEFT_RAIL.min,
            maxWidth: leftRailCollapsed ? 28 : VAULT_LEFT_RAIL.max,
          }}
        >
          {leftRailCollapsed ? (
            <button className="vault-rail-expand" title="Show the files panel" onClick={toggleLeftRail}>
              <PanelIcon side="left" size={14} />
            </button>
          ) : (
            <div className="vault-rail-inner">
              <div className="vault-rail-tabs" role="tablist">
                <button role="tab" aria-selected={rail === "files"} className={rail === "files" ? "active" : ""} onClick={() => setRail("files")}>
                  Files
                </button>
                <button role="tab" aria-selected={rail === "search"} className={rail === "search" ? "active" : ""} onClick={() => setRail("search")}>
                  <Search size={12} /> Search
                </button>
                <button role="tab" aria-selected={rail === "tags"} className={rail === "tags" ? "active" : ""} onClick={() => setRail("tags")}>
                  <Hash size={12} /> Tags
                </button>
                <button className="vault-rail-collapse" title="Hide the files panel" onClick={toggleLeftRail}>
                  <PanelIcon side="left" size={13} />
                </button>
              </div>
              {rail === "files" && (
                <>
                  <VaultPinned />
                  <VaultFileTree tree={tree} />
                </>
              )}
              {rail === "search" && <VaultSearchPanel />}
              {rail === "tags" && <VaultTagsPanel />}
            </div>
          )}
        </aside>
        {!leftRailCollapsed && (
          <ResizeHandle
            onDrag={(dx) => setLeftRailWidth((w) => w + dx)}
            onDragState={setResizing}
          />
        )}

        <main className="vault-center" ref={centerRef}>
          {graphOpen ? (
            graph ? (
              <VaultGraphLazy
                nodes={graph.nodes}
                edges={graph.edges}
                activePath={activePath}
                onOpenNode={onOpenGraphNode}
              />
            ) : (
              <div className="vault-center-placeholder"><Loader2 className="spin" size={18} /> Laying out the graph…</div>
            )
          ) : assetPath == null && activePath == null ? (
            <div className="vault-center-placeholder">
              <Link2 size={22} strokeWidth={1.4} />
              <p>Open a note from the left, or press Ctrl+P.</p>
            </div>
          ) : (
            /* Asset + note sit SIDE BY SIDE (read a pdf, take notes on the
               right); each can be closed independently, and the divider is
               draggable. */
            <div className="vault-center-split">
              {assetPath != null && (
                <div
                  className="vault-asset-pane"
                  style={activePath != null ? { flex: `0 1 ${assetSplitPct}%` } : undefined}
                >
                  {/* The asset pane keeps its OWN tab strip (same component as
                      the note strip): the two panes are independent surfaces —
                      read a pdf, take notes beside it — so a shared strip would
                      fight that. Closing every asset tab hides the pane. */}
                  <VaultTabStrip
                    tabs={openAssets}
                    active={assetPath}
                    ariaLabel="Open files"
                    labelFor={stemOf}
                    onSelect={(p) => openFile(p)}
                    onClose={closeAssetTab}
                    onReorder={reorderAssetTab}
                  />
                  <VaultAssetView path={assetPath} />
                </div>
              )}
              {assetPath != null && activePath != null && (
                <ResizeHandle
                  onDrag={(dx) => {
                    const w = centerRef.current?.getBoundingClientRect().width ?? 0;
                    const assetMin = assetPath.toLowerCase().endsWith(".pdf") ? VAULT_PDF_MIN_PX : VAULT_ASSET_MIN_PX;
                    setAssetSplitPct(clampAssetSplitPct(dxToPct(dx) + assetSplitPct, w, assetMin));
                  }}
                  onDragState={setResizing}
                />
              )}
              {activePath != null && (
              <div className={`vault-note-split mode-${mode}`}>
              <div className="vault-note-head">
                <span className="vault-note-path" title={activePath}>{activePath}</span>
                {dirty ? <span className="vault-dirty-dot" title="Unsaved changes (autosave on)" /> : null}
                <ModeSwitch />
                {/* Voice: read the whole note, read just the selection, and
                    dictate into the caret. The transport for any read is the
                    global TtsPlayerBar below the view switch, so these are
                    just entry points. */}
                <button
                  className={`vault-rail-toggle${readAloud.readingNote ? " active" : ""}`}
                  title={readAloud.readingNote ? "Stop reading" : "Read this note aloud"}
                  aria-label={readAloud.readingNote ? "Stop reading this note aloud" : "Read this note aloud"}
                  onClick={readAloud.readingNote ? readAloud.stop : readAloud.readNote}
                >
                  {readAloud.readingNote ? <Square size={13} /> : <Volume2 size={14} />}
                </button>
                <button
                  className={`vault-rail-toggle${readAloud.readingSelection ? " active" : ""}`}
                  disabled={!readAloud.hasSelection}
                  title={
                    readAloud.readingSelection
                      ? "Stop reading"
                      : readAloud.hasSelection
                        ? "Read the selected text aloud"
                        : "Select text in the editor to read it aloud"
                  }
                  aria-label="Read the selected text aloud"
                  onClick={readAloud.readingSelection ? readAloud.stop : readAloud.readSelection}
                >
                  <Headphones size={14} />
                </button>
                <button
                  className={`vault-rail-toggle${dictation.recording ? " active recording" : ""}`}
                  disabled={!dictation.canDictate}
                  title={
                    dictation.canDictate
                      ? dictation.recording
                        ? "Stop dictating"
                        : "Dictate into this note (or hold Alt)"
                      : "Switch to Edit mode to dictate"
                  }
                  aria-label={dictation.recording ? "Stop dictating" : "Dictate into this note"}
                  onClick={dictation.toggleRecording}
                >
                  <Mic size={14} />
                </button>
                {dictation.recording && (
                  <span className="voice-wave vault-voice-wave" aria-hidden="true">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <span
                        key={i}
                        ref={(el) => {
                          dictation.waveBarsRef.current[i] = el;
                        }}
                      />
                    ))}
                  </span>
                )}
                <button
                  className={`vault-rail-toggle vault-note-pin${isPinned ? " pinned" : ""}`}
                  title={isPinned ? "Unpin note" : "Pin note"}
                  onClick={() => activePath != null && pinNote(activePath)}
                >
                  <Star size={14} fill={isPinned ? "currentColor" : "none"} />
                </button>
                <button className="vault-rail-toggle" title="Toggle note rail" onClick={toggleRightRail}>
                  <PanelIcon side="right" size={14} />
                </button>
                <button className="vault-rail-toggle" title="Close note" onClick={closeNote}>
                  <X size={14} />
                </button>
              </div>
              {/* Open-note tab strip (shared VaultTabStrip): click activates,
                  ✕ (or middle-click) closes just that tab, the wheel scrolls
                  an overflowing strip and dragging a tab reorders it. The
                  store owns ordering and the active-tab neighbor handoff. */}
              <VaultTabStrip
                tabs={openNotes}
                active={activePath}
                ariaLabel="Open notes"
                labelFor={stemOf}
                onSelect={(p) => void openNote(p)}
                onClose={closeNoteTab}
                onReorder={reorderNoteTab}
              />
              {/* key={mode}: each switch remounts the surface so the fade-in
                  below plays (the app's standard --ease motion). EDIT is the
                  live-preview editor (markdown source stays editable while
                  decorations render it document-style); PREVIEW is the pure
                  rendered view. */}
              <div className={`vault-note-panes ${mode}`} key={mode}>
                {mode === "edit" ? (
                  <div className="vault-editor-pane">
                    <EditorToolbar
                      onAction={(a) => {
                        const v = editorViewRef.current;
                        if (v) applyEdit(v, a);
                      }}
                      onInsertImage={() => void insertImage()}
                      onView={(fn) => {
                        const v = editorViewRef.current;
                        if (v) fn(v);
                      }}
                    />
                    {loadingNote ? (
                      <div className="vault-center-placeholder"><Loader2 className="spin" size={16} /></div>
                    ) : (
                      <Suspense fallback={<div className="vault-center-placeholder">Loading editor…</div>}>
                        <VaultEditor
                          key={activePath}
                          value={content}
                          onChange={setContent}
                          onEdit={scheduleSave}
                          onSave={() => void saveNow()}
                          completionItems={completionItems}
                          onOpenLink={onOpenLink}
                          onViewReady={(v) => {
                            editorViewRef.current = v;
                          }}
                          onImagePaste={(f) => void insertPastedImage(f)}
                        />
                      </Suspense>
                    )}
                  </div>
                ) : (
                  <div className="vault-preview-pane">
                    <VaultPreview content={content} notePath={activePath} onToggleTaskLine={onToggleTaskLine} />
                  </div>
                )}
              </div>
              </div>
              )}
            </div>
          )}
        </main>

        {rightRailOpen && !graphOpen && activePath != null && (
          <>
            <ResizeHandle
              onDrag={(dx) => setRightRailWidth((w) => w - dx)}
              onDragState={setResizing}
            />
            {/* maxWidth mirrors the store clamp on the RENDERED box: with the
                width authoritative (flex-shrink: 0) this guarantees the rail
                can never render past its bound and drift toward the screen
                edge while a drag keeps going past the max. */}
            <aside
              className="vault-right-rail"
              style={{ width: rightRailWidth, minWidth: VAULT_RIGHT_RAIL.min, maxWidth: VAULT_RIGHT_RAIL.max }}
            >
              <VaultNoteRail />
            </aside>
          </>
        )}
      </div>

      <VaultQuickSwitcher />
      <VaultTemplatePicker />
      {/* The hover page-preview card is a position:fixed singleton driven by
          module state (openVaultLinkHover from the editor + preview links) —
          it mounts here, ABOVE any mode-conditional surface, so hovers work
          in both edit and preview modes. */}
      <VaultLinkHoverHost />
    </div>
  );
}

// The graph is part of this chunk (it's small and canvas-based), but the
// indirection keeps VaultView's import graph honest if it grows.
const VaultGraphLazy = lazy(() => import("./VaultGraph").then((m) => ({ default: m.VaultGraph })));
