// Full vertical Git tools sidebar panel — a single continuous dark panel on
// the right side of the app. Contains a collapsible Git section with
// Changes/Branch/Commit rows, plus collapsible Plans, Progress, and Agents
// sections.
//
// Row behaviours:
//   "changes" → opens the ToolPanel's Changes (files) tab.
//   branch name → opens the BranchDropdown popover via portal (top-right area).
//   "Commit or push" → opens the CommitModal centered in the chat view.
//   plan row → opens the plan markdown in the ToolPanel's Canvas tab.
//
// Collapsed state: a thin ~50px strip showing just the last plan header in
//   one sentence — the git icon toggles this. Section state is preserved.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";import {
  getChangedFiles,
  listGitBranches,
  safeListen,
  type BranchInfo,
} from "../../lib/ipc";
import { useProjectsStore } from "../../state/projects";
import { useChatStore, selectContextSessionId } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { BranchDropdown } from "./BranchDropdown";
import { CommitModal } from "./CommitModal";
import { usePlanTracker } from "../../hooks/usePlanTracker";

const EMPTY_TASKS: Record<string, unknown> = {};
const EMPTY_STEPS: unknown[] = [];
const EMPTY_SUBAGENTS: Record<string, unknown> = {};
const EMPTY_ACCEPTED: import("../../lib/ipc").ChatPlanRecord[] = [];

const SIDEBAR_VISIBLE_CAP = 4;

/** "more X" affordance for sidebar sections: shows the first
 *  SIDEBAR_VISIBLE_CAP rows inline; hovering (or focusing) the more-row opens
 *  a small glass popover — same visual language as the branch menu — listing
 *  the remaining rows with their normal click behavior. */
function SidebarMoreRow({
  count,
  label,
  children,
}: {
  count: number;
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="git-sidebar-more"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="git-sidebar-more-btn"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        more {count} {label}
      </button>
      {open && <div className="git-sidebar-more-pop">{children}</div>}
    </div>
  );
}

export function GitToolsSidebar() {
  const activeChatSessionId = useChatStore(selectContextSessionId);
  const boundProjectId = useChatStore((s) =>
    activeChatSessionId ? s.sessionProjects[activeChatSessionId] : undefined,
  );
  const projects = useProjectsStore((s) => s.projects);
  const gitStatuses = useProjectsStore((s) => s.gitStatuses);
  const tasks = useChatStore((s) =>
    activeChatSessionId ? (s.tasks[activeChatSessionId] ?? EMPTY_TASKS) : EMPTY_TASKS,
  );
  const planSteps = useChatStore((s) =>
    activeChatSessionId ? (s.planSteps[activeChatSessionId] ?? EMPTY_STEPS) : EMPTY_STEPS,
  );
  // APPROVED plan documents (present_plan → user accepted). These are the
  // sidebar Plans list; execution steps live in planSteps (Progress below).
  const acceptedPlans = useChatStore((s) =>
    activeChatSessionId ? (s.sessionPlans[activeChatSessionId] ?? EMPTY_ACCEPTED) : EMPTY_ACCEPTED,
  );
  const subagents = useChatStore((s) =>
    activeChatSessionId ? (s.subagents[activeChatSessionId] ?? EMPTY_SUBAGENTS) : EMPTY_SUBAGENTS,
  );

  // Activate plan-step parsing and completion tracking
  usePlanTracker();

  // Tool panel / UI store hooks — select individually to avoid churn.
  const addTab = useUiStore((s) => s.addTab);
  const setToolPanelCollapsed = useUiStore((s) => s.setToolPanelCollapsed);
  const openPlanTab = useUiStore((s) => s.openPlanTab);
  const setPlanCanvas = useUiStore((s) => s.setPlanCanvas);
  // Click-to-open ONE agent in the right pane (reuses the pane, no tab spam).
  const openAgentsTab = useUiStore((s) => s.openAgentsTab);
  const gitSidebarCollapsed = useUiStore((s) => s.gitSidebarCollapsed);
  const toggleGitSidebar = useUiStore((s) => s.toggleGitSidebar);
  const setModalOpen = useUiStore((s) => s.setModalOpen);
  // Per-section disclosure state. Defaults to open (see ui.ts). The
  // collapse/expand is animated via a grid-template-rows 0fr→1fr wrapper,
  // matching the Projects disclosure in the main sidebar (sidebar.css).
  const gitSectionGitOpen = useUiStore((s) => s.gitSectionGitOpen);
  const gitSectionPlansOpen = useUiStore((s) => s.gitSectionPlansOpen);
  const gitSectionProgressOpen = useUiStore((s) => s.gitSectionProgressOpen);
  const gitSectionAgentsOpen = useUiStore((s) => s.gitSectionAgentsOpen);
  const toggleGitSectionGit = useUiStore((s) => s.toggleGitSectionGit);
  const toggleGitSectionPlans = useUiStore((s) => s.toggleGitSectionPlans);
  const toggleGitSectionProgress = useUiStore((s) => s.toggleGitSectionProgress);
  const toggleGitSectionAgents = useUiStore((s) => s.toggleGitSectionAgents);

  // Strictly chat-bound: the git surface follows the ACTIVE SESSION's
  // project binding, never the sidebar-selected project. A brand-new chat
  // (created without a projectId) is unbound — falling back to the global
  // selection here leaked ANOTHER project's changes/branch into it, and
  // polling even ran git against that project's working dir. Unbound chats
  // therefore show no git data (path null → poll skips, branch shows HEAD)
  // until they are bound (binding happens on first send / project "+").
  const projectId = boundProjectId;
  const project = projects.find((p) => p.id === projectId);
  // The diff/branch surface follows the chat's working directory: when the
  // active chat runs in an isolated worktree (roadmap P0 §3.1.1), git
  // status/diff resolve against THAT dir — git is worktree-transparent, and
  // showing the project root's branch would mislead.
  const session = useChatStore((s) =>
    activeChatSessionId ? s.sessions.find((x) => x.id === activeChatSessionId) : undefined,
  );
  const path = session?.worktreePath ?? project?.path ?? null;
  const gitStatus = projectId ? gitStatuses[projectId] : undefined;

  // Changed files for the +/- line counts.
  const [added, setAdded] = useState(0);
  const [deleted, setDeleted] = useState(0);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchOpen, setBranchOpen] = useState(false);
  const branchBtnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Commit modal state.
  const [commitModalOpen, setCommitModalOpen] = useState(false);

  // Register the commit modal with the UI store so native webviews hide.
  useEffect(() => {
    setModalOpen("git:commit-modal", commitModalOpen);
  }, [commitModalOpen, setModalOpen]);

  // Poll changed files and branches — gated on `path`. Event-driven via the
  // FS watcher with a 2s debounce so a burst of FS events doesn't thrash the
  // component. Uses `await` (not `.then()`) for the safeListen so the cleanup
  // closure reliably captures the unlisten function.
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      const cf = await getChangedFiles(path);
      if (cancelled || !cf) return;
      let a = 0, d = 0;
      for (const f of cf) { a += f.added; d += f.deleted; }
      setAdded(a);
      setDeleted(d);
      const bl = await listGitBranches(path);
      if (!cancelled) setBranches(bl ?? []);
    };

    const debouncedPoll = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void poll(); }, 2000);
    };

    void poll();

    const setup = async () => {
      const u = await safeListen<string>("project:fs-changed", (changedPath) => {
        if (cancelled) return;
        if (
          changedPath === path ||
          changedPath.startsWith(path + "\\") ||
          changedPath.startsWith(path + "/")
        ) {
          debouncedPoll();
        }
      });
      if (!cancelled) unlisten = u;
    };
    void setup();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [path]);

  // Outside-click handler for the portaled branch popover.
  // Skips clicks inside portaled modals (commit modal, dirty checkout, etc.)
  // since they render to <body> and would otherwise be seen as "outside".
  useEffect(() => {
    if (!branchOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideBtn = branchBtnRef.current?.contains(target);
      const insidePopover = popoverRef.current?.contains(target);
      // Don't close if the click is inside a portaled overlay (Modal, popover, etc.)
      const insideModal = target instanceof Element && target.closest(".modal-overlay") !== null;
      if (!insideBtn && !insidePopover && !insideModal) {
        setBranchOpen(false);
      }
    };
    const id = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [branchOpen]);

  // -- Plans: extract actual planning content from ASSISTANT messages.
  //    Looks for structured plans (numbered steps, "Plan:" sections, todo
  //    lists) that the model generated before implementing. Works for both
  //    CLI harness output and API chat responses.
  const messages = useChatStore((s) => s.messages);
  const plans = useMemo(() => {
    const found: { raw: string; label: string }[] = [];
    // Scan all assistant messages (newest first) for planning content
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const content = m.content || "";
      if (content.trim().length < 50) continue;

      // Try to find a "Plan" section header
      const planSection = extractPlanSection(content);
      if (planSection) {
        const label = planSectionTitle(planSection) || planSection.slice(0, 60).replace(/\n/g, " ");
        found.push({ raw: planSection, label });
      }
    }
    return found.slice(0, 10);
  }, [messages]);

  // Progress items — from completed tasks.
  const taskList = Object.values(tasks);
  const completed = taskList.filter((t) => t.state === "completed");
  const totalTasks = taskList.length;

  // Plan step counts
  const totalPlanStepsNum = planSteps.length;
  const completedPlanStepsNum = planSteps.filter((s) => s.status === "completed").length;

  // Open the ToolPanel Changes tab when the "changes" row is clicked.
  const openChanges = () => {
    addTab("files");
    setToolPanelCollapsed(false);
  };

  // Open a plan in its own tab in the tool panel.
  const openPlan = (plan: { raw: string; label: string }) => {
    const body = plan.raw.replace(/^#{1,3}\s+[^\n]+\n*/, "").trim();
    setPlanCanvas(body || plan.raw, plan.label);
    openPlanTab();
  };

  // The Plans list: APPROVED structured plans (present_plan → user accepted)
  // take priority; the prose scan stays as the fallback for sessions without
  // the plan tools (CLI harnesses), which still announce plans in text.
  const displayPlans: { raw: string; label: string; approved?: boolean }[] =
    acceptedPlans.length > 0
      ? acceptedPlans.map((p) => ({ raw: p.content, label: p.title, approved: true }))
      : plans;

  // Toggle the branch popover.
  const toggleBranchPopover = useCallback(() => {
    setBranchOpen((prev) => !prev);
  }, []);

  // ---- Always-mounted shell so the collapse/expand can animate smoothly.
  // The shell slides between a compact icon chip (48px) and the full panel
  // (260px). The header row holds the git-branch toggle icon plus the
  // "Git tools" title; the sections live in a body that collapses its
  // max-height and fades. The icon is the same element in both states.
  return (
    <>
    {/* NOTE: the branch popover below is a SIBLING of the shell, not a
        child — the shell's backdrop-filter makes it the containing block
        for position:fixed descendants, which trapped the popover inside
        the 260px shell (clipped invisible by overflow:hidden). As a
        sibling it anchors to the real viewport again. */}
    <div
      className={`git-sidebar${gitSidebarCollapsed ? " git-sidebar-collapsed" : ""}`}
    >
      <div className="git-sidebar-inner">
        <div className="git-sidebar-header">
          {/* Whole-sidebar collapse/expand. Same icon in both states. */}
          <button
            className="git-sidebar-collapse-btn"
            onClick={toggleGitSidebar}
            title={gitSidebarCollapsed ? "Expand git tools" : "Collapse git tools"}
            aria-label={gitSidebarCollapsed ? "Expand git tools" : "Collapse git tools"}
          >
            <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="4" cy="3" r="1.5" />
              <circle cx="4" cy="13" r="1.5" />
              <circle cx="12" cy="3" r="1.5" />
              <path d="M4 4.5v7" />
              <path d="M12 4.5c0 4-4 2-4 4.5" />
            </svg>
          </button>
          {/* Git-section disclosure toggle. */}
          <button
            className="git-sidebar-header-left"
            onClick={toggleGitSectionGit}
            title={gitSectionGitOpen ? "Collapse git" : "Expand git"}
            aria-expanded={gitSectionGitOpen}
            aria-controls="git-section-git"
          >
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M8 13h8" /><path d="M8 17h5" />
            </svg>
            <span className="git-sidebar-title">Git tools</span>
          </button>
        </div>

        {/* Body: the four sections. Collapses height + fades on whole-sidebar
            collapse; hidden from the a11y tree once the fade finishes. */}
        <div className="git-sidebar-body">

      {/* Top section: Git group (Changes / Branch / Commit rows).
          The section toggle is the "Git tools" title in the header above. */}
      <div className="git-sidebar-section">
        <div
          id="git-section-git"
          className={`git-section-collapse${gitSectionGitOpen ? " open" : ""}`}
          aria-hidden={!gitSectionGitOpen}
        >
          <div className="git-section-collapse-inner">
            <button
              className="git-sidebar-row"
              title="View changed files in the side panel"
              onClick={openChanges}
            >
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
              <span className="git-sidebar-row-label">changes</span>
              {added > 0 && <span className="git-sidebar-diff added">+{added.toLocaleString()}</span>}
              {deleted > 0 && <span className="git-sidebar-diff deleted">-{deleted.toLocaleString()}</span>}
            </button>

            {/* Branch row — opens BranchDropdown via portal anchored to button pos. */}
            <button
              ref={branchBtnRef}
              className={`git-sidebar-row${branchOpen ? " open" : ""}`}
              onClick={toggleBranchPopover}
              title="Switch branch"
            >
              <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="3" r="1.5" />
                <path d="M4 4.5v7" /><path d="M12 4.5c0 4-4 2-4 4.5" />
              </svg>
              <span className="git-sidebar-row-label">{gitStatus?.branch ?? "HEAD"}</span>
              <span className="git-sidebar-caret">▾</span>
            </button>

            <button
              className="git-sidebar-row"
              title="Commit or push changes"
              onClick={() => setCommitModalOpen(true)}
            >
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" /><path d="M3 12h6" /><path d="M15 12h6" />
              </svg>
              <span className="git-sidebar-row-label">Commit or push</span>
            </button>
          </div>
        </div>
      </div>

      {/* Plans section */}
      <div className="git-sidebar-section">
        <button
          className="git-sidebar-section-header"
          onClick={toggleGitSectionPlans}
          title={gitSectionPlansOpen ? "Collapse plans" : "Expand plans"}
          aria-expanded={gitSectionPlansOpen}
          aria-controls="git-section-plans"
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
            <circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" />
          </svg>
          <span className="git-sidebar-section-title">Plans</span>
        </button>
        <div
          id="git-section-plans"
          className={`git-section-collapse${gitSectionPlansOpen ? " open" : ""}`}
          aria-hidden={!gitSectionPlansOpen}
        >
          <div className="git-section-collapse-inner">
            {displayPlans.length === 0 ? (
              <div className="git-sidebar-empty">No plans yet.</div>
            ) : (
              <>
              {displayPlans.slice(0, SIDEBAR_VISIBLE_CAP).map((p, i) => (
                <button
                  key={i}
                  className="git-sidebar-plan"
                  onClick={() => openPlan(p)}
                  title={p.label}
                >
                  {p.approved ? (
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ color: "#3fb970" }}>
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" />
                      <path d="M12 7v4M12 11l-5 6M12 11l5 6" />
                    </svg>
                  )}
                  <span className="git-sidebar-plan-text">{p.label}…</span>
                </button>
              ))}
              {displayPlans.length > SIDEBAR_VISIBLE_CAP && (
                <SidebarMoreRow count={displayPlans.length - SIDEBAR_VISIBLE_CAP} label="plans">
                  {displayPlans.slice(SIDEBAR_VISIBLE_CAP).map((p, i) => (
                    <button
                      key={`more-${i}`}
                      className="git-sidebar-plan"
                      onClick={() => openPlan(p)}
                      title={p.label}
                    >
                      <span className="git-sidebar-plan-text">{p.label}…</span>
                    </button>
                  ))}
                </SidebarMoreRow>
              )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Progress section — plan steps + completed background tasks */}
      <div className="git-sidebar-section">
        <button
          className="git-sidebar-section-header"
          onClick={toggleGitSectionProgress}
          title={gitSectionProgressOpen ? "Collapse progress" : "Expand progress"}
          aria-expanded={gitSectionProgressOpen}
          aria-controls="git-section-progress"
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          <span className="git-sidebar-section-title">
            Progress {completedPlanStepsNum + completed.length}/{totalPlanStepsNum + totalTasks || completedPlanStepsNum + completed.length}
          </span>
        </button>
        <div
          id="git-section-progress"
          className={`git-section-collapse${gitSectionProgressOpen ? " open" : ""}`}
          aria-hidden={!gitSectionProgressOpen}
        >
          <div className="git-section-collapse-inner">
            {planSteps.length === 0 && completed.length === 0 ? (
              <div className="git-sidebar-empty">No progress yet.</div>
            ) : (
              <>
                {/* Plan steps — all statuses. Capped at the section budget:
                    the rest fold into the more-row's hover popover below. */}
                {planSteps.slice(0, SIDEBAR_VISIBLE_CAP).map((step) => (
                  <div
                    key={step.stepId}
                    className={`git-sidebar-progress-item progress-${step.status}`}
                    title={step.status === "failed" ? (step.failedReason ?? "Failed") : step.label}
                  >
                    {step.status === "completed" ? (
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    ) : step.status === "in_progress" ? (
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth={2} strokeLinecap="round">
                        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                      </svg>
                    ) : step.status === "failed" ? (
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth={2.5} strokeLinecap="round">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    ) : (
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth={2} strokeLinecap="round">
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                    <span
                      className={`git-sidebar-progress-text${step.status === "completed" ? " completed" : ""}`}
                    >
                      {step.label}
                    </span>
                  </div>
                ))}
                {/* Completed background tasks (downloads/shells) — fill the
                    slots the plan steps didn't use. */}
                {completed.slice(0, Math.max(0, SIDEBAR_VISIBLE_CAP - Math.min(planSteps.length, SIDEBAR_VISIBLE_CAP))).map((t) => (
                  <div key={t.taskId} className="git-sidebar-progress-item">
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    <span className="git-sidebar-progress-text">{t.message || t.kind}</span>
                  </div>
                ))}
                {(planSteps.length > SIDEBAR_VISIBLE_CAP ||
                  completed.length > Math.max(0, SIDEBAR_VISIBLE_CAP - Math.min(planSteps.length, SIDEBAR_VISIBLE_CAP))) && (
                  <SidebarMoreRow
                    count={
                      planSteps.length +
                      completed.length -
                      Math.min(planSteps.length, SIDEBAR_VISIBLE_CAP) -
                      Math.max(0, SIDEBAR_VISIBLE_CAP - Math.min(planSteps.length, SIDEBAR_VISIBLE_CAP))
                    }
                    label="items"
                  >
                    {planSteps.slice(SIDEBAR_VISIBLE_CAP).map((step) => (
                      <div
                        key={`more-${step.stepId}`}
                        className={`git-sidebar-progress-item progress-${step.status}`}
                        title={step.status === "failed" ? (step.failedReason ?? "Failed") : step.label}
                      >
                        <span className={`git-sidebar-progress-text${step.status === "completed" ? " completed" : ""}`}>
                          {step.label}
                        </span>
                      </div>
                    ))}
                    {completed
                      .slice(Math.max(0, SIDEBAR_VISIBLE_CAP - Math.min(planSteps.length, SIDEBAR_VISIBLE_CAP)))
                      .map((t) => (
                        <div key={`more-${t.taskId}`} className="git-sidebar-progress-item">
                          <span className="git-sidebar-progress-text">{t.message || t.kind}</span>
                        </div>
                      ))}
                  </SidebarMoreRow>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Agents section — active subagents in this session */}
      <div className="git-sidebar-section">
        <button
          className="git-sidebar-section-header"
          onClick={toggleGitSectionAgents}
          title={gitSectionAgentsOpen ? "Collapse agents" : "Expand agents"}
          aria-expanded={gitSectionAgentsOpen}
          aria-controls="git-section-agents"
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="19" cy="18" r="2" /><circle cx="5" cy="18" r="2" />
            <path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3" />
          </svg>
          <span className="git-sidebar-section-title">Agents</span>
          {Object.keys(subagents).length > 0 && (
            <span className="git-sidebar-section-badge">{Object.keys(subagents).length}</span>
          )}
        </button>
        <div
          id="git-section-agents"
          className={`git-section-collapse${gitSectionAgentsOpen ? " open" : ""}`}
          aria-hidden={!gitSectionAgentsOpen}
        >
          <div className="git-section-collapse-inner">
            {Object.keys(subagents).length === 0 ? (
              <div className="git-sidebar-empty">No active agents.</div>
            ) : (
              <>
              {Object.values(subagents).slice(0, SIDEBAR_VISIBLE_CAP).map((sub) => (
                <button
                  key={sub.id}
                  className={`git-sidebar-agent-row${sub.status === "running" ? " running" : ""}`}
                  onClick={() => openAgentsTab(sub.id)}
                  title={sub.task}
                >
                  <svg className="git-sidebar-agent-icon" width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="8" width="16" height="12" rx="2" />
                    <circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none" />
                    <circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none" />
                    <path d="M12 8V4M8 4h8" />
                  </svg>
                  <span className="git-sidebar-agent-label">SubAgent</span>
                  <span className="git-sidebar-agent-role">{sub.role}</span>
                  <span className="git-sidebar-agent-dot-sep" aria-hidden="true">·</span>
                  <span className="git-sidebar-agent-task">{sub.task}</span>
                </button>
              ))}
              {Object.values(subagents).length > SIDEBAR_VISIBLE_CAP && (
                <SidebarMoreRow count={Object.values(subagents).length - SIDEBAR_VISIBLE_CAP} label="agents">
                  {Object.values(subagents).slice(SIDEBAR_VISIBLE_CAP).map((sub) => (
                    <button
                      key={`more-${sub.id}`}
                      className={`git-sidebar-agent-row${sub.status === "running" ? " running" : ""}`}
                      onClick={() => openAgentsTab(sub.id)}
                      title={sub.task}
                    >
                      <span className="git-sidebar-agent-label">SubAgent</span>
                      <span className="git-sidebar-agent-role">{sub.role}</span>
                      <span className="git-sidebar-agent-task">{sub.task}</span>
                    </button>
                  ))}
                </SidebarMoreRow>
              )}
              </>
            )}
          </div>
        </div>
      </div>
        </div>
      </div>

      {/* Commit modal — centered in the chat view. */}
      {commitModalOpen && path && (
        <CommitModal
          path={path}
          branch={gitStatus?.branch ?? "HEAD"}
          chatSessionId={activeChatSessionId ?? ""}
          onClose={() => setCommitModalOpen(false)}
        />
      )}
    </div>

    {/* Branch popover — fixed viewport coords, viewport-anchored as long as
        NO ancestor here carries filter/transform (chat-view is clean). It
        must stay OUT of the glass shell: backdrop-filter would capture it. */}
    {branchOpen && (
      <div
        ref={popoverRef}
        className="git-sidebar-branch-popover-fixed"
        style={{
          position: "fixed",
          // Anchor to the LEFT of the sidebar: the popover's right edge
          // sits 8px left of the branch row's left edge, so it never
          // covers the git panel it was opened from.
          top: branchBtnRef.current?.getBoundingClientRect().top ?? 0,
          right:
            window.innerWidth -
            (branchBtnRef.current?.getBoundingClientRect().left ?? 0) +
            8,
          zIndex: 9999,
        }}
      >
        <BranchDropdown
          chatBound
          onClose={() => setBranchOpen(false)}
        />
      </div>
    )}
    </>
  );
}

// ---- Plan extraction helpers ----

// Same patterns as ChatView's PlanPreview — keep in sync.
const PLAN_HEADERS = [
  /^#{1,3}\s*(?:Plan|Planning|Approach|Strategy|Steps|Implementation|Proposed Solution|Game Plan|Roadmap|To[- ]Do|Action Plan)/im,
  /(?:^|\n\n)(?:Here(?:'s| is) (?:my |the |a |an )?(?:plan|approach|breakdown|strategy|outline|steps?))/im,
  /(?:^|\n\n)(?:Let me (?:(?:quickly )?(?:plan|outline|break(?:\s+down)?|sketch|lay out|map out|walk through)|explain (?:my |the )?(?:plan|approach|thinking)))/im,
  /(?:^|\n\n)(?:I(?:'ll| will) (?:plan|break|outline|do the following|take the following|proceed (?:as follows|in these steps)|tackle this (?:in |with )?steps?|start by))/im,
  /(?:^|\n\n)(?:My (?:plan|approach|strategy|recommendation|suggestion) (?:is|would be|:))/im,
  /(?:^|\n\n)(?:Here(?:'s| is) (?:how|what) I(?:'ll| will) (?:do|approach|proceed|tackle|handle|implement))/im,
  /(?:^|\n)(?:\d+[.)]\s+)(?:\*\*[^*]+\*\*\s*)?(?:\d+[.)]\s+)/m,
];

/** Try to extract a structured plan section from an assistant message.
 *  Returns the plan text (from the plan header to the next section or end),
 *  or null if no plan detected. */
function extractPlanSection(content: string): string | null {
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (cleaned.length < 50) return null;

  for (const pattern of PLAN_HEADERS) {
    const m = pattern.exec(cleaned);
    if (m && m.index >= 0) {
      const start = m.index;
      const after = cleaned.slice(start);
      // Take from plan header to next major section or ~500 chars
      const headerLen = m[0].length;
      const nextSection = after.slice(headerLen).search(/^#{1,3}\s+(?!Plan|Step)/m);
      const full = nextSection !== -1
        ? after.slice(0, headerLen + nextSection).trim()
        : after.slice(0, Math.min(after.length, 500)).trim();
      // Must have meaningful content after header
      if (full.slice(headerLen).trim().length < 30) continue;
      return full;
    }
  }

  // Fallback: check for numbered/bullet lists in first paragraph as plan
  const firstPara = cleaned.split(/\n\n+/)[0];
  if (!firstPara) return null;
  const lines = firstPara.split("\n").filter((l) => l.trim().length > 0);
  const planItems = lines.filter((l) => /^\s*(?:\d+[.)]\s|[-*]\s|•\s)/.test(l));
  if (planItems.length >= 3 && planItems.length >= lines.length * 0.5) {
    return firstPara.trim();
  }
  return null;
}

/** Generate a short title from a plan section. */
function planSectionTitle(plan: string): string {
  const firstLine = plan.split("\n")[0] || "";
  return firstLine
    .replace(/^#{1,3}\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/_/g, "")
    .replace(/`/g, "")
    .trim()
    .slice(0, 60);
}
