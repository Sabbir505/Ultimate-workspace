// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
//
// Vault — the local markdown knowledge base (src-tauri/src/vault/). Files on
// disk are the source of truth; every read/write here goes through the Rust
// vault commands so the index (links/backlinks/search) stays in lockstep.
import { safeInvoke, safeListen } from "../ipcCore";

export interface VaultTreeNode {
  name: string;
  /** Vault-relative path, '/' separators. Folders have no extension. */
  path: string;
  kind: "folder" | "note" | "file";
  children: VaultTreeNode[];
}

/** [newPath, filesRewritten] */
export type VaultRenameResult = [string, number];

export interface VaultStats {
  notes: number;
  files: number;
  links: number;
  unresolved: number;
}

export interface VaultSearchHit {
  path: string;
  title: string | null;
  basename: string;
  /** Snippet with ⟨ ⟩ around matches. */
  snippet: string;
}

export interface VaultMention {
  src: string;
  line: number;
  raw: string;
  is_embed: boolean;
}

export interface VaultNoteMeta {
  path: string;
  title: string | null;
  basename: string;
  backlinks: VaultMention[];
  unresolved_mentions: VaultMention[];
  outgoing: VaultMention[];
  tags: string[];
  headings: [number, string, number][];
  aliases: string[];
  word_count: number;
}

export interface VaultGraphNode {
  id: string;
  label: string;
  unresolved: boolean;
  degree: number;
}

export interface VaultGraphEdge {
  src: string;
  dst: string;
}

export interface VaultTagCount {
  tag: string;
  count: number;
}

export interface VaultChangedPayload {
  paths: string[];
}

export interface VaultScannedPayload {
  notes: number;
  ms: number;
}

export const vaultGetState = () =>
  safeInvoke<{ root: string | null; stats: VaultStats | null }>("vault_get_state");
export const vaultBind = (path: string) => safeInvoke<string>("vault_bind", { path });
export const vaultUnbind = () => safeInvoke<void>("vault_unbind");
export const vaultRescan = () => safeInvoke<void>("vault_rescan");
export const vaultTree = () => safeInvoke<VaultTreeNode[]>("vault_tree");
export const vaultReadNote = (path: string) => safeInvoke<string>("vault_read_note", { path });
/** (mime, base64) for image/pdf embeds. */
export const vaultReadBinary = (path: string) =>
  safeInvoke<[string, string]>("vault_read_binary", { path });
export const vaultCreateNote = (path: string, content: string) =>
  safeInvoke<string>("vault_create_note", { path, content });
export const vaultWriteNote = (path: string, content: string) =>
  safeInvoke<string>("vault_write_note", { path, content });
export const vaultDeleteNote = (path: string) =>
  safeInvoke<string>("vault_delete_note", { path });
/** Move a NON-note file (asset) to a new vault-relative path (drag & drop). */
export const vaultMoveFile = (from: string, to: string) =>
  safeInvoke<string>("vault_move_file", { from, to });
/** Copy an external file INTO the vault (insert-image). Returns the final
 *  vault-relative path (suffixed on collision, never clobbers). */
export const vaultImportFile = (src: string, dest: string) =>
  safeInvoke<string>("vault_import_file", { src, dest });
/** Write raw bytes (base64) into a vault file — clipboard image paste.
 *  Returns the final vault-relative path (suffixed on collision). */
export const vaultWriteBinary = (path: string, base64Data: string) =>
  safeInvoke<string>("vault_write_binary", { path, base64Data });
/** [newPath, filesRewritten] */
export const vaultRenameNote = (from: string, to: string) =>
  safeInvoke<[string, number]>("vault_rename_note", { from, to });
export const vaultCreateFolder = (path: string) =>
  safeInvoke<string>("vault_create_folder", { path });
export const vaultDeleteFolder = (path: string) =>
  safeInvoke<string>("vault_delete_folder", { path });
export const vaultSearch = (query: string, limit?: number) =>
  safeInvoke<VaultSearchHit[]>("vault_search", { query, limit: limit ?? 30 });
export const vaultNoteMeta = (path: string) =>
  safeInvoke<VaultNoteMeta>("vault_note_meta", { path });
export const vaultGraph = (includeUnresolved = true, includeAttachments = false) =>
  safeInvoke<[VaultGraphNode[], VaultGraphEdge[]]>("vault_graph", {
    includeUnresolved,
    includeAttachments,
  });
export const vaultAllTags = () => safeInvoke<VaultTagCount[]>("vault_all_tags");
export const vaultStats = () => safeInvoke<VaultStats>("vault_stats");

/** The watcher reindexed (or saw) these vault-relative paths. */
export const listenVaultChanged = (handler: (payload: VaultChangedPayload) => void) =>
  safeListen<VaultChangedPayload>("vault:changed", handler);
export const listenVaultScanned = (handler: (payload: VaultScannedPayload) => void) =>
  safeListen<VaultScannedPayload>("vault:scanned", handler);
