// Crew runs — the history list for a crew agent (Phase 2.5 read side).
//
// A crew run is a normal chat session: the backend's `crew_runs` row is the
// bookkeeping, the session is where the transcript lives. So the "open" action
// on a row does exactly what the automations view's "Open run log" does —
// load the session list, select the session, and switch to the chat view — and
// a row whose session was deleted degrades to a disabled button rather than
// vanishing (history outlives the chat: no FK on `session_id`).
//
// Rows are rendered newest-first off `listCrewRuns`; the crew store's `runs`
// map is the merged view, because a run spawned a moment ago arrives via the
// `chat:session-spawn` event before (or without) a history refresh.

import { useMemo } from "react";
import { Bot, Clock, ExternalLink, History, RefreshCw, Zap } from "lucide-react";
import { crewEngineTier, type CrewAgent, type CrewAgentRun } from "../../lib/ipc";
import { relativeTime } from "../../lib/relativeTime";
import { useCrewStore } from "../../state/crew";

/** Status → copy. The COLOUR lives in CSS (`.crew-chip.status-*`), keyed on
 *  the raw status — same vocabulary the automations runs table uses (ok /
 *  running / error / cancelled) so the two run histories read alike. */
function statusMeta(status: string): { label: string } {
  switch (status) {
    case "ok":
      return { label: "OK" };
    case "running":
      return { label: "Running" };
    case "error":
      return { label: "Error" };
    case "cancelled":
      return { label: "Cancelled" };
    default:
      return { label: status || "—" };
  }
}

/** `startedAt` is a unix-seconds epoch across this app's DB rows, but a
 *  spawn-event run is stamped in ms (`Date.now()`). Normalize rather than
 *  render "55 years ago" for every live run. */
function startedMs(run: CrewAgentRun): number {
  return run.startedAt > 1e12 ? run.startedAt : run.startedAt * 1000;
}

function engineLabel(run: CrewAgentRun): string {
  if (run.engine) return run.engine.replace(/^harness:/, "");
  return "inherited engine";
}

export interface CrewRunsListProps {
  /** agent name resolver — falls back to the id for a deleted agent. */
  agentName: (agentId: string | null) => string;
  /** Open a run's session. Wired by the view (chat store + view switch). */
  onOpenSession: (sessionId: string) => void;
  /** Called by the "Run" action on a row. */
  onRunAgent?: (agent: CrewAgent) => void;
  /** Restrict to one agent; omit for every agent. */
  agentId?: string | null;
}

export function CrewRunsList({
  agentName,
  onOpenSession,
  onRunAgent,
  agentId,
}: CrewRunsListProps) {
  const runs = useCrewStore((s) => s.runs);
  const runsLoaded = useCrewStore((s) => s.runsLoaded);
  const error = useCrewStore((s) => s.error);
  const agents = useCrewStore((s) => s.agents);
  const loadRuns = useCrewStore((s) => s.loadRuns);

  const ordered = useMemo(() => {
    return Object.values(runs)
      .filter((r) => !agentId || r.agentId === agentId)
      .sort((a, b) => startedMs(b) - startedMs(a));
  }, [runs, agentId]);

  const running = ordered.filter((r) => r.status === "running").length;

  return (
    // A named region, not a bare div: the registry panel above repeats the
    // agent name and the store's error, and this list needs to be addressable
    // (and screen-reader-navigable) as its own thing.
    <section aria-label="Crew runs" className="crew-section">
      <div className="crew-section-head">
        <h3>Recent runs</h3>
        <span className="crew-spacer" />
        {ordered.length > 0 && (
          <span className="crew-header-badge">
            {ordered.length} run{ordered.length === 1 ? "" : "s"}
            {running > 0 ? ` · ${running} running` : ""}
          </span>
        )}
        <button
          type="button"
          className="ghost"
          title="Refresh run history"
          aria-label="Refresh run history"
          onClick={() => void loadRuns(agentId ?? null)}
        >
          <RefreshCw size={14} strokeWidth={1.8} />
        </button>
      </div>

      {error && <div className="settings-note crew-error">{error}</div>}

      {!runsLoaded ? (
        <div className="crew-empty">
          <div>Loading runs…</div>
        </div>
      ) : ordered.length === 0 ? (
        <div className="crew-empty">
          <History size={22} />
          <div>
            No runs yet. Hit Run on an agent above — the run opens as a chat and
            shows up here the moment it starts.
          </div>
        </div>
      ) : (
        <div className="crew-run-list">
          {ordered.map((run) => {
            const meta = statusMeta(run.status);
            const agent = run.agentId ? agents.find((a) => a.id === run.agentId) : undefined;
            return (
              <div key={run.id} className="crew-run-row">
                <span className="crew-run-agent">
                  {agentName(run.agentId)}
                </span>
                <span className="crew-run-main">
                  <span className="crew-run-task">
                    {run.task || "(no task text)"}
                  </span>
                  <span className="crew-run-meta">
                    {/* The trigger is the honest answer to "why did this run?":
                        manual = the Run button, task = an in-session Task call,
                        mesh = a model's spawn_session. Same pill vocabulary as
                        the registry rows above. */}
                    <span
                      className="crew-meta-chip"
                      title="manual = the Run button, task = a Task call, mesh = a spawned session"
                    >
                      <Zap size={11} strokeWidth={1.8} aria-hidden="true" />
                      {run.trigger}
                    </span>
                    <span className="crew-meta-chip" title="Engine">
                      <Bot size={11} strokeWidth={1.8} aria-hidden="true" />
                      {engineLabel(run)}
                    </span>
                    {run.model && (
                      <span className="crew-meta-chip mono" title="Model">
                        {run.model}
                      </span>
                    )}
                    {agent && (
                      <span
                        className={`crew-chip${crewEngineTier(agent.engine) === "enforced" ? " enforced" : ""}`}
                        title="Enforcement tier of the agent that ran"
                      >
                        {crewEngineTier(agent.engine)}
                      </span>
                    )}
                    <span className="crew-meta-chip" title="Started">
                      <Clock size={11} strokeWidth={1.8} aria-hidden="true" />
                      started {relativeTime(startedMs(run) / 1000)}
                    </span>
                  </span>
                </span>
                <span className={`crew-chip status-${run.status || "unknown"}`} title={`Status: ${meta.label}`}>
                  {meta.label}
                </span>
                <span className="crew-run-actions">
                  {run.sessionId ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => onOpenSession(run.sessionId!)}
                      title="Open the run's chat"
                      aria-label={`Open the run from ${agentName(run.agentId)}`}
                    >
                      <ExternalLink size={16} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      disabled
                      title="This run's chat was deleted — only the history row is left"
                      aria-label="Run chat deleted"
                    >
                      <ExternalLink size={16} />
                    </button>
                  )}
                  {onRunAgent && agent && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => onRunAgent(agent)}
                      title={`Run ${agent.name} again`}
                      aria-label={`Run ${agent.name} again`}
                    >
                      <RefreshCw size={16} />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
