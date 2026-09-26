// Vault file tree — folders + notes + assets, virtualization-free but
// collapsed-by-default (a vault's tree is only as tall as its open
// folders). Inline rename, delete-to-trash, new note/folder per folder.
// The tree is disk-driven (vault_tree), so external file managers stay in
// sync through the watcher.

import { memo, useCallback, useMemo, useState, type DragEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  File as FileIcon,
  Folder,
  FolderOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { VaultTreeNode } from "../../lib/ipc";
import { useVaultStore } from "../../state/vault";

function NewEntryInput({
  kind,
  onCommit,
  onCancel,
}: {
  kind: "note" | "folder";
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(kind === "note" ? "Untitled.md" : "New folder");
  return (
    <form
      className="vault-tree-new-entry"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onCommit(value.trim());
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      />
    </form>
  );
}

const Row = memo(function Row({
  node,
  depth,
  expandedSet,
  toggle,
  selected,
  onOpen,
  onRename,
  onDelete,
  onNewNote,
  onNewFolder,
  dnd,
}: {
  node: VaultTreeNode;
  depth: number;
  /** The live expanded-set: each Row reads ITS OWN path — threading the
   *  parent's boolean down the recursion made every nested folder inherit
   *  its ancestor's state (nested folders could never be collapsed). */
  expandedSet: Set<string>;
  toggle: (path: string) => void;
  selected: boolean;
  onOpen: (path: string) => void;
  onRename: (node: VaultTreeNode) => void;
  onDelete: (node: VaultTreeNode) => void;
  onNewNote: (folder: string) => void;
  onNewFolder: (folder: string) => void;
  dnd: {
    /** A file drag is in flight (folders highlight as drop targets). */
    active: boolean;
    /** The folder path (or "" for root) currently hovered, if any. */
    dropDir: string | null;
    onDragStartFile: (node: VaultTreeNode, e: DragEvent) => void;
    onDragEnd: () => void;
    onDragOverFolder: (node: VaultTreeNode, e: DragEvent) => void;
    onDragLeaveFolder: (node: VaultTreeNode) => void;
    onDropFolder: (node: VaultTreeNode, e: DragEvent) => void;
  };
}) {
  const isFolder = node.kind === "folder";
  const isNote = node.kind === "note";
  const expanded = expandedSet.has(node.path);
  const isDropTarget = dnd.active && isFolder && dnd.dropDir === node.path;
  return (
    <>
      <div
        className={`vault-tree-row${selected ? " selected" : ""}${isDropTarget ? " drop-target" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        role="treeitem"
        aria-expanded={isFolder ? expanded : undefined}
        draggable={!isFolder}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", node.path);
          dnd.onDragStartFile(node, e);
        }}
        onDragEnd={dnd.onDragEnd}
        onDragOver={isFolder ? (e) => dnd.onDragOverFolder(node, e) : undefined}
        onDragLeave={isFolder ? () => dnd.onDragLeaveFolder(node) : undefined}
        onDrop={isFolder ? (e) => dnd.onDropFolder(node, e) : undefined}
      >
        <button
          className="vault-tree-main"
          onClick={() => (isFolder ? toggle(node.path) : onOpen(node.path))}
          onDoubleClick={() => isNote && onRename(node)}
          title={node.path}
        >
          {isFolder ? (
            <>
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
            </>
          ) : (
            <>
              <span className="vault-tree-spacer" />
              {isNote ? <FileText size={14} /> : <FileIcon size={14} />}
            </>
          )}
          <span className="vault-tree-name">{node.name}</span>
        </button>
        <span className="vault-tree-actions">
          {isFolder ? (
            <>
              <button title="New note here" onClick={() => onNewNote(node.path)}>
                <Plus size={12} />
              </button>
              <button title="New folder here" onClick={() => onNewFolder(node.path)}>
                <Folder size={12} />
              </button>
            </>
          ) : null}
          {isNote ? (
            // Notes only: vault_rename_note rewrites vault-wide links and
            // requires a .md target, so offering it on assets renamed them
            // to "file.pdf.md" with every embed now dangling.
            <button title="Rename" onClick={() => onRename(node)}>
              <Pencil size={12} />
            </button>
          ) : null}
          <button title={isFolder ? "Delete folder (to .trash)" : isNote ? "Delete note (to .trash)" : "Delete file (to .trash)"} onClick={() => onDelete(node)}>
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      {isFolder && (
        /* Always mounted — the grid-rows transition (motion.css's trick)
           animates collapse/expand smoothly instead of popping. */
        <div className={`vault-tree-children${expanded ? " open" : ""}`}>
          <div className="vault-tree-children-inner">
            {node.children.map((child) => (
              <Row
                key={child.path}
                node={child}
                depth={depth + 1}
                expandedSet={expandedSet}
                toggle={toggle}
                selected={selected}
                onOpen={onOpen}
                onRename={onRename}
                onDelete={onDelete}
                onNewNote={onNewNote}
                onNewFolder={onNewFolder}
                dnd={dnd}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
});

export function VaultFileTree({ tree }: { tree: VaultTreeNode[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newIn, setNewIn] = useState<{ folder: string; kind: "note" | "folder" } | null>(null);
  const activePath = useVaultStore((s) => s.activePath);
  // Assets are tracked in `assetPath`, NOT `activePath` — openFile gives them
  // their own pane and never touches the editor buffer. Comparing selection
  // against `activePath` alone meant a PDF/image row could never light up,
  // so clicking one looked like it did nothing.
  const assetPath = useVaultStore((s) => s.assetPath);
  const openPaths = useMemo(
    () => new Set([activePath, assetPath].filter((p): p is string => p != null)),
    [activePath, assetPath],
  );
  const openNote = useVaultStore((s) => s.openNote);
  const openFile = useVaultStore((s) => s.openFile);
  const createNote = useVaultStore((s) => s.createNote);
  const createFolder = useVaultStore((s) => s.createFolder);
  const renameNote = useVaultStore((s) => s.renameNote);
  const deleteNote = useVaultStore((s) => s.deleteNote);
  const deleteFolder = useVaultStore((s) => s.deleteFolder);
  const moveEntry = useVaultStore((s) => s.moveEntry);

  // Drag & drop: only single files (notes + assets) move; folders stay put.
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);

  const finishDrop = useCallback(
    (dir: string) => {
      if (dragPath) void moveEntry(dragPath, dir);
      setDragPath(null);
      setDropDir(null);
    },
    [dragPath, moveEntry],
  );

  const dnd = {
    active: dragPath != null,
    dropDir,
    onDragStartFile: (node: VaultTreeNode) => setDragPath(node.path),
    onDragEnd: () => {
      setDragPath(null);
      setDropDir(null);
    },
    onDragOverFolder: (node: VaultTreeNode, e: DragEvent) => {
      if (dragPath == null) return;
      e.preventDefault();
      e.stopPropagation(); // the tree root must not steal the drop
      setDropDir(node.path);
    },
    onDragLeaveFolder: (node: VaultTreeNode) => {
      setDropDir((cur) => (cur === node.path ? null : cur));
    },
    onDropFolder: (node: VaultTreeNode, e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      finishDrop(node.path);
    },
  };

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const confirmDelete = useCallback(
    (node: VaultTreeNode) => {
      if (node.kind === "folder") {
        if (window.confirm(`Delete folder "${node.name}" and everything in it?\n(it moves to the vault's .trash)`)) {
          void deleteFolder(node.path);
        }
      } else if (node.kind === "note") {
        if (window.confirm(`Delete "${node.name}"?\n(it moves to the vault's .trash)`)) {
          void deleteNote(node.path);
        }
      } else {
        // Non-note asset — the backend trash move takes any file.
        if (window.confirm(`Delete file "${node.name}"?\n(it moves to the vault's .trash)`)) {
          void deleteNote(node.path);
        }
      }
    },
    [deleteFolder, deleteNote],
  );

  const rows = tree.map((node) => (
    <Row
      key={node.path}
      node={node}
      depth={0}
      expandedSet={expanded}
      toggle={toggle}
      selected={openPaths.has(node.path)}
      onOpen={(p) => {
        // Non-note assets go to the asset view — openNote would search the
        // NOTE index, miss, and toast "No note named …" for a file that is
        // right there in the tree.
        if (node.kind === "file") void openFile(p);
        else void openNote(p);
      }}
      onRename={(n) => setRenaming(n.path)}
      onDelete={confirmDelete}
      onNewNote={(f) => setNewIn({ folder: f, kind: "note" })}
      onNewFolder={(f) => setNewIn({ folder: f, kind: "folder" })}
      dnd={dnd}
    />
  ));

  return (
    <div
      className="vault-tree"
      role="tree"
      onDragOver={(e) => {
        // Dropping on the empty area moves to the vault root.
        if (dragPath != null) {
          e.preventDefault();
          setDropDir("");
        }
      }}
      onDrop={(e) => {
        if (dragPath != null) {
          e.preventDefault();
          finishDrop("");
        }
      }}
    >
      {rows.length === 0 ? (
        <div className="vault-tree-empty">Empty vault — create your first note below.</div>
      ) : (
        rows
      )}
      {newIn ? (
        <div className="vault-tree-new-wrap">
          <NewEntryInput
            kind={newIn.kind}
            onCancel={() => setNewIn(null)}
            onCommit={(name) => {
              const full = newIn.folder ? `${newIn.folder}/${name}` : name;
              if (newIn.kind === "note") void createNote(full);
              else void createFolder(full);
              setNewIn(null);
            }}
          />
        </div>
      ) : null}
      {renaming ? (
        <div className="vault-tree-rename-overlay" onClick={() => setRenaming(null)}>
          <form
            className="vault-tree-rename-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem("name") as HTMLInputElement).value;
              if (input.trim()) {
                void renameNote(renaming, input.trim());
              }
              setRenaming(null);
            }}
          >
            <label className="field-label">Rename note (links across the vault will be rewritten)</label>
            <input name="name" autoFocus defaultValue={renaming} />
            <div className="vault-tree-rename-actions">
              <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
              <button type="submit" className="primary">Rename</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
