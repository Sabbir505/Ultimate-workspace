// RunsStrip — the bot's recent headless runs. A run is its own hidden session
// (bot_role = 'run'), so clicking one opens its REAL transcript in the same
// center ChatView the thread uses. The gold dot means the run queued a write
// for approval; the pulsing dot means it is working right now.

import type { BotRun } from "../../lib/ipc/bots";
import { relativeTime } from "../../lib/relativeTime";

export function RunsStrip({
  runs,
  running,
  activeSessionId,
  onOpen,
  onStop,
}: {
  runs: BotRun[];
  running: boolean;
  /** The session currently open in the center, so the open run reads as
   *  selected (clicking a run row used to give no visible feedback). */
  activeSessionId?: string | null;
  onOpen: (run: BotRun) => void | Promise<void>;
  /** Stop a running run (only offered for a live run). */
  onStop?: (run: BotRun) => void | Promise<void>;
}) {
  return (
    <section className="bots-strip" aria-label="Recent runs">
      <header className="bots-strip-head">
        <span>Recent runs</span>
        {running && <span className="bots-strip-live">working now</span>}
      </header>
      {runs.length === 0 ? (
        <p className="bots-strip-empty">
          No runs yet. A standing job or “Run now” lands here with its full transcript.
        </p>
      ) : (
        <ul className="bots-strip-list">
          {runs.map((run) => {
            // The bot is not running at all, yet the row claims to be: a crash
            // leftover the boot sweep hasn't settled yet. Show it truthfully
            // instead of a forever-"running" run nobody can open.
            const live = run.status === "running" && running;
            const status = run.status === "running" && !running ? "interrupted" : run.status;
            const dot = live
              ? "working"
              : run.pendingApprovals > 0
                ? "waiting"
                : run.status === "error" || status === "interrupted"
                  ? "off"
                  : "idle";
            return (
              <li key={run.id} className="bots-run-li">
                <button
                  type="button"
                  className={`bots-run-row${run.sessionId === activeSessionId ? " is-active" : ""}`}
                  onClick={() => void onOpen(run)}
                >
                  <span className={`bots-rail-dot is-${dot}`} aria-hidden="true" />
                  <span className="bots-run-name">{run.jobName || "Run"}</span>
                  <span className="bots-run-status">{statusWord(status)}</span>
                  {run.pendingApprovals > 0 && (
                    <span className="bots-rail-badge">{run.pendingApprovals}</span>
                  )}
                  <span className="bots-run-when">{relativeTime(run.finishedAt ?? run.startedAt)}</span>
                </button>
                {live && onStop && (
                  <button
                    type="button"
                    className="bots-run-stop"
                    title="Stop this run"
                    onClick={() => void onStop(run)}
                  >
                    Stop
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function statusWord(status: string): string {
  switch (status) {
    case "running":
      return "running";
    case "ok":
      return "finished";
    case "error":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return status;
  }
}
