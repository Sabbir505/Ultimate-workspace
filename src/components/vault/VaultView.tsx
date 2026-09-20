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
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Quote,
  RefreshCw,
  Search,
  Strikethrough,
  FolderInput,
  Eye,
  Columns2,
  PencilLine,
  Redo2,
  Undo2,
  X,
} from "lucide-react";
import { open as pickFolder, open as pickFile } from "@tauri-apps/plugin-dialog";
import type { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import {
  listenVaultChanged,
  listenVaultScanned,
  toastError,
  type VaultTreeNode,
} from "../../lib/ipc";
import { useVaultStore, type VaultMode, type VaultRail, VAULT_LEFT_RAIL, VAULT_RIGHT_RAIL } from "../../state/vault";
import { VaultFileTree } from "./VaultFileTree";
import { VaultNoteRail, VaultSearchPanel, VaultTagsPanel, VaultQuickSwitcher } from "./VaultQuickSwitcher";
import { VaultPreview } from "./VaultPreview";
import { VaultAssetView } from "./VaultAssetView";
import { stemOf } from "../../lib/vaultLinks";

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
      <button title="Heading" onClick={() => onAction({ type: "linePrefix", prefix: "# " })}>
        <Heading1 size={13} />
      </button>
      {wrapBtn(<Bold size={13} />, "Bold (**…**)", "**")}
      {wrapBtn(<Italic size={13} />, "Italic (*…*)", "*")}
      {wrapBtn(<Strikethrough size={13} />, "Strikethrough (~~…~~)", "~~")}
      {wrapBtn(<Highlighter size={13} />, "Highlight (==…==)", "==")}
      {wrapBtn(<Code size={13} />, "Inline code", "`")}
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
    { key: "edit", icon: PencilLine, label: "Editor" },
    { key: "split", icon: Columns2, label: "Split" },
    { key: "preview", icon: Eye, label: "Preview" },
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
  const noteSplitPct = useVaultStore((s) => s.noteSplitPct);
  const assetSplitPct = useVaultStore((s) => s.assetSplitPct);
  const setNoteSplitPct = useVaultStore((s) => s.setNoteSplitPct);
  const setAssetSplitPct = useVaultStore((s) => s.setAssetSplitPct);
  const content = useVaultStore((s) => s.content);
  const savedContent = useVaultStore((s) => s.savedContent);
  const loadingNote = useVaultStore((s) => s.loadingNote);
  const mode = useVaultStore((s) => s.mode);
  const setContent = useVaultStore((s) => s.setContent);
  const scheduleSave = useVaultStore((s) => s.scheduleSave);
  const saveNow = useVaultStore((s) => s.saveNow);
  const openNote = useVaultStore((s) => s.openNote);
  const closeNote = useVaultStore((s) => s.closeNote);
  const createNote = useVaultStore((s) => s.createNote);
  const createFolder = useVaultStore((s) => s.createFolder);
  const rescan = useVaultStore((s) => s.rescan);
  const graphOpen = useVaultStore((s) => s.graphOpen);
  const setGraphOpen = useVaultStore((s) => s.setGraphOpen);
  const graph = useVaultStore((s) => s.graph);
  const setSwitcherOpen = useVaultStore((s) => s.setSwitcherOpen);
  const onVaultChanged = useVaultStore((s) => s.onVaultChanged);
  const onScanned = useVaultStore((s) => s.onScanned);
  const init = useVaultStore((s) => s.init);
  const dirty = content !== savedContent && activePath != null;
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

  // Ctrl/Cmd+P quick switcher while the view is up; Mod+S flushes a save.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        setSwitcherOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setSwitcherOpen, saveNow]);

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

  // The live CodeMirror view — the toolbar dispatches edits through it.
  const editorViewRef = useRef<EditorView | null>(null);
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
      <header className="vault-header">
        <div className="vault-header-left">
          <span className="vault-title" title={root}>{vaultName}</span>
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
              <PanelLeftOpen size={14} />
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
                  <PanelLeftClose size={13} />
                </button>
              </div>
              {rail === "files" && <VaultFileTree tree={tree} />}
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
                  style={activePath != null ? { flex: `0 0 ${assetSplitPct}%` } : undefined}
                >
                  <VaultAssetView path={assetPath} />
                </div>
              )}
              {assetPath != null && activePath != null && (
                <ResizeHandle
                  onDrag={(dx) => setAssetSplitPct((p) => p + dxToPct(dx))}
                  onDragState={setResizing}
                />
              )}
              {activePath != null && (
            <div className={`vault-note-split mode-${mode}`}>
              <div className="vault-note-head">
                <span className="vault-note-path" title={activePath}>{activePath}</span>
                {dirty ? <span className="vault-dirty-dot" title="Unsaved changes (autosave on)" /> : null}
                <ModeSwitch />
                <button className="vault-rail-toggle" title="Toggle note rail" onClick={toggleRightRail}>
                  {rightRailOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
                </button>
                <button className="vault-rail-toggle" title="Close note" onClick={closeNote}>
                  <X size={14} />
                </button>
              </div>
              {/* key={mode}: each switch remounts the panes so the fade-in
                  below plays (the app's standard --ease motion). */}
              <div className={`vault-note-panes ${mode}`} key={mode}>
                {mode !== "preview" && (
                  <div
                    className="vault-editor-pane"
                    style={mode === "split" ? { flex: `0 0 ${noteSplitPct}%`, minWidth: 180 } : undefined}
                  >
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
                )}
                {mode === "split" && (
                  <ResizeHandle
                    onDrag={(dx) => setNoteSplitPct((p) => p + dxToPct(dx))}
                    onDragState={setResizing}
                  />
                )}
                {mode !== "edit" && (
                  <div className="vault-preview-pane">
                    <VaultPreview content={content} notePath={activePath} />
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
    </div>
  );
}

// The graph is part of this chunk (it's small and canvas-based), but the
// indirection keeps VaultView's import graph honest if it grows.
const VaultGraphLazy = lazy(() => import("./VaultGraph").then((m) => ({ default: m.VaultGraph })));
