import { useCallback, useEffect, useRef, useState } from "react";
import { llmLogList, llmLogStats, safeListen } from "../lib/ipc";
import type { LlmLogStats, LlmLogSummary } from "../types";

/** Coalesce bursty `llm-log:appended` events (one per model round, and a
 *  tool loop fires many) into a single refetch shortly after the last. */
const REFRESH_DEBOUNCE_MS = 1200;

/** One page of rows — the list grows beyond this only via explicit "load
 *  more", never by stacking unbounded pages on event refreshes. */
const PAGE = 200;

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
  const [loadingMore, setLoadingMore] = useState(false);
  const hasDataRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `loadMore` and `refresh` need the CURRENT rows/filters without being
  // recreated per render, so both live in refs assigned during render.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // The latest first-page loader, so `refresh` (after Clear/Prune) uses the
  // filters in force when it is called.
  const loadRef = useRef<(silent: boolean) => void>(() => {});

  const { origin, target, search } = filters;

  useEffect(() => {
    let cancelled = false;
    hasDataRef.current = false;

    const load = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const [list, s] = await Promise.all([
          llmLogList({ origin, target, search, limit: PAGE }),
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
    loadRef.current = (silent: boolean) => void load(silent);

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

  /** Refetch the first page in place. Clear and Prune delete rows behind
   *  the list's back — without this, the deleted rows (and the stats badge)
   *  stayed on screen until some unrelated event landed. */
  const refresh = useCallback(() => loadRef.current(true), []);

  /** Append the next-older page, keyed on the last row on screen. */
  const loadMore = useCallback(async () => {
    const current = rowsRef.current;
    const last = current[current.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const more = await llmLogList({
        origin,
        target,
        search,
        limit: PAGE,
        beforeCreatedAt: last.createdAt,
        beforeRowId: last.rowId,
      });
      // An event-driven refresh may have replaced the list while this page
      // was in flight — merge by id so nothing duplicates.
      setRows((cur) => {
        const seen = new Set(cur.map((r) => r.id));
        return [...cur, ...more.filter((m) => !seen.has(m.id))];
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [origin, target, search]);

  /** A full page means there may be more; an exact-end list gets a last
   *  empty page that simply retires the button. */
  const canLoadMore = rows.length >= PAGE;

  return { rows, stats, loading, loadingMore, error, refresh, loadMore, canLoadMore };
}
