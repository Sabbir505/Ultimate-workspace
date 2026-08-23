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

// Session-wide cache of real per-repo GGUF sizes fetched from HF's tree
// endpoint. The catalog listing only carries estimates (the models API has no
// per-sibling sizes), so we correct the visible page lazily: one small HTTP
// call per repo, capped concurrency, cached for the app session.
const fileSizeCache = new Map<string, Record<string, number>>();

// Client-side pseudo-entry in the sort dropdown: filters out models that
// exceed the detected memory budget and orders the rest smallest-first.
// The backend fetch still uses "trending" — the filter/sort is local.
const FITS_SORT = "fits";
type UiSortKey = SortKey | typeof FITS_SORT;

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
  const [uiSort, setUiSort] = useState<UiSortKey>("trending");
  // Backend-facing sort: the "fits" pseudo-entry fetches with "trending" and
  // does its filtering/sorting client-side below.
  const sort: SortKey = uiSort === FITS_SORT ? "trending" : uiSort;
  const hideOversized = uiSort === FITS_SORT;
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  // True when the backend served a cached catalog because huggingface.co
  // was unreachable — renders an offline hint instead of an error.
  const [staleCatalog, setStaleCatalog] = useState(false);
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
      // Cached copy served because huggingface.co was unreachable — keep
      // the list but flag it instead of showing a dead error banner.
      setStaleCatalog(res.stale === true);
      setSettings((prev) =>
        prev
          ? { ...prev, hasHuggingFaceToken: res.hasHuggingFaceToken }
          : prev,
      );
    } catch (e) {
      console.error("[ModelMarket] fetch error:", e);
      setLoadError(e instanceof Error ? e.message : String(e));
      setEntries([]);
      setStaleCatalog(false);
    } finally {
      setLoading(false);
      setFetchTick((t) => t + 1);
    }
  };

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void doFetch(query, sort);
  };

  const onSortChange = (s: UiSortKey) => {
    setUiSort(s);
    void doFetch(query, s === FITS_SORT ? "trending" : s);
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
              value={uiSort}
              onChange={(e) => onSortChange(e.target.value as UiSortKey)}
              disabled={loading}
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
              <option value={FITS_SORT}>Fits my hardware</option>
            </select>
          </label>
        </div>
      </div>

      <details className="model-market-settings">
        <summary>
          <span className="model-market-summary-path" title={settings?.modelsDir ?? ""}>
            Downloads → {settings?.modelsDir ?? settings?.defaultModelsDir ?? "—"}
          </span>
          {settings?.hasHuggingFaceToken && <span className="model-market-badge">HF token</span>}
        </summary>
        <div className="model-market-settings-body">
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
      </details>

      {loadError && (
        <div className="model-market-error">
          Could not load catalog: {loadError}
        </div>
      )}

      {staleCatalog && !loadError && (
        <div className="model-market-stale" title="huggingface.co was unreachable — showing the cached catalog (up to 10 minutes old).">
          ⚠ Offline — showing a cached catalog
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
            if (hideOversized && ramClass(best.sizeBytes, memoryBudget) === "too_large") continue;
            deduped.push(best);
          }
          // "Fits my hardware": most comfortable fits (smallest) first.
          if (hideOversized) {
            deduped.sort((a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0));
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
                vramBytes={vram && vram.bytes > 0 ? vram.bytes : null}
                gpuName={vram && vram.bytes > 0 ? vram.name : null}
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

/** VRAM-aware fit classification: compares a model's loaded memory
 *  requirement against discrete GPU VRAM. Shared thresholds with ramClass so a
 *  model that needs <50% of VRAM is a comfortable fit. */
function vramClass(requiredBytes: number, vramBytes: number): "fits" | "tight" | "too_large" {
  if (!vramBytes) return "tight";
  const r = requiredBytes / vramBytes;
  if (r < 0.5) return "fits";
  if (r < 0.8) return "tight";
  return "too_large";
}

function vramByteRatio(requiredBytes: number, vramBytes: number): number {
  if (!vramBytes) return 1;
  return requiredBytes / vramBytes;
}

interface ModelCardProps {
  entry: CatalogEntry;
  download: PerDownload | undefined;
  totalRam: number;
  /** Discrete GPU VRAM (bytes), or null when no dedicated GPU / probe failed.
   *  When set, the recommendation is VRAM-aware (offload headroom factored in)
   *  and a "Recommended" badge can show. */
  vramBytes?: number | null;
  /** The detected GPU name for the recommendation label (e.g. "NVIDIA ..."). */
  gpuName?: string | null;
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

type RamFit = "fits" | "tight" | "too_large";

/** The hero hardware-fit signal shared by both market cards and My Models
 *  rows: ✓ Fits / ! Tight / ✕ Too large, tinted with the --fit-* tokens. */
export function FitBadge({ ram }: { ram: RamFit }) {
  const label = ram === "fits" ? "Fits" : ram === "tight" ? "Tight fit" : "Too large";
  const icon = ram === "fits" ? "✓" : ram === "tight" ? "!" : "✕";
  return (
    <span className={`fit-badge ${ram}`} title={label}>
      <span aria-hidden>{icon}</span>
      {label}
    </span>
  );
}

export function ModelCard({ entry, download, totalRam, vramBytes, gpuName, isDownloaded, availableQuants, onAction }: ModelCardProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedQuantEntry, setSelectedQuantEntry] = useState<CatalogEntry>(entry);
  const activeEntry = selectedQuantEntry || entry;
  const [quantsExpanded, setQuantsExpanded] = useState(false);
  const visibleQuants = quantsExpanded ? availableQuants : availableQuants.slice(0, 5);
  // VRAM-aware recommendation (roadmap #11): when a dedicated GPU is present,
  // estimate the loaded memory requirement (GGUF weights + ~12% KV/context
  // overhead) and classify fit against the discrete VRAM; a model that fits
  // with headroom (< 70%) is "Recommended". Falls back to system ROM fit when
  // no discrete GPU is detected.
  const vramReq = activeEntry.sizeBytes * 1.12;
  const usingVram = !!vramBytes && vramBytes > 0;
  const ram = usingVram
    ? vramClass(vramReq, vramBytes!)
    : ramClass(activeEntry.sizeBytes, totalRam);
  const recommended = usingVram && ram === "fits" && vramByteRatio(vramReq, vramBytes!) < 0.7;
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
  // Everything already surfaced in the strip, plus arxiv citation noise,
  // is dropped from the modal's tag row.
  const extraTags = tags.filter(
    (t) => !t.startsWith("arxiv:") && t !== pipelineTag && t !== library && !t.startsWith("base_model:"),
  );

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

        {/* Decision-relevant tags only — provenance (pipeline/library/base/
            updated) moved to the detail modal to cut card noise. */}
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
          {entry.vision && <span className="model-card-tag vision">Vision</span>}
          <FitBadge ram={ram} />
          {recommended && <span className="model-card-tag recommended" title={`Fits ${gpuName || "your GPU"} with headroom`}>✓ Recommended</span>}
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
            <button className="primary cta-strong" onClick={(e) => { e.stopPropagation(); onAction(activeEntry); }} disabled={state === "starting" || state === "verifying"}>
              {ram === "too_large" && !isActive ? "⚠ " : ""}
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
              <button className="primary cta-strong" onClick={(e) => { onAction(activeEntry); setDetailOpen(false); }} disabled={state === "starting" || state === "verifying"}>
                {ram === "too_large" ? "⚠ " : ""}
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
              <FitBadge ram={ram} />
            </div>
            {entry.description && <p className="model-detail-desc">{entry.description}</p>}
            {/* Compact stat strip replaces the old 9-tile grid so the
                download action stays above the fold. */}
            <div className="model-detail-strip">
              {entry.paramsLabel && <span className="model-detail-pair"><span className="k">Params</span><span className="v">{entry.paramsLabel}</span></span>}
              <span className="model-detail-pair"><span className="k">Size</span><span className="v mono">{formatBytes(activeEntry.sizeBytes)}</span></span>
              {(activeEntry.quantization || entry.quantization) && <span className="model-detail-pair"><span className="k">Quant</span><span className="v mono">{activeEntry.quantization || entry.quantization}</span></span>}
              {entry.license && <span className="model-detail-pair"><span className="k">License</span><span className="v">{entry.license}</span></span>}
              {pipelineTag && <span className="model-detail-pair"><span className="k">Pipeline</span><span className="v">{pipelineTag}</span></span>}
              {library && <span className="model-detail-pair"><span className="k">Library</span><span className="v">{library}</span></span>}
              {baseModel && <span className="model-detail-pair"><span className="k">Base</span><span className="v">{baseModel.split("/").pop()}</span></span>}
              {entry.lastModified && <span className="model-detail-pair"><span className="k">Updated</span><span className="v">{fmtDate(entry.lastModified)}</span></span>}
            </div>
            {availableQuants.length > 1 && (
              <div className="model-detail-quants">
                <span className="model-detail-quants-label">Quantization — pick a variant ({availableQuants.length})</span>
                <div className="model-detail-quant-list">
                  {availableQuants.map((q) => {
                    const qRam = usingVram
                      ? vramClass(q.entry.sizeBytes * 1.12, vramBytes!)
                      : ramClass(q.entry.sizeBytes, totalRam);
                    const selected = q.entry.filename === activeEntry.filename;
                    return (
                      <button
                        key={q.entry.filename}
                        type="button"
                        className={`model-detail-quant-row${selected ? " active" : ""}`}
                        onClick={() => setSelectedQuantEntry(q.entry)}
                      >
                        <span className={`fit-dot ${qRam}`} title={qRam === "fits" ? "Fits" : qRam === "tight" ? "Tight fit" : "Too large"} />
                        <span className="q-label">{q.label}</span>
                        <span className="q-size">{formatBytes(q.entry.sizeBytes)}</span>
                        {selected && <span className="q-check">✓</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {extraTags.length > 0 && (
              <div className="model-detail-tags">
                {extraTags.slice(0, 8).map((t) => (
                  <span key={t} className="model-card-tag">{t}</span>
                ))}
              </div>
            )}
            {entry.sha256 && <div className="model-detail-sha">SHA-256: <code>{entry.sha256.slice(0, 32)}…</code></div>}
          </div>
        </Modal>
      )}
    </>
  );
}
