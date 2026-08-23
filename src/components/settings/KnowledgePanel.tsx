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

import { useEffect, useMemo, useState } from "react";
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
  cancelModelDownload,
  fetchModelCatalog,
  fetchModelFileSizes,
  getGpuVram,
  onModelDownloadProgress,
  startModelDownload,
  toastError,
  toastSuccess,
  type CatalogEntry,
  type DocCorpus,
  type DocsEmbeddingStatus,
  type DocsIndexProgressPayload,
  type DownloadProgress,
} from "../../lib/ipc";
import { Modal } from "../common/Modal";

/** Recommended Hugging Face embedding GGUFs — the small set the backend's
 *  `find_embedding_gguf` already prefers (nomic-embed) plus a couple of
 *  well-known alternatives. Clicking a suggestion jumps to Model Market with
 *  the repo id pre-filled so the user can install it in one place. */
const EMBEDDING_SUGGESTIONS: { repo: string; label: string; note: string }[] = [
  {
    repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
    label: "nomic-embed-text-v1.5",
    note: "Recommended · best quality/size",
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

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function fitClass(sizeBytes: number, budget: number): "fits" | "tight" | "too_large" {
  if (!budget) return "tight";
  const r = sizeBytes / budget;
  if (r < 0.5) return "fits";
  if (r < 0.8) return "tight";
  return "too_large";
}

interface PerDownloadState {
  state: DownloadProgress["state"];
  downloaded: number;
  total: number | null;
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
  const [corpora, setCorpora] = useState<DocCorpus[] | null>(null);
  const [sidecar, setSidecar] = useState<DocsEmbeddingStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // corpusId being mutated
  const [progress, setProgress] = useState<Record<string, PerCorpusProgress>>({});
  const [error, setError] = useState<string | null>(null);

  // --- Embedding suggestions → real catalog entries → detail modal + install.
  // Per-suggestion catalog: real HF entries (filename/size/sha/downloadUrl)
  // fetched by exact repo id so Download uses the same pipeline as the Model
  // Market. `selected` = chosen quant variant; `detailOpen` shows the sheet.
  const [suggestions, setSuggestions] = useState<
    Record<string, { entries: CatalogEntry[]; selected: CatalogEntry | null; loading: boolean }>
  >({});
  const [detailRepo, setDetailRepo] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Record<string, PerDownloadState>>({});
  // Memory budget for the fit dot (same heuristic as the market).
  const [memoryBudget, setMemoryBudget] = useState(16 * 1024 * 1024 * 1024);

  const refresh = () => {
    void docsListCorpora().then((c) => c && setCorpora(c));
    void docsEmbeddingStatus().then((s) => setSidecar(s));
  };
  useEffect(refresh, []);

  // Fetch the real catalog entries for each suggested repo once, and probe
  // VRAM for the fit dots. Only useful when no model is installed yet.
  useEffect(() => {
    let stale = false;
    void getGpuVram().then((gpu) => {
      if (!stale && gpu?.totalVramBytes && gpu.totalVramBytes > 0) {
        setMemoryBudget(gpu.totalVramBytes);
      }
    });
    for (const s of EMBEDDING_SUGGESTIONS) {
      setSuggestions((prev) =>
        prev[s.repo] ? prev : { ...prev, [s.repo]: { entries: [], selected: null, loading: true } },
      );
      void fetchModelCatalog({ query: s.repo, sort: "downloads", limit: 12 })
        .then(async (res) => {
          if (stale) return;
          let entries = (res?.entries ?? []).filter((e) => e.repoId === s.repo && e.sizeBytes > 0);
          // The catalog listing carries ESTIMATED sizes (HF's models API has no
          // per-file sizes); correct them from the repo tree endpoint.
          try {
            const sizes = await fetchModelFileSizes(s.repo);
            if (stale || !sizes) return;
            entries = entries.map((e) =>
              sizes[e.filename] ? { ...e, sizeBytes: sizes[e.filename] } : e,
            );
          } catch {
            /* estimates are fine as a fallback */
          }
          // Prefer the smallest sensible default (Q8_0 first — the backend
          // recommendation note — then smallest overall).
          const q8 = entries.find((e) => (e.quantization ?? "").toUpperCase().includes("Q8"));
          const best = q8 ?? [...entries].sort((a, b) => a.sizeBytes - b.sizeBytes)[0] ?? null;
          setSuggestions((prev) => ({
            ...prev,
            [s.repo]: { entries, selected: best, loading: false },
          }));
        })
        .catch(() => {
          if (!stale) {
            setSuggestions((prev) => ({ ...prev, [s.repo]: { entries: [], selected: null, loading: false } }));
          }
        });
    }
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the market's progress stream: live bars in the detail sheet, and a
  // status refresh on completion (the downloaded file lands in the models dir,
  // where find_embedding_gguf picks it up for indexing automatically).
  useEffect(() => {
    let stale = false;
    let unlisten: (() => void) | null = null;
    void onModelDownloadProgress((p) => {
      if (stale) return;
      setDownloads((prev) => ({
        ...prev,
        [p.id]: { state: p.state, downloaded: p.downloadedBytes, total: p.totalBytes ?? null },
      }));
      if (p.state === "done") {
        toastSuccess("Embedding model installed");
        refresh();
      }
      if (p.state === "error" && p.error) {
        toastError("Embedding model download failed", p.error);
      }
    }).then((u) => {
      if (stale) u();
      else unlisten = u;
    });
    return () => {
      stale = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // A suggestion counts as installed when the discovered embedding model's
  // path contains its repo-name fragment ("nomic-embed-text-v1.5", …).
  const isSuggestionInstalled = (repo: string): boolean => {
    if (!sidecar?.modelPath) return false;
    const fragment = repo.split("/").pop()?.replace(/-gguf$/i, "").toLowerCase() ?? "";
    return fragment.length > 0 && sidecar.modelPath.toLowerCase().includes(fragment);
  };

  const handleDownloadEmbedding = (entry: CatalogEntry) => {
    void startModelDownload({
      id: entry.id,
      repoId: entry.repoId,
      filename: entry.filename,
      downloadUrl: entry.downloadUrl,
      expectedSha256: entry.sha256,
      destDir: undefined, // configured models dir — find_embedding_gguf scans it
    }).catch((err) => toastError(`Couldn't start download: ${entry.filename}`, err));
  };

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
            {EMBEDDING_SUGGESTIONS.map((s) => {
              const sug = suggestions[s.repo];
              const sel = sug?.selected ?? null;
              const installed = isSuggestionInstalled(s.repo);
              const dl = sel ? downloads[sel.id] : undefined;
              const active = !!dl && dl.state !== "done" && dl.state !== "cancelled" && dl.state !== "error";
              const pct = dl?.total ? Math.min(100, Math.round((dl.downloaded / dl.total) * 100)) : null;
              return (
                <button
                  key={s.repo}
                  type="button"
                  className="ghost knowledge-suggestion"
                  onClick={() => setDetailRepo(s.repo)}
                  title={`View details for ${s.repo}`}
                >
                  <span className="knowledge-suggestion-main">
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{s.label}</span>
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{s.note}</span>
                  </span>
                  {installed ? (
                    <span className="fit-badge fits" style={{ flexShrink: 0 }}>✓ Installed</span>
                ) : active ? (
                    <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
                      {pct !== null ? `${pct}%` : "downloading…"}
                    </span>
                  ) : sel || sug?.loading ? (
                    <span className="knowledge-suggestion-size mono">
                      {sug?.loading ? "…" : formatBytes(sel!.sizeBytes)}
                    </span>
                  ) : null}
                </button>
              );
            })}
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

      {/* Embedding-model detail sheet — same visual language as the Model
          Market's detail page: hero, quant variant rows with fit dots, and a
          download action fed by the shared download-progress stream. */}
      {(() => {
        const meta = EMBEDDING_SUGGESTIONS.find((s) => s.repo === detailRepo);
        if (!meta) return null;
        const sug = suggestions[meta.repo];
        const sel = sug?.selected ?? null;
        const installed = isSuggestionInstalled(meta.repo);
        const dl = sel ? downloads[sel.id] : undefined;
        const active = !!dl && dl.state !== "done" && dl.state !== "cancelled" && dl.state !== "error";
        const done = dl?.state === "done" || installed;
        const pct = dl?.total ? Math.min(100, Math.round((dl.downloaded / dl.total) * 100)) : null;
        const variants = [...(sug?.entries ?? [])].sort((a, b) => a.sizeBytes - b.sizeBytes);
        return (
          <Modal
            title={meta.label}
            onClose={() => setDetailRepo(null)}
            actions={
              done ? (
                <div className="model-card-status done" style={{ margin: 0, flex: 1, textAlign: "center" }}>
                  ✓ Installed — ready for indexing
                </div>
              ) : active ? (
                <button
                  className="ghost"
                  onClick={() => sel && void cancelModelDownload(sel.id)}
                  style={{ flex: 1 }}
                >
                  Cancel download{pct !== null ? ` (${pct}%)` : ""}
                </button>
              ) : (
                <button
                  className="primary cta-strong"
                  style={{ flex: 1 }}
                  disabled={!sel || sug?.loading}
                  onClick={() => sel && handleDownloadEmbedding(sel)}
                >
                  {sel ? `Download (${formatBytes(sel.sizeBytes)})` : "Loading…"}
                </button>
              )
            }
          >
            <div className="model-detail-modal">
              <div className="model-detail-hero">
                <div className="model-detail-avatar-lg">E</div>
                <div>
                  <div className="model-detail-repo">{meta.repo}</div>
                  <div className="model-detail-stats">
                    <span>{meta.note}</span>
                  </div>
                </div>
              </div>
              <p className="model-detail-desc">
                Embedding model for the Knowledge Base. After download it is detected
                automatically and used to index your corpora.
              </p>
              {variants.length > 0 && (
                <div className="model-detail-quants">
                  <span className="model-detail-quants-label">Variant — pick a quantization</span>
                  <div className="model-detail-quant-list">
                    {variants.map((e) => {
                      const fc = fitClass(e.sizeBytes, memoryBudget);
                      const selected = sel?.filename === e.filename;
                      const eDl = downloads[e.id];
                      const eActive = !!eDl && eDl.state !== "done" && eDl.state !== "cancelled" && eDl.state !== "error";
                      return (
                        <button
                          key={e.filename}
                          type="button"
                          className={`model-detail-quant-row${selected ? " active" : ""}`}
                          onClick={() =>
                            setSuggestions((prev) => ({
                              ...prev,
                              [meta.repo]: { entries: variants, selected: e, loading: false },
                            }))
                          }
                        >
                          <span
                            className={`fit-dot ${fc}`}
                            title={fc === "fits" ? "Fits memory" : fc === "tight" ? "Tight fit" : "Too large"}
                          />
                          <span className="q-label">{e.quantization || formatBytes(e.sizeBytes)}</span>
                          <span className="q-size">{formatBytes(e.sizeBytes)}</span>
                          {installed && <span className="fit-badge fits">✓ Installed</span>}
                          {!installed && eActive && (
                            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>downloading…</span>
                          )}
                          {selected && !installed && !eActive && <span className="q-check">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {active && (
                <div className="model-market-grid">
                  <div className="model-card-progress" style={{ padding: 0 }}>
                    <div className="model-card-progress-bar">
                      <div className="model-card-progress-fill" style={{ width: `${pct ?? 0}%` }} />
                    </div>
                    <div className="model-card-progress-info">
                      <span>{pct !== null ? `${pct}% · ` : ""}{formatBytes(dl?.downloaded ?? 0)}{dl?.total ? ` / ${formatBytes(dl.total)}` : ""}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}
