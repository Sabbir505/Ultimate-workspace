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
  fetchModelCatalog,
  getMarketSettings,
  onModelDownloadProgress,
  pickModelsDirectory,
  setHuggingFaceToken,
  setModelsDirectory,
  startModelDownload,
  type CatalogEntry,
  type DownloadProgress,
  type MarketSettings,
  type ModelSort,
} from "../../lib/ipc";

type SortKey = ModelSort;

const SORT_LABELS: Record<SortKey, string> = {
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
  /** Called after a successful download so the parent can re-scan disk. */
  onDownloadComplete: () => void;
}

export function ModelMarket({ onDownloadComplete }: ModelMarketProps) {
  const [settings, setSettings] = useState<MarketSettings | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("downloads");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenDirty, setTokenDirty] = useState(false);
  const [downloads, setDownloads] = useState<Record<string, PerDownload>>({});
  // Bump on every successful fetch so effect deps stay cheap.
  const [fetchTick, setFetchTick] = useState(0);
  // Rescan the system RAM for the "fits my RAM" badge.
  const systemRamRef = useRef<number | null>(null);
  if (systemRamRef.current === null) {
    // Heuristic: navigator.deviceMemory is in GiB and is only set on
    // Chromium-family browsers. Fall back to a sensible default (16 GB)
    // when the API is absent.
    const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    systemRamRef.current = (dm && dm > 0 ? dm : 16) * 1024 * 1024 * 1024;
  }

  // Load settings + first catalog fetch on mount.
  useEffect(() => {
    let stale = false;
    void (async () => {
      const s = await getMarketSettings();
      if (!stale) setSettings(s);
      await doFetch("", "downloads");
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

  const onStartDownload = (e: CatalogEntry) => {
    if (downloads[e.id]?.state === "downloading" || downloads[e.id]?.state === "starting") {
      void cancelModelDownload(e.id);
      return;
    }
    void startModelDownload({
      id: e.id,
      repoId: e.repoId,
      filename: e.filename,
      downloadUrl: e.downloadUrl,
      expectedSha256: e.sha256,
      destDir: settings?.modelsDir ?? undefined,
    });
  };

  const totalRam = systemRamRef.current ?? 16 * 1024 * 1024 * 1024;

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
        {entries.length === 0 && !loading && !loadError && (
          <div className="empty-reserved">
            <span className="empty-text">
              No models to show. Try a different search term or sort.
            </span>
          </div>
        )}
        {entries.map((e) => (
          <ModelCard
            key={e.id}
            entry={e}
            download={downloads[e.id]}
            totalRam={totalRam}
            onAction={() => onStartDownload(e)}
          />
        ))}
      </div>
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
  onAction: () => void;
}

function ModelCard({ entry, download, totalRam, onAction }: ModelCardProps) {
  const ram = ramClass(entry.sizeBytes, totalRam);
  const state = download?.state;
  const pct =
    download?.total && download.total > 0
      ? Math.min(100, Math.round((download.downloaded / download.total) * 100))
      : null;

  const actionLabel = useMemo(() => {
    if (!state || state === "done" || state === "cancelled" || state === "error")
      return "Download";
    if (state === "starting") return "Starting…";
    if (state === "downloading") return "Cancel";
    if (state === "verifying") return "Verifying…";
    return "Download";
  }, [state]);

  return (
    <div className={`model-card ram-${ram}`}>
      <div className="model-card-head">
        <div className="model-card-title" title={entry.displayName}>
          {entry.displayName}
        </div>
        <div className="model-card-badges">
          {entry.paramsLabel && <span className="badge">{entry.paramsLabel}</span>}
          {entry.quantization && <span className="badge">{entry.quantization}</span>}
          {entry.vision && <span className="badge vision">vision</span>}
          <span className={`badge ram-badge ram-${ram}`}>
            {ram === "fits" ? "Fits RAM" : ram === "tight" ? "Tight" : "Too large"}
          </span>
        </div>
      </div>
      <div className="model-card-meta">
        <span className="model-card-author" title={entry.repoId}>
          {entry.author || entry.repoId}
        </span>
        <span className="model-card-size">{formatBytes(entry.sizeBytes)}</span>
        <span className="model-card-dl">↓ {entry.downloads.toLocaleString()}</span>
      </div>
      {entry.description && (
        <div className="model-card-desc">{entry.description}</div>
      )}
      {entry.license && (
        <div className="model-card-license">License: {entry.license}</div>
      )}

      {state && state !== "done" && state !== "cancelled" && state !== "error" && (
        <div className="model-card-progress">
          <div className="model-card-progress-bar">
            <div
              className="model-card-progress-fill"
              style={{ width: `${pct ?? 0}%` }}
            />
          </div>
          <div className="model-card-progress-info">
            <span>
              {pct !== null ? `${pct}% · ` : ""}
              {formatBytes(download?.downloaded ?? 0)}
              {download?.total ? ` / ${formatBytes(download.total)}` : ""}
            </span>
            <span>{formatRate(download?.bps ?? 0)}</span>
          </div>
        </div>
      )}

      {state === "done" && (
        <div className="model-card-status done">Saved · ready to use</div>
      )}
      {state === "cancelled" && (
        <div className="model-card-status cancelled">Cancelled</div>
      )}
      {state === "error" && (
        <div className="model-card-status error">{download?.error ?? "Download failed"}</div>
      )}

      <div className="model-card-actions">
        <button
          className="primary"
          onClick={onAction}
          disabled={state === "starting" || state === "verifying" || ram === "too_large"}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
