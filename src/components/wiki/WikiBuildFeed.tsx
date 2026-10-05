// Shared live build feed for the project wiki (§6.15) — the chat "Working…"
// process-block language applied to wiki generation: one row per step
// (explore → outline → per-page write), a spinner on the running row, a
// subtle progress bar, and cancel inline. Used by BOTH the tool-panel tab
// and the overlay reader.
import { useEffect, useRef } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { WikiStep } from "../../state/wiki";

export function WikiBuildFeed({
  steps,
  state,
  phase,
  mode,
  pagesDone,
  pagesTotal,
  onCancel,
  compact,
}: {
  steps: WikiStep[];
  state: "running" | "done" | "cancelled" | "error";
  phase: string;
  mode: string;
  pagesDone: number;
  pagesTotal: number;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const running = state === "running";

  // Keep the newest step visible without yanking the user's scroll.
  useEffect(() => {
    const el = feedRef.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [steps.length, running]);

  return (
    <div
      className={`wiki-feed${compact ? " compact" : ""}${running ? " running" : ""}`}
      data-testid="wiki-feed"
    >
      <div className="wiki-feed-head">
        {running ? (
          <Loader2 className="wiki-feed-spinner" size={13} aria-hidden="true" />
        ) : state === "error" ? (
          <X className="wiki-feed-icon failed" size={13} aria-hidden="true" />
        ) : (
          <Check className="wiki-feed-icon done" size={13} aria-hidden="true" />
        )}
        <span className="wiki-feed-title">
          {running
            ? mode === "build"
              ? "Building the wiki…"
              : "Refreshing pages…"
            : state === "error"
              ? "Build failed"
              : state === "cancelled"
                ? "Cancelled"
                : "Build complete"}
        </span>
        {running && pagesTotal > 0 && (
          <span className="wiki-feed-count">
            {pagesDone}/{pagesTotal} pages
          </span>
        )}
        {running && !pagesTotal && phase !== "pages" && (
          <span className="wiki-feed-count">{phase}</span>
        )}
        {running && onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {/* While running the steps box is ALWAYS rendered (even with no rows
          yet) at a fixed height: the empty-state column is vertically
          centered, and letting the box grow row by row re-centered the whole
          block on every progress event — the feed visibly "shook", and the
          moving Cancel button caught clicks meant for nothing. */}
      {(steps.length > 0 || running) && (
        <>
          <div className="wiki-progress-bar">
            <span
              style={{
                width:
                  state !== "running"
                    ? "100%"
                    : pagesTotal > 0
                      ? `${Math.max(8, Math.round((pagesDone / pagesTotal) * 100))}%`
                      : "12%",
                opacity: state === "running" ? 1 : 0.55,
              }}
            />
          </div>
          <div className="wiki-feed-steps" ref={feedRef}>
            {steps.map((step, i) => (
              <div key={`${i}-${step.text}`} className="wiki-feed-step" data-state={step.state}>
                {step.state === "running" ? (
                  <Loader2 className="wiki-feed-spinner" size={11} aria-hidden="true" />
                ) : step.state === "failed" ? (
                  <X className="wiki-feed-icon failed" size={11} aria-hidden="true" />
                ) : (
                  <Check className="wiki-feed-icon done" size={11} aria-hidden="true" />
                )}
                <span>{step.text}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
