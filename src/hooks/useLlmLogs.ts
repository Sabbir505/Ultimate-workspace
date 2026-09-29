import { useEffect, useRef, useState } from "react";
import { llmLogList, llmLogStats, safeListen } from "../lib/ipc";
import type { LlmLogStats, LlmLogSummary } from "../types";

/** Coalesce bursty `llm-log:appended` events (one per model round, and a
 *  tool loop fires many) into a single refetch shortly after the last. */
const REFRESH_DEBOUNCE_MS = 1200;

export interface LlmLogFilters {
  origin: "relay" | "external" | null;
  target: string | null;
  search: string | null;
}

/**
 * The Logs list, kept live.
 *
 * Same shape as `useCostRollups`: initial load shows a spinner (the data on
 * screen belongs to a different filter), while event-driven reloads refresh
 * SILENTLY — flashing the spinner on every new row read as a perpetual
 * spinner there, and it would here.
 */
export function useLlmLogs(filters: LlmLogFilters) {
  const [rows, setRows] = useState<LlmLogSummary[]>([]);
  const [stats, setStats] = useState<LlmLogStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const hasDataRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { origin, target, search } = filters;

  useEffect(() => {
    let cancelled = false;
    hasDataRef.current = false;

    const load = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const [list, s] = await Promise.all([
          llmLogList({ origin, target, search, limit: 200 }),
          llmLogStats(),
        ]);
        if (cancelled) return;
        setRows(list);
        setStats(s);
        setError(null);
        hasDataRef.current = true;
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    };

    void load(false);

    const unlisten = safeListen("llm-log:appended", () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void load(hasDataRef.current);
      }, REFRESH_DEBOUNCE_MS);
    });

    return () => {
      cancelled = true;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      void unlisten.then((fn) => fn());
    };
  }, [origin, target, search]);

  return { rows, stats, loading, error };
}
