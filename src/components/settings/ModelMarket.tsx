// ModelMarket — browse and download GGUF models from the Hugging Face Hub.
// Lives inside the "Local Models" settings panel. The backend command
// (commands::local_model_market) does the HF API call, the streaming
// download with SHA-256 verify, and emits per-download progress events;
// this component is pure presentation + state.
//
// State machine for a single card (per `id`):
//   idle → starting → downloading → verifying → done
//                       ↓
//                  error | cancelled
//
// On `done` the parent Local Models panel is told to rescan so the new
// .gguf shows up in the on-disk list immediately.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  cancelModelDownload,
  clearHuggingFaceToken,
  downloadMmproj,
  fetchModelCatalog,
  getGpuVram,
  getMarketSettings,
  onModelDownloadProgress,
  pickModelsDirectory,
  setHuggingFaceToken,
  setModelsDirectory,
  startModelDownload,
  toastError,
  type CatalogEntry,
  type DownloadProgress,
  type GpuVramInfo,
  type MarketSettings,
  type ModelSort,
} from "../../lib/ipc";
import { Modal } from "../common/Modal";

type SortKey = ModelSort;

const SORT_LABELS: Record<SortKey, string> = {
  trending: "Trending",
  downloads: "Most downloaded",
  likes: "Most liked",
  modified: "Recently updated",
};

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

function formatRate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "—";
  return `${formatBytes(bps)}/s`;
}

interface PerDownload {
  state: DownloadProgress["state"];
  downloaded: number;
  total: number | null;
  bps: number;
  finalPath?: string | null;
  error?: string | null;
}

export interface ModelMarketProps {
  onDownloadComplete: () => void;
  localModels?: { filename: string; name?: string | null }[];
}

export function ModelMarket({ onDownloadComplete, localModels }: ModelMarketProps) {
  const [settings, setSettings] = useState<MarketSettings | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("trending");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenDirty, setTokenDirty] = useState(false);
  const [downloads, setDownloads] = useState<Record<string, PerDownload>>({});
  // Bump on every successful fetch so effect deps stay cheap.
  const [fetchTick, setFetchTick] = useState(0);
  // When non-null, a too-large-for-hardware download is pending user confirmation
  // (bypassable warning). Set by onStartDownload, cleared by the confirm modal.
  const [oversizedConfirm, setOversizedConfirm] = useState<CatalogEntry | null>(null);
  // Memory budget for the "fits my hardware" badge + bypassable warning.
  // VRAM (vendor-agnostic via DXGI on Windows) is the bottleneck for discrete
  // GPUs; we fall back to system RAM for integrated GPUs / no GPU. The probe
  // runs once on mount; the ref holds the resolved budget + a label for display.
  const systemRamRef = useRef<number | null>(null);
  if (systemRamRef.current === null) {
    // Heuristic: navigator.deviceMemory is in GiB and is only set on
    // Chromium-family browsers. Fall back to a sensible default (16 GB)
    // when the API is absent.
    const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    systemRamRef.current = (dm && dm > 0 ? dm : 16) * 1024 * 1024 * 1024;
  }
  // VRAM budget + device name, resolved async from the Rust DXGI probe.
  // When null/0 the market uses systemRamRef (RAM) as the budget instead.
  const [vram, setVram] = useState<{ bytes: number; name: string } | null>(null);
  // The effective budget for ramClass — VRAM when available, else system RAM.
  // Recomputed as a plain value each render (cheap).
  const memoryBudget = vram && vram.bytes > 0 ? vram.bytes : (systemRamRef.current ?? 16 * 1024 * 1024 * 1024);
  const memoryBudgetLabel = vram && vram.bytes > 0
    ? (vram.name || "GPU VRAM")
    : "system RAM";

  // Load settings, probe GPU VRAM, and fetch the trending catalog on mount.
  useEffect(() => {
    let stale = false;
    void (async () => {
      const s = await getMarketSettings();
      if (!stale) setSettings(s);
      // VRAM probe (vendor-agnostic DXGI). Null/zero → fall back to RAM budget.
      const gpu = await getGpuVram();
      if (!stale && gpu && gpu.totalVramBytes && gpu.totalVramBytes > 0) {
        setVram({ bytes: gpu.totalVramBytes, name: gpu.deviceName ?? "" });
      }
      await doFetch("", "trending");
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to download-progress events. The unsubscribe is async but
  // the component unmount path uses a stale flag in the effect closure.
  useEffect(() => {
    let stale = false;
    let unlisten: (() => void) | null = null;
    void onModelDownloadProgress((p) => {
      if (stale) return;
      setDownloads((prev) => ({
        ...prev,
        [p.id]: {
          state: p.state,
          downloaded: p.downloadedBytes,
          total: p.totalBytes ?? null,
          bps: p.bytesPerSecond,
          finalPath: p.finalPath,
          error: p.error,
        },
      }));
      if (p.state === "done") {
        onDownloadComplete();
        // Auto-fetch the mmproj for vision-capable models. The
        // main .gguf just finished; the projector is what makes the
        // model actually accept image inputs in the chat. The mmproj
        // download fires its own progress events with id
        // "{repo}::mmproj::...", so the user's card list will show a
        // second in-progress entry next to the now-done one.
        if (p.id.startsWith("vision::") || p.id.includes("::mmproj::") === false) {
          // The leading "vision::" prefix is a tag the card sets when
          // it kicks off a vision download (see onStartDownload).
          // Otherwise: any non-mmproj completion that looks like a
          // catalog id ({repo}::{filename}) might be a vision model
          // and we should try the mmproj fetch.
          const sep = p.id.indexOf("::");
          if (sep > 0) {
            const repoId = p.id.slice(0, sep);
            const filename = p.id.slice(sep + 2);
            const card = entries.find(
              (e) => e.id === p.id || (e.repoId === repoId && e.filename === filename),
            );
            if (card?.vision) {
              // Idempotent: backend short-circuits if already in-flight.
              void downloadMmproj(card.repoId).catch((e) =>
                toastError(`Vision companion (mmproj) download failed for ${card.filename}`, e),
              );
            }
          }
        }
      }
    }).then((u) => {
      if (stale) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      stale = true;
      unlisten?.();
    };
  }, [onDownloadComplete]);

  const doFetch = async (q: string, s: SortKey) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchModelCatalog({ query: q, sort: s, limit: 60 });
      if (!res) {
        setEntries([]);
        setLoadError("Catalog unavailable (Tauri runtime not detected).");
        return;
      }
      setEntries(res.entries);
      setSettings((prev) =>
        prev
          ? { ...prev, hasHuggingFaceToken: res.hasHuggingFaceToken }
          : prev,
      );
    } catch (e) {
      console.error("[ModelMarket] fetch error:", e);
      setLoadError(e instanceof Error ? e.message : String(e));
      setEntries([]);
    } finally {
      setLoading(false);
      setFetchTick((t) => t + 1);
    }
  };

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void doFetch(query, sort);
  };

  const onSortChange = (s: SortKey) => {
    setSort(s);
    void doFetch(query, s);
  };

  const onPickDir = async () => {
    const picked = await pickModelsDirectory();
    if (picked) {
      await setModelsDirectory(picked);
      const s = await getMarketSettings();
      setSettings(s);
    }
  };

  const onSaveToken = async () => {
    if (!tokenInput.trim()) return;
    await setHuggingFaceToken(tokenInput.trim());
    setTokenInput("");
    setTokenDirty(false);
    const s = await getMarketSettings();
    setSettings(s);
    void doFetch(query, sort);
  };

  const onClearToken = async () => {
    await clearHuggingFaceToken();
    const s = await getMarketSettings();
    setSettings(s);
    void doFetch(query, sort);
  };

  const doDownload = (e: CatalogEntry) => {
    // Surface a failed START (gated repo, disk error, invalid dest) — the
    // download row only appears once the backend accepts the job, so without
    // this a rejected invoke left the user staring at an unchanged card.
    void startModelDownload({
      id: e.id,
      repoId: e.repoId,
      filename: e.filename,
      downloadUrl: e.downloadUrl,
      expectedSha256: e.sha256,
      destDir: settings?.modelsDir ?? undefined,
    }).catch((err) => toastError(`Couldn't start download: ${e.filename}`, err));
  };

  const onStartDownload = (e: CatalogEntry) => {
    if (downloads[e.id]?.state === "downloading" || downloads[e.id]?.state === "starting") {
      void cancelModelDownload(e.id);
      return;
    }
    // Bypassable warning for models that look too large for the detected RAM.
    // The user can confirm and download anyway; we don't hard-block it.
    if (ramClass(e.sizeBytes, memoryBudget) === "too_large") {
      setOversizedConfirm(e);
      return;
    }
    doDownload(e);
  };

  return (
    <div className="model-market">
      <div className="model-market-toolbar">
        <form onSubmit={onSearchSubmit} className="model-market-search">
          <input
            type="text"
            placeholder="Search Hugging Face GGUF models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <button type="submit" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </form>
        <div className="model-market-sort">
          <label>
            <span>Sort</span>
            <select
              value={sort}
              onChange={(e) => onSortChange(e.target.value as SortKey)}
              disabled={loading}
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="model-market-settings">
        <div className="model-market-row">
          <span className="model-market-label">Download to</span>
          <code className="model-market-path" title={settings?.modelsDir ?? ""}>
            {settings?.modelsDir ?? settings?.defaultModelsDir ?? "—"}
          </code>
          <button className="ghost" onClick={() => void onPickDir()}>
            Change…
          </button>
        </div>
        <div className="model-market-row">
          <span className="model-market-label">Hugging Face token</span>
          {settings?.hasHuggingFaceToken ? (
            <>
              <span className="model-market-badge">Configured</span>
              <button className="ghost" onClick={() => void onClearToken()}>
                Clear
              </button>
            </>
          ) : (
            <>
              <input
                type="password"
                placeholder="hf_… (optional — needed for gated models)"
                value={tokenInput}
                onChange={(e) => {
                  setTokenInput(e.target.value);
                  setTokenDirty(true);
                }}
              />
              <button
                className="ghost"
                onClick={() => void onSaveToken()}
                disabled={!tokenDirty || !tokenInput.trim()}
              >
                Save
              </button>
            </>
          )}
        </div>
      </div>

      {loadError && (
        <div className="model-market-error">
          Could not load catalog: {loadError}
        </div>
      )}

      <div className="model-market-grid" data-fetch-tick={fetchTick}>
        {loading && entries.length === 0 && (
          <div className="empty-reserved">
            <span className="local-spinner" />
            <span className="empty-text">Loading catalog from Hugging Face…</span>
          </div>
        )}
        {entries.length === 0 && !loading && !loadError && (
          <div className="empty-reserved">
            <span className="empty-text">
              No models to show. Try a different search term or sort.
            </span>
          </div>
        )}
        {(() => {
          // Group by repo, dedup, and collect available quants
          const byRepo = new Map<string, { entries: CatalogEntry[]; quants: { label: string; entry: CatalogEntry }[] }>();
          for (const e of entries) {
            const group = byRepo.get(e.repoId) || { entries: [], quants: [] };
            group.entries.push(e);
            if (e.quantization) {
              group.quants.push({ label: e.quantization, entry: e });
            }
            byRepo.set(e.repoId, group);
          }
          // Pick best entry per repo (prefer Q4_K_M)
          const deduped: CatalogEntry[] = [];
          for (const [, group] of byRepo) {
            const best = group.entries.reduce((a, b) => {
              const aQ4 = (a.quantization || "").toLowerCase().includes("q4_k_m");
              const bQ4 = (b.quantization || "").toLowerCase().includes("q4_k_m");
              if (aQ4 !== bQ4) return aQ4 ? a : b;
              return (b.sizeBytes || 0) > (a.sizeBytes || 0) ? b : a;
            });
            deduped.push(best);
          }
          return deduped.map((e) => {
            const isDownloaded = localModels?.some((m) =>
              (m.filename && e.filename === m.filename) ||
              (m.name && e.displayName && m.name.includes(e.displayName.split(" ").slice(0, 3).join(" ")))
            );
            const quants = byRepo.get(e.repoId)?.quants || [];
            return (
              <ModelCard
                key={e.repoId}
                entry={e}
                download={downloads[e.id]}
                totalRam={memoryBudget}
                isDownloaded={!!isDownloaded}
                availableQuants={quants}
                onAction={(entry) => onStartDownload(entry)}
              />
            );
          });
        })()}
      </div>

      {/* Bypassable warning for models that exceed detected hardware. */}
      {oversizedConfirm && (
        <Modal
          title="Large model for your hardware"
          onClose={() => setOversizedConfirm(null)}
          actions={
            <>
              <button className="ghost" onClick={() => setOversizedConfirm(null)}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={() => {
                  doDownload(oversizedConfirm);
                  setOversizedConfirm(null);
                }}
              >
                Download anyway
              </button>
            </>
          }
        >
          <div className="oversized-warning">
            <p>
              <strong>{oversizedConfirm.displayName || oversizedConfirm.filename}</strong> is{" "}
              {formatBytes(oversizedConfirm.sizeBytes)}, which may exceed your detected{" "}
              {memoryBudgetLabel} (~{formatBytes(memoryBudget)}). It may run slowly, cause
              swapping, or fail to load at runtime.
            </p>
            <p className="muted">You can still download it — this is just a heads-up.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ramClass(sizeBytes: number, totalRam: number): "fits" | "tight" | "too_large" {
  if (!totalRam) return "tight";
  const r = sizeBytes / totalRam;
  if (r < 0.5) return "fits";
  if (r < 0.8) return "tight";
  return "too_large";
}

interface ModelCardProps {
  entry: CatalogEntry;
  download: PerDownload | undefined;
  totalRam: number;
  isDownloaded: boolean;
  availableQuants: { label: string; entry: CatalogEntry }[];
  onAction: (entry: CatalogEntry) => void;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 86400000) return "Today";
  if (diff < 172800000) return "Yesterday";
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  if (diff < 2592000000) return `${Math.floor(diff / 604800000)}w ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ModelCard({ entry, download, totalRam, isDownloaded, availableQuants, onAction }: ModelCardProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedQuantEntry, setSelectedQuantEntry] = useState<CatalogEntry>(entry);
  const activeEntry = selectedQuantEntry || entry;
  const [quantsExpanded, setQuantsExpanded] = useState(false);
  const visibleQuants = quantsExpanded ? availableQuants : availableQuants.slice(0, 5);
  const ram = ramClass(activeEntry.sizeBytes, totalRam);
  const ramLabel = ram === "fits" ? "Fits" : ram === "tight" ? "Tight fit" : "Too large";
  const ramColor = ram === "fits" ? "var(--green)" : ram === "tight" ? "var(--yellow)" : "var(--red)";
  const state = download?.state;
  const pct = download?.total && download.total > 0
    ? Math.min(100, Math.round((download.downloaded / download.total) * 100))
    : null;

  const actionLabel = useMemo(() => {
    if (!state || state === "done" || state === "cancelled" || state === "error") return "Download";
    if (state === "starting") return "Starting…";
    if (state === "downloading") return "Cancel";
    if (state === "verifying") return "Verifying…";
    return "Download";
  }, [state]);

  const isDone = state === "done";
  const isActive = state && state !== "done" && state !== "cancelled" && state !== "error";
  const isError = state === "error";

  // Extract structured info from tags
  const tags = entry.tags || [];
  const pipelineTag = tags.find((t) => ["text-generation", "feature-extraction", "text-to-image", "automatic-speech-recognition", "image-text-to-text", "text-classification", "token-classification", "question-answering", "translation", "summarization", "fill-mask", "sentence-similarity", "image-classification", "object-detection", "image-segmentation", "text-to-speech", "visual-question-answering", "document-question-answering"].includes(t));
  const library = tags.find((t) => ["transformers", "sentence-transformers", "diffusers", "gguf", "mlx", "transformers.js", "llama.cpp"].includes(t));
  const baseModel = tags.find((t) => t.startsWith("base_model:"))?.replace("base_model:", "");

  return (
    <>
      <div
        className={`model-card${isActive ? " downloading" : ""}${isDone ? " done" : ""}${isError ? " errored" : ""}`}
        onClick={() => { if (!isActive) setDetailOpen(true); }}
      >
        {/* Header: avatar + name + stats */}
        <div className="model-card-header">
          <div className="model-card-avatar">
            {entry.author ? entry.author.charAt(0).toUpperCase() : "?"}
          </div>
          <div className="model-card-header-info">
            <div className="model-card-name" title={entry.displayName}>{entry.displayName}</div>
            <div className="model-card-repo" title={entry.repoId}>
              {entry.author || "Unknown"}/{entry.repoId.split("/").slice(1).join("/") || entry.repoId}
            </div>
          </div>
          <div className="model-card-stats">
            <span className="model-card-stat" title={`${entry.downloads.toLocaleString()} downloads`}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              {fmtNum(entry.downloads)}
            </span>
            <span className="model-card-stat" title={`${entry.likes.toLocaleString()} likes`}>
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
              {fmtNum(entry.likes)}
            </span>
          </div>
        </div>

        {/* Tags + quant selector */}
        <div className="model-card-tags">
          {entry.paramsLabel && <span className="model-card-tag params">{entry.paramsLabel}</span>}
          {availableQuants.length > 1 ? (
            <>
              {visibleQuants.map((q) => (
                <span
                  key={q.entry.filename}
                  className={`model-card-tag quant${q.entry.filename === activeEntry.filename ? " active" : ""}`}
                  onClick={(e) => { e.stopPropagation(); setSelectedQuantEntry(q.entry); }}
                  title={`${q.label} — ${formatBytes(q.entry.sizeBytes)}`}
                  style={{ cursor: "pointer" }}
                >
                  {q.label}
                </span>
              ))}
              {availableQuants.length > 5 && (
                <span
                  className="model-card-tag quant"
                  onClick={(e) => { e.stopPropagation(); setQuantsExpanded(!quantsExpanded); }}
                  style={{ cursor: "pointer" }}
                >
                  {quantsExpanded ? "▲ less" : `+${availableQuants.length - 5} more`}
                </span>
              )}
            </>
          ) : entry.quantization ? (
            <span className="model-card-tag quant">{entry.quantization}</span>
          ) : null}
          <span className="model-card-tag size">{formatBytes(activeEntry.sizeBytes)}</span>
          {pipelineTag && <span className="model-card-tag pipeline">{pipelineTag}</span>}
          {library && <span className="model-card-tag library">{library}</span>}
          {baseModel && <span className="model-card-tag base" title={baseModel}>Based on {baseModel.split("/").pop()}</span>}
          {entry.vision && <span className="model-card-tag vision">Vision</span>}
          <span className="model-card-tag ram" style={{ color: ramColor, borderColor: ramColor }}>{ramLabel}</span>
          {fmtDate(entry.lastModified) && <span className="model-card-tag updated">Updated {fmtDate(entry.lastModified)}</span>}
        </div>

        {/* Description */}
        {entry.description && <div className="model-card-desc">{entry.description}</div>}

        {/* Progress */}
        {isActive && (
          <div className="model-card-progress">
            <div className="model-card-progress-bar"><div className="model-card-progress-fill" style={{ width: `${pct ?? 0}%` }} /></div>
            <div className="model-card-progress-info">
              <span>{pct !== null ? `${pct}% · ` : ""}{formatBytes(download?.downloaded ?? 0)}{download?.total ? ` / ${formatBytes(download.total)}` : ""}</span>
              <span>{formatRate(download?.bps ?? 0)}</span>
            </div>
          </div>
        )}

        {/* Status */}
        {isDone && <div className="model-card-status done">✓ Downloaded · Ready to use</div>}
        {state === "cancelled" && <div className="model-card-status cancelled">Cancelled</div>}
        {isError && <div className="model-card-status error">{download?.error ?? "Download failed"}</div>}

        {/* Action */}
        <div className="model-card-actions">
          {isDownloaded && !isActive ? (
            <div className="model-card-status done" style={{ margin: 0, flex: 1, textAlign: "center" }}>
              ✓ Already downloaded · Ready to use
            </div>
          ) : (
            <button className="primary" onClick={(e) => { e.stopPropagation(); onAction(activeEntry); }} disabled={state === "starting" || state === "verifying"}>
              {isActive ? `${pct ?? 0}%` : actionLabel}
            </button>
          )}
        </div>
      </div>

      {/* Detail modal */}
      {detailOpen && (
        <Modal
          title={entry.displayName}
          onClose={() => setDetailOpen(false)}
          actions={
            isDownloaded && !isActive ? (
              <div className="model-card-status done" style={{ margin: 0, textAlign: "center", flex: 1 }}>✓ Already downloaded and ready</div>
            ) : (
              <button className="primary" onClick={(e) => { onAction(activeEntry); setDetailOpen(false); }} disabled={state === "starting" || state === "verifying"}>
                {actionLabel} ({formatBytes(activeEntry.sizeBytes)})
              </button>
            )
          }
        >
          <div className="model-detail-modal">
            <div className="model-detail-hero">
              <div className="model-detail-avatar-lg">{entry.author ? entry.author.charAt(0).toUpperCase() : "?"}</div>
              <div>
                <div className="model-detail-repo">{entry.author || "Unknown"} / {entry.repoId.split("/").slice(1).join("/")}</div>
                <div className="model-detail-stats">
                  <span>↓ {entry.downloads.toLocaleString()} downloads</span>
                  <span>♥ {entry.likes.toLocaleString()} likes</span>
                </div>
              </div>
            </div>
            {entry.description && <p className="model-detail-desc">{entry.description}</p>}
            {availableQuants.length > 1 && (
              <div className="model-detail-quants">
                <span className="model-detail-quants-label">Quantization ({availableQuants.length}):</span>
                <div className="model-detail-quants-list">
                  {(quantsExpanded ? availableQuants : availableQuants.slice(0, 5)).map((q) => (
                    <span
                      key={q.entry.filename}
                      className={`model-card-tag quant${q.entry.filename === activeEntry.filename ? " active" : ""}`}
                      onClick={() => setSelectedQuantEntry(q.entry)}
                      style={{ cursor: "pointer" }}
                    >
                      {q.label} ({formatBytes(q.entry.sizeBytes)})
                    </span>
                  ))}
                  {availableQuants.length > 5 && (
                    <span
                      className="model-card-tag quant"
                      onClick={() => setQuantsExpanded(!quantsExpanded)}
                      style={{ cursor: "pointer" }}
                    >
                      {quantsExpanded ? "▲ less" : `+${availableQuants.length - 5} more`}
                    </span>
                  )}
                </div>
              </div>
            )}
            <div className="model-detail-grid">
              <div className="model-detail-item"><span className="model-detail-item-label">Size</span><span className="model-detail-item-value mono">{formatBytes(activeEntry.sizeBytes)}</span></div>
              <div className="model-detail-item"><span className="model-detail-item-label">Parameters</span><span className="model-detail-item-value">{entry.paramsLabel || "—"}</span></div>
              <div className="model-detail-item"><span className="model-detail-item-label">Quantization</span><span className="model-detail-item-value">{entry.quantization || "—"}</span></div>
              <div className="model-detail-item"><span className="model-detail-item-label">License</span><span className="model-detail-item-value">{entry.license || "—"}</span></div>
              <div className="model-detail-item"><span className="model-detail-item-label">RAM Fit</span><span className="model-detail-item-value" style={{ color: ramColor }}>{ramLabel}</span></div>
              <div className="model-detail-item"><span className="model-detail-item-label">Pipeline</span><span className="model-detail-item-value" style={{ textTransform: "capitalize" }}>{pipelineTag || "—"}</span></div>
              <div className="model-detail-item"><span className="model-detail-item-label">Library</span><span className="model-detail-item-value">{library || "—"}</span></div>
              <div className="model-detail-item"><span className="model-detail-item-label">Downloads</span><span className="model-detail-item-value">{fmtNum(entry.downloads)}</span></div>
              <div className="model-detail-item"><span className="model-detail-item-label">Likes</span><span className="model-detail-item-value">{fmtNum(entry.likes)}</span></div>
              {entry.lastModified && <div className="model-detail-item"><span className="model-detail-item-label">Updated</span><span className="model-detail-item-value">{fmtDate(entry.lastModified)}</span></div>}
              {baseModel && <div className="model-detail-item"><span className="model-detail-item-label">Base Model</span><span className="model-detail-item-value">{baseModel}</span></div>}
              {entry.vision && <div className="model-detail-item"><span className="model-detail-item-label">Vision</span><span className="model-detail-item-value" style={{ color: "#a78bfa" }}>✓ Multimodal</span></div>}
              {tags.length > 0 && <div className="model-detail-item" style={{ gridColumn: "1 / -1" }}><span className="model-detail-item-label">Tags</span><span className="model-detail-item-value">{tags.slice(0, 10).join(", ")}</span></div>}
            </div>
            {entry.sha256 && <div className="model-detail-sha">SHA-256: <code>{entry.sha256.slice(0, 32)}…</code></div>}
          </div>
        </Modal>
      )}
    </>
  );
}
