// Live model pricing (LiteLLM community registry) — see
// src-tauri/src/pricing_live.rs for the blob shape and the refresh pipeline.
// Command names and payload shapes are binding (CONTRACT.md).
import { safeInvoke } from "../ipcCore";

const PRICE_LITE_FETCHED_AT_KEY = "price.lite.fetched_at";

/** What `prices_refresh_now` stored ({stored, fetchedAt} — FetchReport in
 *  pricing_live.rs). Null when the refresh could not be attempted. */
export interface FetchReport {
  stored: number;
  fetchedAt: number;
}

/** Manual re-fetch of the LiteLLM price registry (cost dashboard footer's
 *  "Refresh model prices"). Failure keeps the previous blob and rejects. */
export const pricesRefreshNow = () =>
  safeInvoke<FetchReport | null>("prices_refresh_now");

export interface PriceInfo {
  /** Epoch seconds of the last successful fetch, from the
   *  `price.lite.fetched_at` settings key. Null = never fetched (the
   *  compiled rate table is pricing everything). */
  fetchedAt: number | null;
}

/** Read the live price table's freshness markers (settings keys). */
export const getPriceInfo = async (): Promise<PriceInfo> => {
  const raw = await safeInvoke<string | null>("get_setting", {
    key: PRICE_LITE_FETCHED_AT_KEY,
  });
  const parsed = raw != null ? Number(raw) : NaN;
  return {
    fetchedAt: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
  };
};
