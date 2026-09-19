// Vault view — the knowledge-base surface (sidebar entry below Automations).
// Layout: left rail (Files / Search / Tags) · editor + preview center ·
// right rail (outline / backlinks / outgoing). The graph and the quick
// switcher overlay the center. When no vault is bound, a binder card offers
// folder pick (the same folder dialog the Knowledge panel uses).
//
// The editor/preview chunks (CodeMirror + the markdown pipeline) are loaded
// lazily so the entry bundle only pays for them when the vault is opened.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FilePlus2,
  FolderPlus,
  Network,
  Hash,
  Link2,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Unplug,
  FolderInput,
  Eye,
  Columns2,
  PencilLine,
} from "lucide-react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import {
  listenVaultChanged,
  listenVaultScanned,
  toastError,
  type VaultTreeNode,
} from "../../lib/ipc";
import { useVaultStore, type VaultMode, type VaultRail } from "../../state/vault";
import { VaultFileTree } from "./VaultFileTree";
import { VaultNoteRail, VaultSearchPanel, VaultTagsPanel, VaultQuickSwitcher } from "./VaultQuickSwitcher";
import { VaultPreview } from "./VaultPreview";
import { stemOf } from "../../lib/vaultLinks";

const VaultEditor = lazy(() => import("./VaultEditor").then((m) => ({ default: m.VaultEditor })));

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
  const rail = useVaultStore((s) => s.rail);
  const setRail = useVaultStore((s) => s.setRail);
  const rightRailOpen = useVaultStore((s) => s.rightRailOpen);
  const toggleRightRail = useVaultStore((s) => s.toggleRightRail);
  const activePath = useVaultStore((s) => s.activePath);
  const content = useVaultStore((s) => s.content);
  const savedContent = useVaultStore((s) => s.savedContent);
  const loadingNote = useVaultStore((s) => s.loadingNote);
  const mode = useVaultStore((s) => s.mode);
  const setContent = useVaultStore((s) => s.setContent);
  const scheduleSave = useVaultStore((s) => s.scheduleSave);
  const saveNow = useVaultStore((s) => s.saveNow);
  const openNote = useVaultStore((s) => s.openNote);
  const createNote = useVaultStore((s) => s.createNote);
  const createFolder = useVaultStore((s) => s.createFolder);
  const rescan = useVaultStore((s) => s.rescan);
  const unbind = useVaultStore((s) => s.unbind);
  const graphOpen = useVaultStore((s) => s.graphOpen);
  const setGraphOpen = useVaultStore((s) => s.setGraphOpen);
  const graph = useVaultStore((s) => s.graph);
  const setSwitcherOpen = useVaultStore((s) => s.setSwitcherOpen);
  const onVaultChanged = useVaultStore((s) => s.onVaultChanged);
  const onScanned = useVaultStore((s) => s.onScanned);
  const init = useVaultStore((s) => s.init);
  const dirty = content !== savedContent && activePath != null;
  const initialized = useRef(false);

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
    const out: { label: string; detail: string }[] = [];
    const walk = (nodes: VaultTreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === "note") out.push({ label: stemOf(n.name), detail: n.path });
        if (n.kind === "folder") walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  const onOpenLink = useCallback(
    (target: string, subpath: string | null) => {
      void openNote(target, subpath);
    },
    [openNote],
  );

  if (!root) {
    return (
      <div className="vault-view">
        <Binder />
      </div>
    );
  }

  const vaultName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;

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
          <button title="Unbind vault (keeps all files)" onClick={() => void unbind()}>
            <Unplug size={14} />
          </button>
        </div>
      </header>

      <div className="vault-body">
        <aside className="vault-left-rail">
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
          </div>
          {rail === "files" && <VaultFileTree tree={tree} />}
          {rail === "search" && <VaultSearchPanel />}
          {rail === "tags" && <VaultTagsPanel />}
        </aside>

        <main className="vault-center">
          {graphOpen ? (
            graph ? (
              <VaultGraphLazy
                nodes={graph.nodes}
                edges={graph.edges}
                activePath={activePath}
                onOpenNode={(p) => {
                  setGraphOpen(false);
                  void openNote(p);
                }}
              />
            ) : (
              <div className="vault-center-placeholder"><Loader2 className="spin" size={18} /> Laying out the graph…</div>
            )
          ) : activePath == null ? (
            <div className="vault-center-placeholder">
              <Link2 size={22} strokeWidth={1.4} />
              <p>Open a note from the left, or press Ctrl+P.</p>
            </div>
          ) : (
            <div className={`vault-note-split mode-${mode}`}>
              <div className="vault-note-head">
                <span className="vault-note-path" title={activePath}>{activePath}</span>
                {dirty ? <span className="vault-dirty-dot" title="Unsaved changes (autosave on)" /> : null}
                <ModeSwitch />
                <button className="vault-rail-toggle" title="Toggle note rail" onClick={toggleRightRail}>
                  {rightRailOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
                </button>
              </div>
              <div className={`vault-note-panes ${mode}`}>
                {mode !== "preview" && (
                  <div className="vault-editor-pane">
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
                        />
                      </Suspense>
                    )}
                  </div>
                )}
                {mode !== "edit" && (
                  <div className="vault-preview-pane">
                    <VaultPreview content={content} notePath={activePath} />
                  </div>
                )}
              </div>
            </div>
          )}
        </main>

        {rightRailOpen && !graphOpen && (
          <aside className="vault-right-rail">
            <VaultNoteRail />
          </aside>
        )}
      </div>

      <VaultQuickSwitcher />
    </div>
  );
}

// The graph is part of this chunk (it's small and canvas-based), but the
// indirection keeps VaultView's import graph honest if it grows.
const VaultGraphLazy = lazy(() => import("./VaultGraph").then((m) => ({ default: m.VaultGraph })));
