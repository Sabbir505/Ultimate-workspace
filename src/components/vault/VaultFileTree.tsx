// Vault file tree — folders + notes + assets, virtualization-free but
// collapsed-by-default (a vault's tree is only as tall as its open
// folders). Inline rename, delete-to-trash, new note/folder per folder.
// The tree is disk-driven (vault_tree), so external file managers stay in
// sync through the watcher.

import { memo, useCallback, useState } from "react";
import { ChevronDown, ChevronRight, FileText, File as FileIcon, Folder, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
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
  expanded,
  toggle,
  selected,
  onOpen,
  onRename,
  onDelete,
  onNewNote,
  onNewFolder,
}: {
  node: VaultTreeNode;
  depth: number;
  expanded: boolean;
  toggle: (path: string) => void;
  selected: boolean;
  onOpen: (path: string) => void;
  onRename: (node: VaultTreeNode) => void;
  onDelete: (node: VaultTreeNode) => void;
  onNewNote: (folder: string) => void;
  onNewFolder: (folder: string) => void;
}) {
  const isFolder = node.kind === "folder";
  return (
    <>
      <div
        className={`vault-tree-row${selected ? " selected" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        role="treeitem"
        aria-expanded={isFolder ? expanded : undefined}
      >
        <button
          className="vault-tree-main"
          onClick={() => (isFolder ? toggle(node.path) : onOpen(node.path))}
          onDoubleClick={() => !isFolder && onRename(node)}
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
              {node.kind === "note" ? <FileText size={14} /> : <FileIcon size={14} />}
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
          <button title="Rename" onClick={() => onRename(node)}>
            <Pencil size={12} />
          </button>
          <button title={isFolder ? "Delete folder (to .trash)" : "Delete note (to .trash)"} onClick={() => onDelete(node)}>
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      {isFolder && expanded && (
        <div>
          {node.children.map((child) => (
            <Row
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              selected={selected}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
              onNewNote={onNewNote}
              onNewFolder={onNewFolder}
            />
          ))}
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
  const openNote = useVaultStore((s) => s.openNote);
  const createNote = useVaultStore((s) => s.createNote);
  const createFolder = useVaultStore((s) => s.createFolder);
  const renameNote = useVaultStore((s) => s.renameNote);
  const deleteNote = useVaultStore((s) => s.deleteNote);
  const deleteFolder = useVaultStore((s) => s.deleteFolder);

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
      }
    },
    [deleteFolder, deleteNote],
  );

  const rows = tree.map((node) => (
    <Row
      key={node.path}
      node={node}
      depth={0}
      expanded={expanded.has(node.path)}
      toggle={toggle}
      selected={node.path === activePath}
      onOpen={(p) => void openNote(p)}
      onRename={(n) => setRenaming(n.path)}
      onDelete={confirmDelete}
      onNewNote={(f) => setNewIn({ folder: f, kind: "note" })}
      onNewFolder={(f) => setNewIn({ folder: f, kind: "folder" })}
    />
  )).map((row) => row);

  return (
    <div className="vault-tree" role="tree">
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
