// BotSidebar — the bot view's own right-hand activity rail. It stands in for
// the shared git tools sidebar (ChatView is mounted with `hideGitSidebar`),
// gathering everything the selected bot needs in one place: the approval
// inbox, its standing jobs, its recent runs, and any files it has produced.
//
// Output files come from the artifact ledger: the bot's thread plus each of
// its run sessions are the only session ids that count, so a background run's
// generated file lands here the moment the run is listed.

import { useEffect, useMemo, useState } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { ApprovalInbox } from "./ApprovalInbox";
import { JobsStrip } from "./JobsStrip";
import { RunsStrip } from "./RunsStrip";
import { MemoryStrip } from "./MemoryStrip";
import { OutputsStrip } from "./OutputsStrip";
import type { ArtifactRecord } from "../../lib/ipc/artifacts";
import { listArtifacts } from "../../lib/ipc/artifacts";
import type { Automation } from "../../lib/ipc/automations";
import type { BotApproval, BotMemoryRow, BotRun } from "../../lib/ipc/bots";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";

export function BotSidebar({
  approvals,
  jobs,
  runs,
  running,
  botSessions,
  botId,
  listMemory,
  onManageMemory,
  onResolveApproval,
  onAddJob,
  onOpenRun,
  onStopRun,
}: {
  approvals: BotApproval[];
  jobs: Automation[];
  runs: BotRun[];
  running: boolean;
  /** The bot's thread session + every run session — the artifact filter. */
  botSessions: string[];
  /** The selected bot (whose memory the rail lists). Optional so the rail can
   *  render without it (tests / a partial embed); memory is skipped then. */
  botId?: string;
  listMemory?: (botId: string) => Promise<BotMemoryRow[]>;
  onManageMemory?: () => void;
  onResolveApproval: (id: string, approve: boolean) => Promise<void>;
  onAddJob: () => void;
  onOpenRun: (run: BotRun) => void | Promise<void>;
  onStopRun?: (run: BotRun) => void | Promise<void>;
}) {
  const openArtifactTab = useUiStore((s) => s.openArtifactTab);
  const collapsed = useUiStore((s) => s.botsActivityCollapsed);
  const toggleCollapsed = useUiStore((s) => s.toggleBotsActivity);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const [outputs, setOutputs] = useState<ArtifactRecord[]>([]);
  const pendingCount = approvals.filter((a) => a.status === "pending").length;

  // The session set is the only thing that should re-trigger a reload; join it
  // so the effect keys off a stable primitive rather than a fresh array.
  const sessionKey = useMemo(() => [...botSessions].sort().join("\n"), [botSessions]);

  useEffect(() => {
    if (!sessionKey) {
      setOutputs([]);
      return;
    }
    const wanted = new Set(sessionKey.split("\n"));
    let cancelled = false;
    void listArtifacts()
      .then((all) => {
        if (cancelled) return;
        setOutputs((all ?? []).filter((a) => a.chatSessionId != null && wanted.has(a.chatSessionId)));
      })
      .catch(() => {
        if (!cancelled) setOutputs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  return (
    <aside
      className={`bots-sidebar${collapsed ? " is-collapsed" : ""}`}
      aria-label="Bot activity"
    >
      <div className="bots-sidebar-head">
        {!collapsed && <span className="bots-sidebar-title">Activity</span>}
        <button
          type="button"
          className="bots-sidebar-collapse"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand the activity rail" : "Collapse the activity rail"}
          aria-label={collapsed ? "Expand activity rail" : "Collapse activity rail"}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronsLeft size={15} strokeWidth={2} />
          ) : (
            <ChevronsRight size={15} strokeWidth={2} />
          )}
        </button>
      </div>
      {collapsed ? (
        pendingCount > 0 && (
          <span
            className="bots-sidebar-badge"
            title={`${pendingCount} approval${pendingCount === 1 ? "" : "s"} waiting`}
          >
            {pendingCount}
          </span>
        )
      ) : (
        <div className="bots-sidebar-body">
          <ApprovalInbox approvals={approvals} onResolve={onResolveApproval} />
          <JobsStrip jobs={jobs} onAdd={onAddJob} />
          <RunsStrip
            runs={runs}
            running={running}
            activeSessionId={activeChatSessionId}
            onOpen={onOpenRun}
            onStop={onStopRun}
          />
          {botId && listMemory && (
            <MemoryStrip botId={botId} listMemory={listMemory} onManage={onManageMemory ?? (() => {})} />
          )}
          <OutputsStrip
            outputs={outputs}
            onOpen={(a) => openArtifactTab({ path: a.path, filename: a.filename })}
          />
        </div>
      )}
    </aside>
  );
}
