import { useEffect, useRef, useState } from "react";
import { getCostRollups, safeListen } from "../lib/ipc";
import type { CostRollups, CostUpdatedPayload } from "../types";

/** Coalesce bursty `cost:updated` events (they fire per turn AND per budget
 *  tick) into one refetch shortly after the last one. */
const COST_REFRESH_DEBOUNCE_MS = 1500;

type Range = 7 | 30 | 90;

/** Module-level per-range cache. The dashboard unmounts on close, but its
 *  data should not: reopening the Usage modal renders the last figures
 *  immediately (dimmed behind `stale`, an "Updating…" cue on the header)
 *  while a fresh fetch resolves underneath — instead of collapsing to a
 *  blank "Loading…" page on every open. Holds only the LAST successful
 *  payload per range; null/empty results are not cached (an empty range
 *  re-fetches loudly on the next open, which is cheap and correct). */
const rollupCache = new Map<Range, CostRollups>();

/** Mounted useCostRollups instances, notified whenever a range's cache
 *  entry is (re)populated — by their own mount fetch, the manual refresh
 *  button, or the background listener below. */
const cacheListeners = new Set<(range: Range, data: CostRollups | null) => void>();

/** One in-flight fetch per range, shared by every caller (mount, refresh
 *  button, background listener) so concurrent triggers cost one IPC call. */
const inflight = new Map<Range, Promise<void>>();

async function fetchInto(range: Range): Promise<void> {
  const existing = inflight.get(range);
  if (existing) return existing;
  const p = getCostRollups(range)
    .then((r) => {
      if (r) rollupCache.set(range, r);
      cacheListeners.forEach((fn) => fn(range, r));
    })
    .finally(() => {
      inflight.delete(range);
    });
  inflight.set(range, p);
  return p;
}

/** THE background refresher: one listener for the whole session (not per
 *  mount), so the cache stays warm even while the dashboard is closed —
 *  and an open dashboard gets the same debounced silent refresh the old
 *  per-instance listener provided. Debounced exactly like before: turn
 *  churn collapses into one refetch of the ranges we hold. */
let backgroundListenerBound = false;
const backgroundDebounce: { t: ReturnType<typeof setTimeout> | null } = { t: null };

function bindBackgroundListener() {
  if (backgroundListenerBound) return;
  backgroundListenerBound = true;
  void safeListen<CostUpdatedPayload>("cost:updated", () => {
    if (backgroundDebounce.t) clearTimeout(backgroundDebounce.t);
    backgroundDebounce.t = setTimeout(() => {
      backgroundDebounce.t = null;
      for (const range of rollupCache.keys()) {
        void fetchInto(range).catch(() => {
          /* keep last good cache; the open dashboard surfaces nothing new */
        });
      }
    }, COST_REFRESH_DEBOUNCE_MS);
  });
}

/** Test seam: the module cache outlives every mount (that's the point), so
 *  tests that assert first-open spinner semantics need it emptied. */
export function __resetCostRollupCacheForTests() {
  rollupCache.clear();
  inflight.clear();
  cacheListeners.clear();
}

/** Warm the module cache at app boot. Without this the cache only exists
 *  once the dashboard has been opened, so the FIRST open of every session is
 *  the cold path: a full-page spinner while `get_cost_rollups` runs — and
 *  the backend's own rollup cache is cold at that point too, so that first
 *  call is the full window aggregation. Warming here means the first open
 *  already has a payload to paint (last figures, dimmed behind "Updating…",
 *  refreshed underneath). Range 30 is the dashboard default; 7/90 warm on
 *  their first toggle. Quiet: a failure just leaves the cache cold. */
export function warmCostRollups(): void {
  bindBackgroundListener();
  void fetchInto(30).catch(() => {
    /* offline / DB busy — the dashboard's own mount fetch retries */
  });
}

export function useCostRollups(rangeDays: Range) {
  // Seeded from the cache: a reopen renders data on the FIRST frame.
  const [rollups, setRollups] = useState<CostRollups | null>(
    () => rollupCache.get(rangeDays) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  // Spinner only when there is nothing to render at all (no cache, no
  // previous range's data). Any other fetch runs silently underneath.
  const [loading, setLoading] = useState<boolean>(() => !rollupCache.has(rangeDays));
  // True while the figures on screen don't yet reflect the current fetch —
  // a cached copy awaiting refresh, or a previous range mid-switch. The
  // dashboard dims the body and shows "Updating…" rather than tearing down.
  const [stale, setStale] = useState<boolean>(() => rollupCache.has(rangeDays));
  // Ref-backed so the manual `refresh()` can consult it after unmount
  // (audit #16: a refresh resolving after unmount must not setState — the
  // listener removal below is what enforces it now).
  const cancelledRef = useRef(false);
  const rangeRef = useRef(rangeDays);
  rangeRef.current = rangeDays;

  useEffect(() => {
    cancelledRef.current = false;
    // Subscribe BEFORE the mount fetch so a resolution can never fall into
    // the gap between fetch-start and listener-ready.
    const onCache = (range: Range, data: CostRollups | null) => {
      if (cancelledRef.current || range !== rangeRef.current) return;
      setRollups(data);
      setError(null);
      setStale(false);
      setLoading(false);
    };
    cacheListeners.add(onCache);
    bindBackgroundListener();

    // Range switch (or remount) with a cached copy: swap it in immediately —
    // the new range's numbers replace the old ones on the next frame rather
    // than after the round-trip.
    const cached = rollupCache.get(rangeDays);
    if (cached) setRollups(cached);
    // Same loading semantics as the old hook: a fetch is in flight for this
    // range; the spinner only ever shows when nothing renderable exists.
    setLoading(!cached);
    setStale(!!cached || rollups !== null);

    void fetchInto(rangeDays).catch((e) => {
      // The mount/refresh fetch failed. Whatever is on screen stays (cache
      // or previous range); the error banner offers Retry.
      if (!cancelledRef.current) {
        setError(String(e));
        setLoading(false);
        setStale(false);
      }
    });

    return () => {
      cancelledRef.current = true;
      cacheListeners.delete(onCache);
    };
    // `rollups` deliberately omitted: the effect reads it only to decide
    // whether a range SWITCH has old data on screen, and re-running on every
    // rollups update would re-trigger the fetch bookkeeping for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeDays]);

  // Returns the in-flight fetch so a caller that must know when the figures
  // landed (the dashboard's ↻ Refresh, which awaits it alongside the price and
  // plan-window fetches) can await it; existing fire-and-forget callers are
  // unaffected.
  const refresh = (): Promise<void> =>
    fetchInto(rangeDays).catch((e) => {
      if (!cancelledRef.current) setError(String(e));
    });

  return { rollups, loading, stale, error, refresh };
}
