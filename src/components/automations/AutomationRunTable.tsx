// Past Runs table — one row per automation_runs entry. Click a row that has
// a chat session attached to open the run log in the chat view.
//
// Rows are windowed with @tanstack/react-virtual: a long-running automation
// accumulates a run row every fire, and the 1 Hz elapsed-time timer below
// re-rendered the whole list each tick. Virtualizing means only the ~20 rows
// actually on screen re-render per tick.
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CheckCircle2,
  ExternalLink,
  Hourglass,
  Loader2,
  Square,
  XCircle,
  Zap,
} from "lucide-react";
import type { AutomationRun } from "../../lib/ipc";
import { formatDateTime, formatDuration } from "../../lib/format";
import { friendlyRunError, isFailureStatus, STOPPED_STATUS } from "./shared";

/** Approximate row height in px. Rows are single-line, so this is stable
 *  enough to scroll smoothly; `measureElement` corrects per-row when a summary
 *  wraps on a narrow window. */
const ROW_ESTIMATE_PX = 34;
/** Height of the scroll viewport. Below this the table stops scrolling and
 *  simply grows, so a 3-run automation doesn't get a scrollbar for nothing. */
const MAX_VIEWPORT_PX = 420;
/** Rows rendered beyond the viewport, so a fast flick doesn't flash blanks. */
const OVERSCAN = 8;

function runDuration(startSec: number, endSec: number | null, liveNowSec?: number): string {
  if (!endSec) {
    // An in-flight run has no finished_at yet — tick the elapsed time live
    // from started_at instead of showing "—" until the run ends.
    if (liveNowSec != null) return formatDuration(Math.max(0, liveNowSec - startSec));
    return "—";
  }
  const diff = endSec - startSec;
  // Failures can finish in well under a second; "0s" reads as broken.
  if (diff < 1) return "<1s";
  return formatDuration(diff);
}

/** Human label per automation_runs.source (automation_runs.source is free
 *  text; unknown values fall back to "Scheduled", which was the old
 *  binary's behavior for everything but "manual"). */
const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  webhook: "Webhook",
  fs: "File change",
  git: "Git change",
};

/** Wall-clock seconds, re-rendered once a second while `active` — one timer
 *  for the whole table, and only while a run is actually in flight. */
function useNowSeconds(active: boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return;
    setNow(Math.floor(Date.now() / 1000));
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function statusBadge(status: string): {
  className: string;
  icon: JSX.Element;
  label: string;
} {
  if (status === "running") {
    return {
      className:
        "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300",
      icon: <Loader2 size={11} className="animate-spin" strokeWidth={2.5} />,
      label: "Running",
    };
  }
  if (status === "ok") {
    return {
      className:
        "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300",
      icon: <CheckCircle2 size={11} strokeWidth={2.5} />,
      label: "OK",
    };
  }
  if (status === "skipped") {
    return {
      className:
        "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300",
      icon: <Hourglass size={11} strokeWidth={2.5} />,
      label: "Skipped",
    };
  }
  if (status === STOPPED_STATUS) {
    return {
      className:
        "bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-slate-300",
      icon: <Square size={8} strokeWidth={2.5} fill="currentColor" />,
      label: "Stopped",
    };
  }
  return {
    className: "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300",
    icon: <XCircle size={11} strokeWidth={2.5} />,
    label: "Error",
  };
}

/** Shared column template so the header and every data row line up. The
 *  Summary column takes the slack; the rest are sized to their content. */
const GRID_COLS = "grid grid-cols-[104px_150px_86px_104px_minmax(0,1fr)_76px]";

/** One row of the run table. A `div` grid rather than a `<tr>`: windowing
 *  absolutely-positioned rows inside a real `<tbody>` either nests invalid
 *  markup or loses column alignment once the rows leave the table's layout
 *  flow, so the roles below carry the table semantics to assistive tech. */
function RunRow({
  run,
  nowSec,
  onOpenRunLog,
  onStopRun,
  stopping,
}: {
  run: AutomationRun;
  nowSec: number;
  onOpenRunLog: (chatSessionId: string) => void;
  onStopRun?: () => void;
  stopping?: boolean;
}) {
  const badge = statusBadge(run.status);
  const failed = isFailureStatus(run.status);
  // Raw error text stays in the tooltip; the cell shows the
  // plain-language translation so users can act on it.
  const friendly = failed ? friendlyRunError(run.summary || run.status) : null;
  return (
    <div
      role="row"
      className={`${GRID_COLS} items-center border-t border-gray-200 dark:border-white/20 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors`}
    >
      <div role="cell" className="px-3 py-2">
        <span
          className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${badge.className}`}
        >
          {badge.icon} {badge.label}
        </span>
      </div>
      <div role="cell" className="px-3 py-2 text-gray-700 dark:text-slate-200 whitespace-nowrap">
        {formatDateTime(run.startedAt)}
      </div>
      <div role="cell" className="px-3 py-2 text-gray-700 dark:text-slate-200 whitespace-nowrap font-mono text-xs">
        {runDuration(run.startedAt, run.finishedAt, run.status === "running" ? nowSec : undefined)}
      </div>
      <div role="cell" className="px-3 py-2 text-gray-500 dark:text-slate-400 text-xs">
        {SOURCE_LABELS[run.source] ?? "Scheduled"}
      </div>
      <div role="cell" className="px-3 py-2 text-gray-700 dark:text-slate-200 text-xs min-w-0" title={run.summary}>
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate">
            {friendly
              ? friendly.text
              : run.summary || (run.status === "running" ? "In progress…" : "—")}
          </span>
          {run.status === "running" && onStopRun && (
            <button
              onClick={onStopRun}
              disabled={stopping}
              title="Stop this run"
              className="inline-flex shrink-0 items-center gap-1 border-0 bg-transparent shadow-none text-[11px] text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
            >
              {stopping ? (
                <Loader2 size={10} className="animate-spin" strokeWidth={2.5} />
              ) : (
                <Square size={8} strokeWidth={2.5} fill="currentColor" />
              )}
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
        </span>
      </div>
      <div role="cell" className="px-3 py-2 text-right">
        {run.chatSessionId ? (
          <button
            onClick={() => onOpenRunLog(run.chatSessionId!)}
            className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
            title="Open run log"
          >
            Open <ExternalLink size={11} strokeWidth={1.8} />
          </button>
        ) : (
          <span className="text-xs text-gray-400 dark:text-slate-500">—</span>
        )}
      </div>
    </div>
  );
}

export function AutomationRunTable({
  runs,
  loading,
  onOpenRunLog,
  onStopRun,
  stopping,
}: {
  runs: AutomationRun[];
  loading: boolean;
  onOpenRunLog: (chatSessionId: string) => void;
  /** Stop the automation's in-flight run — offered inline on the running
   *  row. Absent (e.g. history-only listings) removes the button. */
  onStopRun?: () => void;
  stopping?: boolean;
}) {
  // Hooks must run unconditionally (early returns below used to come first,
  // so the timer hook's call order changed when runs appeared/disappeared and
  // crashed React). Compute first, return the empty states after.
  const inFlight = runs.some((r) => r.status === "running");
  const nowSec = useNowSeconds(inFlight);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: OVERSCAN,
    // jsdom (and the frame before the viewport is measured) reports a
    // zero-height scroll element, which would window the list down to nothing.
    // Seed a plausible viewport so the first paint and the tests both see rows.
    initialRect: { width: 1000, height: MAX_VIEWPORT_PX },
  });

  if (loading && runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2
          size={20}
          className="animate-spin text-gray-400 dark:text-slate-500"
        />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 px-4">
        <Zap size={28} strokeWidth={1.5} className="text-gray-300 dark:text-slate-500" />
        <p className="text-sm text-gray-500 dark:text-slate-400">No runs yet</p>
        <p className="text-xs text-gray-400 dark:text-slate-500 text-center">
          The run log will appear here the next time this automation fires.
        </p>
      </div>
    );
  }

  return (
    <div className="px-6 py-4">
      <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-slate-300 mb-3">
        Past runs
        <span className="ml-2 text-xs font-medium text-gray-400 dark:text-slate-500 normal-case tracking-normal">
          ({runs.length})
        </span>
      </h3>

      <div
        ref={scrollRef}
        className="rounded-lg border border-gray-200 dark:border-white/20 overflow-auto"
        style={{ maxHeight: MAX_VIEWPORT_PX }}
      >
        <div role="table" aria-label="Past runs" aria-rowcount={runs.length} className="w-full text-sm">
          <div
            role="rowgroup"
            className="sticky top-0 z-10 bg-gray-50 dark:bg-white/5 text-gray-500 dark:text-slate-400"
          >
            <div role="row" className={GRID_COLS}>
              <div role="columnheader" className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider">
                Status
              </div>
              <div role="columnheader" className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider">
                Started
              </div>
              <div role="columnheader" className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider">
                Duration
              </div>
              <div role="columnheader" className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider">
                Source
              </div>
              <div role="columnheader" className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider">
                Summary
              </div>
              <div role="columnheader" className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider">
                Log
              </div>
            </div>
          </div>
          {/* The row group carries the full scroll height while only the
              visible window's rows are actually in the DOM; each row is
              absolutely positioned at its virtual offset. */}
          <div
            role="rowgroup"
            style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
          >
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const r = runs[vi.index];
              return (
                <div
                  key={r.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <RunRow
                    run={r}
                    nowSec={nowSec}
                    onOpenRunLog={onOpenRunLog}
                    onStopRun={onStopRun}
                    stopping={stopping}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
