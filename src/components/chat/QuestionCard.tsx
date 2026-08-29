// The harness question card. Claude Code's AskUserQuestion arrives over the
// can_use_tool control protocol and pauses the harness turn until the user
// answers — rendered here, in the same composer slot as the approval and
// plan-proposal cards. Single-select questions pick one option; multi-select
// questions toggle; an optional free-text field sends the protocol's
// top-level `response` (a freeform reply that replaces the structured
// answers). Skip resolves as "dismissed" so the model proceeds on its own.
import { useMemo, useState } from "react";
import type { ChatQuestionInput } from "../../lib/ipc";
import type { PendingQuestion } from "../../state/chat";

export function QuestionCard({
  question,
  onResolve,
}: {
  question: PendingQuestion;
  /** `skipped` = no selections and no free text (the backend maps that to a
   *  dismiss so the model continues without waiting). */
  onResolve: (
    answers: Record<string, string | string[]>,
    response: string | undefined,
    skipped: boolean,
  ) => void;
}) {
  const questions: ChatQuestionInput[] = useMemo(
    () =>
      (question.questions ?? []).filter(
        (q): q is ChatQuestionInput =>
          !!q && typeof q === "object" && typeof (q as ChatQuestionInput).question === "string",
      ),
    [question.questions],
  );
  // question text → chosen label (single) or labels (multi).
  const [selections, setSelections] = useState<Record<string, string | string[]>>({});
  const [freeText, setFreeText] = useState("");

  const pickSingle = (q: ChatQuestionInput, label: string) => {
    setSelections((s) => ({ ...s, [q.question]: label }));
  };
  const toggleMulti = (q: ChatQuestionInput, label: string) => {
    setSelections((s) => {
      const current = Array.isArray(s[q.question]) ? (s[q.question] as string[]) : [];
      const next = current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label];
      return { ...s, [q.question]: next };
    });
  };

  const hasSelections = Object.values(selections).some(
    (v) => (Array.isArray(v) && v.length > 0) || (!Array.isArray(v) && v !== undefined),
  );
  const canSubmit = hasSelections || freeText.trim().length > 0;

  const submit = () => {
    // Only include answered questions — unanswered ones stay out of the
    // answers map (the model sees which questions were left blank).
    const answers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(selections)) {
      if (Array.isArray(v) ? v.length > 0 : v !== undefined) answers[k] = v;
    }
    const response = freeText.trim() || undefined;
    onResolve(answers, response, Object.keys(answers).length === 0 && !response);
  };

  return (
    <div className="approval-card approval-card-question" role="dialog" aria-label="Agent question">
      <span className="approval-badge">QUESTION</span>
      <span className="approval-card-title">
        The agent needs your input before it can continue
      </span>
      {questions.map((q) => {
        const selected = selections[q.question];
        return (
          <div className="question-block" key={q.question}>
            <div className="question-header">
              {q.header && <span className="question-chip">{q.header}</span>}
              <span className="question-text">{q.question}</span>
            </div>
            {Array.isArray(q.options) && q.options.length > 0 && (
              <div className={`question-options${q.multiSelect ? " multi" : ""}`}>
                {q.options.map((opt) => {
                  const isPicked = q.multiSelect
                    ? Array.isArray(selected) && (selected as string[]).includes(opt.label)
                    : selected === opt.label;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className={`question-option${isPicked ? " picked" : ""}`}
                      title={opt.description}
                      onClick={() =>
                        q.multiSelect ? toggleMulti(q, opt.label) : pickSingle(q, opt.label)
                      }
                    >
                      <span className="question-option-label">{opt.label}</span>
                      {opt.description && (
                        <span className="question-option-desc">{opt.description}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <input
        type="text"
        className="question-free-text"
        placeholder="Or type your own answer…"
        value={freeText}
        onChange={(e) => setFreeText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSubmit) submit();
        }}
      />
      <div className="approval-card-actions">
        <button
          type="button"
          className="approval-btn deny"
          onClick={() => onResolve({}, undefined, true)}
        >
          Skip
        </button>
        <button
          type="button"
          className="approval-btn approve"
          disabled={!canSubmit}
          onClick={submit}
        >
          Answer
        </button>
      </div>
    </div>
  );
}
