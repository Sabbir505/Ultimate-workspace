// Settings → Knowledge: list/manage the user's local document corpora (the
// "Knowledge" RAG layer). Mirrors LocalModelsPanel's folder-picker + chip-row
// pattern but persists corpora through the DB-backed `docs_*` IPC instead of
// the `localModels.folders` setting. The panel shows: sidecar status (model
// installed? running?), the corpus list (each with enabled toggle, counts,
// last-indexed, and Index/Cancel/Delete actions), and the live indexing
// progress emitted by the `docs:index:progress` listener.
//
// Backend contract: src-tauri/src/docs_index.rs (commands) + src/db/docs.rs
// (storage) + src/chat/docs.rs (chunker/walker). The `search_docs` model tool
// is auto-exposed to the chat tool loop only when (a) the embedding sidecar
// is running AND (b) at least one enabled corpus has indexed chunks — both
// computed per turn into ToolCaps.local_docs in chat/mod.rs.

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  docsAddCorpus,
  docsRemoveCorpus,
  docsListCorpora,
  docsSetCorpusEnabled,
  docsStartIndex,
  docsCancelIndex,
  docsEmbeddingStatus,
  onDocsIndexProgress,
  onDocsCorpusUpdated,
  type DocCorpus,
  type DocsEmbeddingStatus,
  type DocsIndexProgressPayload,
} from "../../lib/ipc";
import { useUiStore } from "../../state/ui";

/** Recommended Hugging Face embedding GGUFs — the small set the backend's
 *  `find_embedding_gguf` already prefers (nomic-embed) plus a couple of
 *  well-known alternatives. Clicking a suggestion jumps to Model Market with
 *  the repo id pre-filled so the user can install it in one place. */
const EMBEDDING_SUGGESTIONS: { repo: string; label: string; note: string }[] = [
  {
    repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
    label: "nomic-embed-text-v1.5",
    note: "Recommended · 274 MB Q8_0 · best quality/size",
  },
  {
    repo: "nomic-ai/nomic-embed-text-v1-GGUF",
    label: "nomic-embed-text-v1",
    note: "Older nomic · smaller footprint",
  },
  {
    repo: "CompendiumLabs/bge-small-en-v1.5-gguf",
    label: "bge-small-en-v1.5",
    note: "BAAI bge-small · compact English embeddings",
  },
];

function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shortName(path: string): string {
  // Show the last path segment only if the full path is too long; otherwise
  // keep the full path so users can disambiguate sibling corpora.
  if (path.length <= 56) return path;
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

interface PerCorpusProgress {
  processedFiles: number;
  totalFiles: number;
  chunksWritten: number;
  imagesProcessed: number;
  imagesSkipped: number;
}

export function KnowledgePanel() {
  const setSettingsCategory = useUiStore((s) => s.setSettingsCategory);

  const openModelMarketForEmbedding = () => {
    setSettingsCategory("models");
    // Pre-fill the model market search with a common embedding query. The
    // market panel already supports normal search, so we only need to switch to
    // the right category here.
  };

  const [corpora, setCorpora] = useState<DocCorpus[] | null>(null);
  const [sidecar, setSidecar] = useState<DocsEmbeddingStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // corpusId being mutated
  const [progress, setProgress] = useState<Record<string, PerCorpusProgress>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void docsListCorpora().then((c) => c && setCorpora(c));
    void docsEmbeddingStatus().then((s) => setSidecar(s));
  };
  useEffect(refresh, []);

  // Stream indexing progress + corpus-row updates.
  useEffect(() => {
    const unlistenP = onDocsIndexProgress((p: DocsIndexProgressPayload) => {
      if (p.state === "running") {
        setProgress((prev) => ({
          ...prev,
          [p.corpusId]: {
            processedFiles: p.processedFiles,
            totalFiles: p.totalFiles,
            chunksWritten: p.chunksWritten,
            imagesProcessed: p.imagesProcessed,
            imagesSkipped: p.imagesSkipped,
          },
        }));
      } else {
        setProgress((prev) => {
          const next = { ...prev };
          delete next[p.corpusId];
          return next;
        });
        if (p.state === "done" || p.state === "error" || p.state === "cancelled") {
          // Refresh the row so counts + lastIndexedAt update; also kick a
          // full corpora re-list so the sidecar gating can re-evaluate.
          refresh();
        }
        if (p.state === "error" && p.error) {
          setError(p.error);
        }
      }
    });
    const unlistenU = onDocsCorpusUpdated(() => {
      // The row was updated in the DB (totals/last_indexed_at). Re-fetch.
      refresh();
    });
    return () => {
      void unlistenP.then((fn) => fn());
      void unlistenU.then((fn) => fn());
    };
  }, []);

  const handleAddFolder = async () => {
    setError(null);
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Select a folder to index as a Knowledge corpus",
      });
      if (typeof picked !== "string" || !picked) return;
      setBusy("add");
      await docsAddCorpus(picked);
      await docsListCorpora().then((c) => c && setCorpora(c));
    } catch (err) {
      setError(`Failed to add folder: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (corpusId: string) => {
    if (!window.confirm("Remove this corpus and delete all its chunks?")) return;
    setError(null);
    setBusy(corpusId);
    try {
      await docsRemoveCorpus(corpusId);
      await docsListCorpora().then((c) => c && setCorpora(c));
    } catch (err) {
      setError(`Failed to remove corpus: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleToggleEnabled = async (corpusId: string, enabled: boolean) => {
    setError(null);
    try {
      await docsSetCorpusEnabled(corpusId, enabled);
      setCorpora((prev) =>
        (prev ?? []).map((c) => (c.id === corpusId ? { ...c, enabled } : c)),
      );
    } catch (err) {
      setError(`Failed to toggle corpus: ${String(err)}`);
    }
  };

  const handleStartIndex = async (corpusId: string) => {
    setError(null);
    try {
      await docsStartIndex(corpusId);
    } catch (err) {
      setError(`Failed to start indexing: ${String(err)}`);
    }
  };

  const handleCancelIndex = async (corpusId: string) => {
    setError(null);
    try {
      await docsCancelIndex(corpusId);
    } catch (err) {
      setError(`Failed to cancel indexing: ${String(err)}`);
    }
  };

  const sidecarReady = !!sidecar?.running;
  const hasCorpora = (corpora ?? []).length > 0;
  const hasInstalledModel = !!sidecar?.modelPath;

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Knowledge</h3>
        <button
          className="ghost"
          style={{ padding: "2px 8px" }}
          onClick={() => void handleAddFolder()}
          disabled={busy === "add"}
        >
          + Add folder
        </button>
      </div>

      <p className="settings-note">
        Index local folders of notes, docs, or PDFs into a searchable Knowledge
        Base. The chat assistant can then answer questions from your files via
        the <code>search_docs</code> tool, which is auto-enabled whenever the
        embedding sidecar is running and at least one corpus is indexed.
      </p>

      <div className="settings-note">
        Embedding model:&nbsp;
        {hasInstalledModel ? (
          <>
            <code className="mono" style={{ fontSize: 11 }}>
              {shortName(sidecar?.modelPath ?? "")}
            </code>{" "}
            —{" "}
            {sidecarReady ? (
              <span style={{ color: "var(--success, #3fb950)" }}>running</span>
            ) : (
              <span style={{ color: "var(--warn, #d29922)" }}>
                will start on next index
              </span>
            )}
          </>
        ) : (
          <span style={{ color: "var(--warn, #d29922)" }}>
            not installed —
          </span>
        )}
      </div>

      {!hasInstalledModel && (
        <div className="settings-note" style={{ marginTop: 4 }}>
          <div style={{ marginBottom: 8 }}>
            Install an embedding model from Hugging Face to enable Knowledge:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {EMBEDDING_SUGGESTIONS.map((s) => (
              <button
                key={s.repo}
                type="button"
                className="ghost"
                style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "8px 10px", textAlign: "left" }}
                onClick={openModelMarketForEmbedding}
                title={`Open Model Market to search for ${s.repo}`}
              >
                <span style={{ fontSize: 12, fontWeight: 600 }}>{s.label}</span>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{s.note}</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-dim)" }}>{s.repo}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
          {error}
        </div>
      )}

      {!hasCorpora && !busy && (
        <div className="empty-reserved">
          <div className="empty-text">
            No corpora yet. Click “+ Add folder” to index your first one.
          </div>
        </div>
      )}

      {(corpora ?? []).length > 0 && (
        <div className="corpus-list">
          {(corpora ?? []).map((c) => {
            const prog = progress[c.id];
            const active = !!prog;
            return (
              <div key={c.id} className="corpus-card">
                <div className="corpus-card-head">
                  <div className="corpus-card-title">
                    <label className="corpus-toggle">
                      <input
                        type="checkbox"
                        checked={c.enabled}
                        onChange={(e) =>
                          void handleToggleEnabled(c.id, e.target.checked)
                        }
                      />
                    </label>
                    <span className="corpus-name">{c.name}</span>
                  </div>
                  <div className="corpus-card-actions">
                    {active ? (
                      <button
                        className="ghost"
                        style={{ padding: "2px 8px" }}
                        onClick={() => void handleCancelIndex(c.id)}
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        className="ghost"
                        style={{ padding: "2px 8px" }}
                        onClick={() => void handleStartIndex(c.id)}
                        disabled={busy === c.id}
                      >
                        {c.chunkCount > 0 ? "Re-index" : "Index"}
                      </button>
                    )}
                    <button
                      className="ghost"
                      style={{ padding: "2px 8px", color: "var(--danger)" }}
                      onClick={() => void handleRemove(c.id)}
                      disabled={busy === c.id}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="corpus-card-path mono" title={c.path}>
                  {c.path}
                </div>

                {active ? (
                  <div className="corpus-card-progress">
                    <div className="corpus-bar-track">
                      <div
                        className="corpus-bar-fill"
                        style={{
                          width: prog.totalFiles
                            ? `${Math.min(
                                100,
                                (prog.processedFiles / prog.totalFiles) * 100,
                              )}%`
                            : "10%",
                        }}
                      />
                    </div>
                    <span className="corpus-bar-label">
                      {prog.processedFiles}/{prog.totalFiles} files ·{" "}
                      {prog.chunksWritten} chunks
                      {prog.imagesProcessed > 0 &&
                        ` · ${prog.imagesProcessed} images`}
                    </span>
                  </div>
                ) : (
                  <div className="corpus-card-stats">
                    <span>{c.fileCount} files</span>
                    <span>·</span>
                    <span>{c.chunkCount} chunks</span>
                    <span>·</span>
                    <span>indexed {formatDate(c.lastIndexedAt)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
