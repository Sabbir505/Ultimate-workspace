// The harness question card. Claude Code's AskUserQuestion arrives over the
// can_use_tool control protocol and pauses the harness turn until the user
// answers; the no-protocol harnesses (kimi/opencode/pi/omp/commandcode) ask
// via the RELAY_ASK marker and get the answer as a follow-up turn. Either
// way it renders here — a lean notched glass card docked on the composer.
// Single-select questions pick one option; multi-select questions toggle; a
// free-text field sends the protocol's top-level `response`. Skip resolves
// as "dismissed" so the model proceeds on its own. Option descriptions (the
// protocol carries them) show as hover tooltips to keep the card lean.
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
    <div className="question-card" role="dialog" aria-label="Agent question">
      <div className="question-card-head">
        <span className="question-card-badge">QUESTION</span>
        <span className="question-card-title">The agent needs your input</span>
      </div>
      {questions.map((q) => (
        <div className="question-block" key={q.question}>
          <div className="question-text">{q.question}</div>
          <div className="question-options">
            {(q.options ?? []).map((opt) => {
              const isPicked = q.multiSelect
                ? Array.isArray(selections[q.question]) &&
                  (selections[q.question] as string[]).includes(opt.label)
                : selections[q.question] === opt.label;
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={`question-option${isPicked ? " picked" : ""}`}
                  title={[opt.label, opt.description].filter(Boolean).join(" — ")}
                  onClick={() =>
                    q.multiSelect ? toggleMulti(q, opt.label) : pickSingle(q, opt.label)
                  }
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
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
      <div className="question-card-actions">
        <button
          type="button"
          className="question-btn"
          onClick={() => onResolve({}, undefined, true)}
        >
          Skip
        </button>
        <button
          type="button"
          className="question-btn primary"
          disabled={!canSubmit}
          onClick={submit}
        >
          Answer
        </button>
      </div>
    </div>
  );
}
