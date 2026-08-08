import { useEffect, useState } from "react";
import { getCostRollups, safeListen } from "../lib/ipc";
import type { CostRollups, CostUpdatedPayload } from "../types";

export function useCostRollups(rangeDays: 7 | 30 | 90) {
  const [rollups, setRollups] = useState<CostRollups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
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
    return () => { cancelled = true; void unlisten.then(fn => fn()); };
  }, [rangeDays]);

  return { rollups, loading, error, refresh: () => void getCostRollups(rangeDays).then(setRollups) };
}
