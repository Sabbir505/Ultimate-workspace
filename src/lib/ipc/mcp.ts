// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";

// ---- MCP server gallery (§3.2.14) ----
// User-installable stdio MCP servers whose tools join every tool-enabled
// chat turn under prefixed names (`mcp_<server>_<tool>`). Mirrors the Rust
// types in src-tauri/src/mcp_gallery.rs (serde camelCase).

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  envKeys: string[];
}

export interface McpServerDef {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  fromGallery: boolean;
}

export interface McpGalleryList {
  catalog: McpCatalogEntry[];
  installed: McpServerDef[];
}

export interface McpToolView {
  wireName: string;
  rawName: string;
  description?: string | null;
  /** "read" | "write" — same classification as connector tools. */
  kind: string;
}

export interface McpConnectResult {
  serverId: string;
  tools: McpToolView[];
}

export const mcpGalleryList = () =>
  safeInvoke<McpGalleryList | null>("mcp_gallery_list");

export const mcpGalleryInstall = (catalogId?: string, custom?: Partial<McpServerDef>) =>
  safeInvoke<McpServerDef | null>("mcp_gallery_install", { catalogId, custom });

export const mcpGalleryRemove = (id: string) =>
  safeInvoke<null>("mcp_gallery_remove", { id });

export const mcpGallerySetEnabled = (id: string, enabled: boolean) =>
  safeInvoke<null>("mcp_gallery_set_enabled", { id, enabled });

export const mcpGalleryConnect = (id: string) =>
  safeInvoke<McpConnectResult | null>("mcp_gallery_connect", { id });

export const mcpGalleryDisconnect = (id: string) =>
  safeInvoke<null>("mcp_gallery_disconnect", { id });


// ── Persistent user memory (MEMORY_DESIGN_ARCHITECTURE.md §12) ─────────────

export interface MemoryRecordView {
  id: string;
  kind: string;
  profile: string;
  projectId: string | null;
  subject: string;
  content: string;
  keywords: string[];
  importance: number;
  confidence: number;
  status: string;
  supersededBy: string | null;
  validFrom: number;
  validUntil: number | null;
  createdAt: number;
  updatedAt: number;
  origin: string;
  /** True once the memory has been folded into (or considered by) a
   * reflection pass (MEMORY_DESIGN_ARCHITECTURE.md §8.4). */
  reflected: boolean;
}

export interface MemoryStatusView {
  enabled: boolean;
  activeCount: number;
  /** The EFFECTIVE memory document — the stored (LLM-merged or user-edited)
   * text, or a deterministic render from the records. Exactly what gets
   * injected as one budgeted block each turn. Null = empty store. */
  document: string | null;
  /** Whether a hand-merged/edited document is stored (vs the auto render). */
  documentStored: boolean;
  /** Unix seconds the stored document was last written; null = auto. */
  documentUpdatedAt: number | null;
  /** Injection budget in tokens (enforced in Rust, ~4 chars/token). */
  documentBudget: number;
  /** Cheap model the extraction/judge/merge pipeline uses; "" = chat model. */
  extractModel: string;
}

/** One stored snapshot of the memory document (History + Restore). */
export interface MemoryDocVersionView {
  id: number;
  /** "merge" (LLM) or "user" (panel save). */
  source: string;
  text: string;
  createdAt: number;
}

/** One write-decision row from the memory audit log. */
export interface MemoryOpRowView {
  id: number;
  ts: number;
  actor: string;
  sessionId: string | null;
  candidate: string;
  operation: string;
  targetIds: string[];
  rationale: string;
}

/** Emitted as `memory:updated` after the document merge applies changes. */
export interface MemoryUpdatedPayload {
  chatSessionId: string | null;
  /** Human summary, e.g. "1 added, 2 updated". */
  summary: string;
  trimmed: boolean;
}

export const memoryList = (includeInactive = true) =>
  safeInvoke<MemoryRecordView[] | null>("memory_list", { includeInactive });

export const memoryStatus = () =>
  safeInvoke<MemoryStatusView | null>("memory_status");

/** Replace the memory document from the UI. Empty text resets to the
 * auto-generated document. Errors when over the injection budget. */
export const memorySetDocument = (text: string) =>
  safeInvoke<null>("memory_set_document", { text });

/** Bounded version history of the memory document (newest first). */
export const memoryDocumentHistory = (limit = 20) =>
  safeInvoke<MemoryDocVersionView[] | null>("memory_document_history", { limit });

/** Recent write-decision audit rows (judge ops, merges, user edits). */
export const memoryRecentOps = (limit = 30) =>
  safeInvoke<MemoryOpRowView[] | null>("memory_recent_ops", { limit });

/** Set the cheap model for extraction/judge/merge. Empty = chat model. */
export const memorySetExtractModel = (model: string) =>
  safeInvoke<null>("memory_set_extract_model", { model });

export const listenMemoryUpdated = (handler: (payload: MemoryUpdatedPayload) => void) =>
  safeListen<MemoryUpdatedPayload>("memory:updated", handler);

export const memorySetEnabled = (enabled: boolean) =>
  safeInvoke<null>("memory_set_enabled", { enabled });

export const memoryUpdate = (memoryId: string, content: string, importance?: number) =>
  safeInvoke<null>("memory_update", { memoryId, content, importance });

export const memoryDelete = (memoryId: string) =>
  safeInvoke<null>("memory_delete", { memoryId });

export const memoryPurge = (profile = "default") =>
  safeInvoke<number | null>("memory_purge", { profile });

export const memoryCreate = (content: string, kind?: string, importance?: number) =>
  safeInvoke<MemoryRecordView | null>("memory_create", { content, kind, importance });

export const memoryExport = () =>
  safeInvoke<string | null>("memory_export");
