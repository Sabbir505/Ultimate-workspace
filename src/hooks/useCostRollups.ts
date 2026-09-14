import { useEffect, useRef, useState } from "react";
import { getCostRollups, safeListen } from "../lib/ipc";
import type { CostRollups, CostUpdatedPayload } from "../types";

export function useCostRollups(rangeDays: 7 | 30 | 90) {
  const [rollups, setRollups] = useState<CostRollups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Same guard the effect body's `cancelled` flag provides, but ref-backed so
  // the manual `refresh()` below can consult it too — a refresh resolving
  // after unmount must not setState (React warning + leak).
  const cancelledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    cancelledRef.current = false;
    const load = async () => {
      setLoading(true);
      try {
        const r = await getCostRollups(rangeDays);
        if (!cancelled) { setRollups(r); setError(null); }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const unlisten = safeListen<CostUpdatedPayload>("cost:updated", () => void load());
    return () => { cancelled = true; cancelledRef.current = true; void unlisten.then(fn => fn()); };
  }, [rangeDays]);

  const refresh = () => {
    getCostRollups(rangeDays)
      .then(r => { if (!cancelledRef.current) { setRollups(r); setError(null); } })
      .catch(e => { if (!cancelledRef.current) setError(String(e)); });
  };

  return { rollups, loading, error, refresh };
}
