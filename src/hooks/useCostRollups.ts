import { useEffect, useRef, useState } from "react";
import { getCostRollups, safeListen } from "../lib/ipc";
import type { CostRollups, CostUpdatedPayload } from "../types";

/** Coalesce bursty `cost:updated` events (they fire per turn AND per budget
 *  tick) into one refetch shortly after the last one. */
const COST_REFRESH_DEBOUNCE_MS = 1500;

export function useCostRollups(rangeDays: 7 | 30 | 90) {
  const [rollups, setRollups] = useState<CostRollups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Same guard the effect body's `cancelled` flag provides, but ref-backed so
  // the manual `refresh()` below can consult it too — a refresh resolving
  // after unmount must not setState (React warning + leak).
  const cancelledRef = useRef(false);
  // Whether data for the CURRENT range has already rendered. Event-driven
  // reloads then refresh SILENTLY: flashing the spinner on every
  // `cost:updated` read as a perpetual spinner (audit L-22).
  const hasDataRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    cancelledRef.current = false;
    hasDataRef.current = false;
    const load = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const r = await getCostRollups(rangeDays);
        if (!cancelled) {
          setRollups(r);
          setError(null);
          hasDataRef.current = true;
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    };
    // Initial load (and range switches): spinner is correct here — the data
    // on screen belongs to a different range.
    void load(false);
    const unlisten = safeListen<CostUpdatedPayload>("cost:updated", () => {
      // Debounced silent refresh: an event stream (turn churn, budget ticks)
      // collapses into one refetch, and existing rows stay visible while it
      // resolves.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void load(hasDataRef.current);
      }, COST_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      cancelled = true;
      cancelledRef.current = true;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      void unlisten.then(fn => fn());
    };
  }, [rangeDays]);

  const refresh = () => {
    getCostRollups(rangeDays)
      .then(r => { if (!cancelledRef.current) { setRollups(r); setError(null); hasDataRef.current = true; } })
      .catch(e => { if (!cancelledRef.current) setError(String(e)); });
  };

  return { rollups, loading, error, refresh };
}
