// The plan-approval card for `present_plan`: the model's proposed APPROACH
// (markdown) is shown in the plan-preview "notch" style — the same visual
// language as the classic plan preview card — and the turn is PAUSED until
// the user approves (exits plan mode, unlocks mutations) or rejects with
// feedback (the text goes back to the model so it can revise). Execution
// steps come separately, after approval, via the model's todo_write calls.
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PendingPlanProposal } from "../../state/chat";
import { useUiStore } from "../../state/ui";

export function PlanProposalCard({
  proposal,
  onResolve,
}: {
  proposal: PendingPlanProposal;
  onResolve: (approved: boolean, feedback?: string) => void;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const setPlanCanvas = useUiStore((s) => s.setPlanCanvas);
  const openPlanTab = useUiStore((s) => s.openPlanTab);

  const reject = () => {
    if (!feedbackOpen) {
      setFeedbackOpen(true);
      return;
    }
    onResolve(false, feedback.trim() || undefined);
  };

  const expand = () => {
    setPlanCanvas(proposal.plan, proposal.title);
    openPlanTab();
  };

  return (
    <div
      className="plan-proposal-card"
      role="dialog"
      aria-label="Plan approval"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !feedbackOpen) onResolve(true);
        else if (e.key === "Escape") reject();
      }}
    >
      <div className="plan-preview-title">
        <svg className="plan-preview-icon" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
          <rect x="9" y="3" width="6" height="4" rx="1" />
          <path d="M9 14l2 2 4-4" />
        </svg>
        <span className="plan-proposal-heading" title={proposal.title}>{proposal.title}</span>
        <span className="plan-proposal-badge">PLAN</span>
      </div>
      <div className="plan-preview-hint">
        The model is paused — approve this approach to unlock changes. Steps
        will be tracked in Progress.
      </div>
      <div className="plan-proposal-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{proposal.plan}</ReactMarkdown>
      </div>
      {feedbackOpen && (
        <textarea
          className="plan-proposal-feedback"
          placeholder="What should change? (optional)"
          value={feedback}
          rows={2}
          autoFocus
          onChange={(e) => setFeedback(e.target.value)}
        />
      )}
      <div className="plan-preview-actions">
        <button type="button" className="plan-preview-btn expand" onClick={reject}>
          {feedbackOpen ? "Send rejection" : "Reject"}
        </button>
        <button type="button" className="plan-preview-btn expand" onClick={expand}>
          Expand
        </button>
        <button
          type="button"
          className="plan-preview-btn agree"
          onClick={() => onResolve(true)}
        >
          Approve plan
        </button>
      </div>
    </div>
  );
}
