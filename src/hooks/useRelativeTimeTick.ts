// Slow re-render tick for relative-time labels ("2m ago") shown in lists that
// otherwise only re-render on store changes — a row's label used to freeze at
// whatever the last render computed and could sit hours stale while nothing
// happened in the app. Returns a counter; include it in the memo deps of the
// mapping that computes the labels (NOT in the row components — the rows are
// React.memo'd and must keep re-rendering only when their own label changes).
import { useEffect, useState } from "react";

export function useRelativeTimeTick(intervalMs = 30_000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return tick;
}
