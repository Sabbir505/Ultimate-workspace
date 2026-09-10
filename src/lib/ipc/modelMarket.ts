// Local Models market (Hugging Face browse + download) — extracted domain of
// lib/ipc.ts. Types and wrappers for the market catalog, settings, download
// progress, and quantization queries.
import { safeInvoke, safeListen } from "../ipcCore";

export type ModelSort = "downloads" | "likes" | "modified" | "trending";

export interface CatalogEntry {
  id: string;
  displayName: string;
  author: string;
  repoId: string;
  filename: string;
  downloads: number;
  likes: number;
  lastModified?: string | null;
  sizeBytes: number;
  description?: string | null;
  tags: string[];
  sha256?: string | null;
  downloadUrl: string;
  vision: boolean;
  paramsLabel?: string | null;
  quantization?: string | null;
  license?: string | null;
  gated: boolean;
}

export interface FetchCatalogResult {
  entries: CatalogEntry[];
  hasHuggingFaceToken: boolean;
  defaultModelsDir?: string | null;
  /** True when huggingface.co was unreachable and a cached copy (any age)
   *  was served — the UI shows an offline hint instead of an error. */
  stale?: boolean;
}

export interface MarketSettings {
  modelsDir?: string | null;
  defaultModelsDir?: string | null;
  hasHuggingFaceToken: boolean;
}

export type DownloadState =
  | "starting"
  | "downloading"
  | "verifying"
  | "done"
  | "error"
  | "cancelled";

export interface DownloadProgress {
  id: string;
  downloadedBytes: number;
  totalBytes?: number | null;
  state: DownloadState;
  bytesPerSecond: number;
  finalPath?: string | null;
  error?: string | null;
}

/** Per-download UI snapshot derived from DownloadProgress events (Model
 *  Market cards, Knowledge/STT panels). */
export interface PerDownloadState {
  state: DownloadProgress["state"];
  downloaded: number;
  total: number | null;
}

export interface FetchCatalogArgs {
  query?: string;
  sort?: ModelSort;
  limit?: number;
}

export interface StartDownloadArgs {
  id: string;
  repoId: string;
  filename: string;
  downloadUrl: string;
  expectedSha256?: string | null;
  destDir?: string | null;
}

export const fetchModelCatalog = (args: FetchCatalogArgs = {}) =>
  // Flat payload — the Rust command takes top-level `query`/`sort`/`limit`
  // params, not a nested `args` object. (Nesting silently broke search/sort
  // and made every download fail with "missing required argument id".)
  safeInvoke<FetchCatalogResult | null>("fetch_model_catalog", {
    query: args.query ?? null,
    sort: args.sort ?? null,
    limit: args.limit ?? null,
  });

/** Real per-file GGUF sizes for one repo (filename → bytes), from HF's tree
 *  endpoint. The catalog listing API doesn't expose sibling sizes, so entries
 *  there carry estimates; this corrects them for single-repo views. */
export const fetchModelFileSizes = (repoId: string) =>
  safeInvoke<Record<string, number>>("fetch_model_file_sizes", { repoId });

/** GPU VRAM info for the model-market size gate. Null when no discrete GPU. */
export interface GpuVramInfo {
  totalVramBytes: number | null;
  deviceName: string | null;
}

export const getGpuVram = () => safeInvoke<GpuVramInfo | null>("get_gpu_vram");

/** Auto-detect GPU + estimate power draw for the electricity cost calculator. */
export interface GpuPowerDetection {
  deviceName: string | null;
  totalVramBytes: number | null;
  estimatedWatts: number | null;
}
export const detectGpuPower = () =>
  safeInvoke<GpuPowerDetection | null>("detect_gpu_power");

export const getMarketSettings = () =>
  safeInvoke<MarketSettings | null>("get_market_settings");

export const setModelsDirectory = (dir: string) =>
  safeInvoke<void>("set_models_directory", { dir });

export const pickModelsDirectory = () =>
  safeInvoke<string | null>("pick_models_directory");

export const setHuggingFaceToken = (token: string) =>
  safeInvoke<void>("set_hugging_face_token", { token });

export const clearHuggingFaceToken = () =>
  safeInvoke<void>("clear_hugging_face_token");

export const startModelDownload = (args: StartDownloadArgs) =>
  // Flat payload — see fetchModelCatalog note above.
  safeInvoke<void>("start_model_download", {
    id: args.id,
    repoId: args.repoId,
    filename: args.filename,
    downloadUrl: args.downloadUrl,
    expectedSha256: args.expectedSha256 ?? null,
    destDir: args.destDir ?? null,
  });

export const cancelModelDownload = (id: string) =>
  safeInvoke<void>("cancel_model_download", { id });

export const onModelDownloadProgress = (
  handler: (p: DownloadProgress) => void,
) => safeListen<DownloadProgress>("local-model:download:progress", handler);

