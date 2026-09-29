// Crew view (Phase 2.5) — the "define → run it yourself → watch it work"
// surface. A real view swap, same slot as Automations/Vault (`baseView`),
// reached from the sidebar's Automations row (see Sidebar.tsx).
//
// Three pieces, stacked in one scrollable column:
//   1. CrewPanel — the Phase 1 registry, reused verbatim with its `onRun`
//      wired up. Settings → Agents still renders it WITHOUT `onRun`, so that
//      surface stays registry-only.
//   2. The Run modal — task text, project, wait/background (CrewRunModal).
//   3. The runs list — history from `list_crew_runs` plus anything a live
//      `chat:session-spawn` already ingested (CrewRunsList).
//
// Layout note: the master-detail chrome Automations uses is scoped to that
// view's own stylesheet and container queries, so this view has its own
// stylesheet (styles/crew.css) with the same container contract — the
// settings-panel classes this used to borrow are tuned to the narrow settings
// column and broke at full width.

import { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";
import type { CrewAgent } from "../../lib/ipc";
import { useCrewStore } from "../../state/crew";
import { useUiStore } from "../../state/ui";
import { useChatStore } from "../../state/chat";
import { CrewPanel } from "./CrewPanel";
import { CrewRunModal } from "./CrewRunModal";
import { CrewRunsList } from "./CrewRunsList";
import { ToolbarHeader } from "../common/ToolbarHeader";

export function CrewView() {
  const agents = useCrewStore((s) => s.agents);
  const loadRuns = useCrewStore((s) => s.loadRuns);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const selectSession = useChatStore((s) => s.selectSession);

  const [runTarget, setRunTarget] = useState<CrewAgent | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  // The registry is loaded by CrewPanel on mount; history is this view's own
  // concern, so the view asks for it (once per mount — loadRuns re-reads the
  // whole page and merges).
  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  /** Agent name for a run row; the id stands in for a deleted agent (the
   *  session survives `ON DELETE SET NULL`, the run row keeps no FK). */
  const agentName = useCallback(
    (agentId: string | null) => {
      if (!agentId) return "unknown agent";
      return agents.find((a) => a.id === agentId)?.name ?? agentId;
    },
    [agents],
  );

  /** Open a run's chat — the same shape as the automations view's "Open run
   *  log": reload the session list first (the row may predate this window),
   *  select, and only then switch views so a rejected selectSession can't
   *  strand the user on an empty chat. */
  const openSession = useCallback(
    async (sessionId: string) => {
      setOpenError(null);
      try {
        await loadSessions();
        await selectSession(sessionId);
        setActiveView("chat");
      } catch (err) {
        setOpenError(
          `Couldn't open that run: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [loadSessions, selectSession, setActiveView],
  );

  return (
    <div className="crew-view">
      {/* The header rides in the window title bar, not above the page — see
          common/ToolbarHeader. The registry below keeps the full column. */}
      <ToolbarHeader>
        <div className="crew-header" data-tauri-drag-region="">
          <Users size={18} strokeWidth={1.8} aria-hidden="true" className="crew-header-icon" />
          <h1>Crew</h1>
          {agents.length > 0 && (
            <span className="crew-header-badge">
              {agents.length} agent{agents.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </ToolbarHeader>

      <div className="crew-body">
        {openError && <div className="crew-error settings-note">{openError}</div>}

        <CrewPanel onRun={setRunTarget} />

        <CrewRunsList
          agentName={agentName}
          onOpenSession={(id) => void openSession(id)}
          onRunAgent={setRunTarget}
        />
      </div>

      {runTarget && (
        <CrewRunModal agent={runTarget} onClose={() => setRunTarget(null)} />
      )}
    </div>
  );
}

export default CrewView;
