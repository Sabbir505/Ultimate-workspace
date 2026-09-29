// Subagent view (Phase 2.5) — the "define → run it yourself → watch it work"
// surface. A real view swap, same slot as Automations/Vault (`baseView`),
// reached from the sidebar's Automations row (see Sidebar.tsx).
//
// Three pieces, stacked in one scrollable column:
//   1. SubagentsPanel — the Phase 1 registry, reused verbatim with its `onRun`
//      wired up. Settings → Agents still renders it WITHOUT `onRun`, so that
//      surface stays registry-only.
//   2. The Run modal — task text, project, wait/background (SubagentRunModal).
//   3. The runs list — history from `list_subagent_runs` plus anything a live
//      `chat:session-spawn` already ingested (SubagentRunsList).
//
// Layout note: the master-detail chrome Automations uses is scoped to that
// view's own stylesheet and container queries, so this view has its own
// stylesheet (styles/subagent.css) with the same container contract — the
// settings-panel classes this used to borrow are tuned to the narrow settings
// column and broke at full width.

import { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";
import type { Subagent } from "../../lib/ipc";
import { useSubagentStore } from "../../state/subagents";
import { useUiStore } from "../../state/ui";
import { useChatStore } from "../../state/chat";
import { SubagentsPanel } from "./SubagentsPanel";
import { SubagentRunModal } from "./SubagentRunModal";
import { SubagentRunsList } from "./SubagentRunsList";
import { ToolbarHeader } from "../common/ToolbarHeader";

export function SubagentsView() {
  const agents = useSubagentStore((s) => s.agents);
  const loadRuns = useSubagentStore((s) => s.loadRuns);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const selectSession = useChatStore((s) => s.selectSession);

  const [runTarget, setRunTarget] = useState<Subagent | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  // The registry is loaded by SubagentsPanel on mount; history is this view's own
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
    <div className="subagent-view">
      {/* The header rides in the window title bar, not above the page — see
          common/ToolbarHeader. The registry below keeps the full column. */}
      <ToolbarHeader>
        <div className="subagent-header" data-tauri-drag-region="">
          <Users size={18} strokeWidth={1.8} aria-hidden="true" className="subagent-header-icon" />
          <h1>Subagents</h1>
          {agents.length > 0 && (
            <span className="subagent-header-badge">
              {agents.length} agent{agents.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </ToolbarHeader>

      <div className="subagent-body">
        {openError && <div className="subagent-error settings-note">{openError}</div>}

        <SubagentsPanel onRun={setRunTarget} />

        <SubagentRunsList
          agentName={agentName}
          onOpenSession={(id) => void openSession(id)}
          onRunAgent={setRunTarget}
        />
      </div>

      {runTarget && (
        <SubagentRunModal agent={runTarget} onClose={() => setRunTarget(null)} />
      )}
    </div>
  );
}

export default SubagentsView;
