// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";
import { DocCorpus, DocsEmbeddingStatus, DocsIndexProgressPayload } from "../ipc";

// ---- Local Knowledge (RAG corpora) ----
//
// Backend contract lives in src-tauri/src/docs_index.rs and src/db/docs.rs.
// Commands are registered in src-tauri/src/lib.rs::invoke_handler.
// The `search_docs` model tool (auto-exposed when the sidecar is up and at
// least one corpus is indexed) consumes these corpora from the chat tool loop
// — see src-tauri/src/chat/tools/mod.rs SEARCH_DOCS + ToolCaps.local_docs.

export const docsEmbeddingStatus = () =>
  safeInvoke<DocsEmbeddingStatus | null>("docs_embedding_status");

/** Add a folder as a corpus. The backend canonicalises the path and rejects
 *  re-adds of an already-indexed folder; `name` defaults to the folder's
 *  last segment when omitted. */
export const docsAddCorpus = (path: string, name?: string) =>
  safeInvoke<DocCorpus | null>("docs_add_corpus", {
    path,
    name: name ?? null,
  });

export const docsRemoveCorpus = (corpusId: string) =>
  safeInvoke<void>("docs_remove_corpus", { corpusId });

export const docsListCorpora = () =>
  safeInvoke<DocCorpus[] | null>("docs_list_corpora");

export const docsSetCorpusEnabled = (corpusId: string, enabled: boolean) =>
  safeInvoke<void>("docs_set_corpus_enabled", { corpusId, enabled });

/** Start an index run for one corpus. Returns once the run is queued — actual
 *  progress arrives via `onDocsIndexProgress`. */
export const docsStartIndex = (corpusId: string) =>
  safeInvoke<void>("docs_start_index", { corpusId });

export const docsCancelIndex = (corpusId: string) =>
  safeInvoke<boolean>("docs_cancel_index", { corpusId });

// ── Per-chat document attachment (§3.1.7) ────────────────────────────────
// Pin a corpus to a chat session so its chunks are ALWAYS in that chat's
// auto-retrieval context, regardless of the query.
export const docsAttachCorpusToChat = (chatSessionId: string, corpusId: string) =>
  safeInvoke<void>("docs_attach_corpus_to_chat", { chatSessionId, corpusId });

export const docsDetachCorpusFromChat = (chatSessionId: string, corpusId: string) =>
  safeInvoke<void>("docs_detach_corpus_from_chat", { chatSessionId, corpusId });

export const docsAttachedCorpusIds = (chatSessionId: string) =>
  safeInvoke<string[] | null>("docs_attached_corpus_ids", { chatSessionId });

/** Stream `docs:index:progress` events for an in-flight index run. */
export const onDocsIndexProgress = (
  handler: (p: DocsIndexProgressPayload) => void,
) =>
  safeListen<DocsIndexProgressPayload>("docs:index:progress", handler);

/** Emitted by the backend when a corpus row's totals change (counts /
 *  lastIndexedAt updated after an index run finishes). The UI re-fetches the
 *  row to refresh the displayed counts. */
export const onDocsCorpusUpdated = (
  handler: (corpusId: string) => void,
) =>
  safeListen<DocCorpus>("docs:corpus:updated", (c) => handler(c.id));
