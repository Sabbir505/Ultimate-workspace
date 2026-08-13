// Full vertical Git tools sidebar panel — a single continuous dark panel on
// the right side of the app. Contains: a header with a collapse button,
// a top section with Changes/Branch/Commit rows, a Plans section, and a
// Progress section.
//
// Row behaviours:
//   "changes" → opens the ToolPanel's Changes (files) tab.
//   branch name → opens the BranchDropdown popover via portal (top-right area).
//   "Commit or push" → opens the CommitModal centered in the chat view.
//   plan row → opens the plan markdown in the ToolPanel's Canvas tab.
//
// Collapsed state: a thin ~50px strip showing just the last plan header in
//   one sentence — the git icon toggles this.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getChangedFiles,
  listGitBranches,
  safeListen,
  type BranchInfo,
} from "../../lib/ipc";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { BranchDropdown } from "./BranchDropdown";
import { CommitModal } from "./CommitModal";
import { usePlanTracker } from "../../hooks/usePlanTracker";

export function GitToolsSidebar() {
  const boundProjectId = useChatStore((s) =>
    s.activeChatSessionId ? s.sessionProjects[s.activeChatSessionId] : undefined,
  );
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const projects = useProjectsStore((s) => s.projects);
  const gitStatuses = useProjectsStore((s) => s.gitStatuses);
  const tasks = useChatStore((s) =>
    s.activeChatSessionId ? s.tasks[s.activeChatSessionId] ?? {} : {},
  );
  const planSteps = useChatStore((s) =>
    s.activeChatSessionId ? s.planSteps[s.activeChatSessionId] ?? [] : [],
  );
  const subagents = useChatStore((s) =>
    s.activeChatSessionId ? s.subagents[s.activeChatSessionId] ?? {} : {},
  );

  // Activate plan-step parsing and completion tracking
  usePlanTracker();

  // Tool panel / UI store hooks — select individually to avoid churn.
  const setToolPanelTab = useUiStore((s) => s.setToolPanelTab);
  const setToolPanelCollapsed = useUiStore((s) => s.setToolPanelCollapsed);
  const setPlanCanvas = useUiStore((s) => s.setPlanCanvas);
  const setActiveSubagentId = useUiStore((s) => s.setActiveSubagentId);
  const gitSidebarCollapsed = useUiStore((s) => s.gitSidebarCollapsed);
  const toggleGitSidebar = useUiStore((s) => s.toggleGitSidebar);
  const setModalOpen = useUiStore((s) => s.setModalOpen);

  const projectId = boundProjectId ?? selectedProjectId;
  const project = projects.find((p) => p.id === projectId);
  const path = project?.path ?? null;
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

  // Last plan summary line for the collapsed strip.
  const lastPlanSummary = plans.length > 0 ? plans[0].label : null;

  // Progress items — from completed tasks.
  const taskList = Object.values(tasks);
  const completed = taskList.filter((t) => t.state === "completed");
  const totalTasks = taskList.length;

  // Plan step counts
  const totalPlanStepsNum = planSteps.length;
  const completedPlanStepsNum = planSteps.filter((s) => s.status === "completed").length;

  // Open the ToolPanel Changes tab when the "changes" row is clicked.
  const openChanges = () => {
    setToolPanelTab("files");
    setToolPanelCollapsed(false);
  };

  // Open a plan in the Canvas tab.
  const openPlan = (plan: { raw: string; label: string }) => {
    const body = plan.raw.replace(/^#{1,3}\s+[^\n]+\n*/, "").trim();
    setPlanCanvas(body || plan.raw, plan.label);
    setToolPanelTab("canvas");
    setToolPanelCollapsed(false);
  };

  // Toggle the branch popover.
  const toggleBranchPopover = useCallback(() => {
    setBranchOpen((prev) => !prev);
  }, []);

  // ---- Collapsed state ----
  if (gitSidebarCollapsed) {
    return (
      <div className="git-sidebar git-sidebar-collapsed">
        <button
          className="git-sidebar-expand-btn"
          onClick={toggleGitSidebar}
          title="Expand Git tools"
        >
          {/* Git branch icon */}
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="4" cy="3" r="1.5" />
            <circle cx="4" cy="13" r="1.5" />
            <circle cx="12" cy="3" r="1.5" />
            <path d="M4 4.5v7" />
            <path d="M12 4.5c0 4-4 2-4 4.5" />
          </svg>
        </button>
        {lastPlanSummary && (
          <div className="git-sidebar-collapsed-summary" title={lastPlanSummary}>
            {lastPlanSummary}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="git-sidebar">
      {/* Header */}
      <div className="git-sidebar-header">
        <div className="git-sidebar-header-left">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M8 13h8" /><path d="M8 17h5" />
          </svg>
          <span className="git-sidebar-title">Git tools</span>
        </div>
        <button
          className="git-sidebar-collapse-btn"
          onClick={toggleGitSidebar}
          title="Toggle Git tools sidebar"
        >
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="3" r="1.5" />
            <path d="M4 4.5v7" /><path d="M12 4.5c0 4-4 2-4 4.5" />
          </svg>
        </button>
      </div>

      {/* Top section: Changes / Branch / Commit rows */}
      <div className="git-sidebar-section">
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

      {/* Plans section */}
      <div className="git-sidebar-section">
        <div className="git-sidebar-section-header">
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
            <circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" />
          </svg>
          <span className="git-sidebar-section-title">Plans</span>
        </div>
        {plans.length === 0 ? (
          <div className="git-sidebar-empty">No plans yet.</div>
        ) : (
          plans.map((p, i) => (
            <button
              key={i}
              className="git-sidebar-plan"
              onClick={() => openPlan(p)}
              title={p.label}
            >
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" />
                <path d="M12 7v4M12 11l-5 6M12 11l5 6" />
              </svg>
              <span className="git-sidebar-plan-text">{p.label}…</span>
            </button>
          ))
        )}
      </div>

      {/* Progress section — plan steps + completed background tasks */}
      <div className="git-sidebar-section">
        <div className="git-sidebar-section-header">
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          <span className="git-sidebar-section-title">
            Progress {completedPlanStepsNum + completed.length}/{totalPlanStepsNum + totalTasks || completedPlanStepsNum + completed.length}
          </span>
        </div>
        {planSteps.length === 0 && completed.length === 0 ? (
          <div className="git-sidebar-empty">No progress yet.</div>
        ) : (
          <>
            {/* Plan steps — all statuses */}
            {planSteps.map((step) => (
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
            {/* Completed background tasks (downloads/shells) — unchanged */}
            {completed.map((t) => (
              <div key={t.taskId} className="git-sidebar-progress-item">
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span className="git-sidebar-progress-text">{t.message || t.kind}</span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Agents section — active subagents in this session */}
      <div className="git-sidebar-section">
        <div className="git-sidebar-section-header">
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="19" cy="18" r="2" /><circle cx="5" cy="18" r="2" />
            <path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3" />
          </svg>
          <span className="git-sidebar-section-title">Agents</span>
          {Object.keys(subagents).length > 0 && (
            <span className="git-sidebar-section-badge">{Object.keys(subagents).length}</span>
          )}
        </div>
        {Object.keys(subagents).length === 0 ? (
          <div className="git-sidebar-empty">No active agents.</div>
        ) : (
          Object.values(subagents).map((sub) => (
            <button
              key={sub.id}
              className="git-sidebar-plan git-sidebar-agent"
              onClick={() => {
                setActiveSubagentId(sub.id);
                setToolPanelTab("agents");
              }}
              title={sub.task}
            >
              <span className={`chat-subagent-dot ${sub.status}`} />
              <span className="git-sidebar-plan-text">{sub.role}: {sub.task.length > 30 ? `${sub.task.slice(0, 30)}…` : sub.task}</span>
            </button>
          ))
        )}
      </div>

      {/* Branch popover — rendered inline with position:fixed to escape
          sidebar overflow without createPortal (which was causing WebView crashes). */}
      {branchOpen && (
        <div
          ref={popoverRef}
          className="git-sidebar-branch-popover-fixed"
          style={{
            position: "fixed",
            top: (branchBtnRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
            right: window.innerWidth - (branchBtnRef.current?.getBoundingClientRect().right ?? 0),
            zIndex: 9999,
          }}
        >
          <BranchDropdown onClose={() => setBranchOpen(false)} />
        </div>
      )}

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
