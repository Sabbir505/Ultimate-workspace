// Settings → Subagents: the merged section. Everything the standalone
// Subagents view used to host lives here now — the registry (with its native
// stores + import), the run history, and the Run dialog. Same behavior as the
// old view, settings-column sized: the cards stack, the Run modal portals
// above everything, and "open run" still lands the user in the run's chat.
import { useCallback, useEffect, useState } from "react";
import type { Subagent } from "../../lib/ipc";
import { useSubagentStore } from "../../state/subagents";
import { useUiStore } from "../../state/ui";
import { useChatStore } from "../../state/chat";
import { SubagentsPanel } from "./SubagentsPanel";
import { SubagentRunModal } from "./SubagentRunModal";
import { SubagentRunsList } from "./SubagentRunsList";

export function SubagentsSettingsSection() {
  const agents = useSubagentStore((s) => s.agents);
  const loadRuns = useSubagentStore((s) => s.loadRuns);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const selectSession = useChatStore((s) => s.selectSession);

  const [runTarget, setRunTarget] = useState<Subagent | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  // Run history is this section's concern; the registry list loads itself on
  // the panel's mount. loadRuns re-reads the whole page and merges, so one
  // call per mount is right.
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

  /** Open a run's chat — the same shape the runs list uses everywhere: reload
   *  the session list first (the row may predate this window), select, and
   *  only then switch views so a rejected selectSession can't strand the user. */
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
    <>
      {openError && <div className="settings-note subagent-error">{openError}</div>}

      <SubagentsPanel onRun={setRunTarget} />

      <SubagentRunsList
        agentName={agentName}
        onOpenSession={(id) => void openSession(id)}
        onRunAgent={setRunTarget}
      />

      {runTarget && (
        <SubagentRunModal agent={runTarget} onClose={() => setRunTarget(null)} />
      )}
    </>
  );
}
