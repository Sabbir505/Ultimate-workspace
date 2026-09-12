// Step 2 — Choose your path. Experience-level radio cards from the approved
// mock. The choice tailors nothing critical, so it stays in-memory (store
// state only) — no settings write for a preference the app doesn't act on.
import { setOnboardingPath, useOnboardingStore } from "../../../state/onboarding";

const OPTIONS = [
  {
    id: "experienced" as const,
    title: "I already use AI coding agents",
    hint: "I'm familiar with tools like Claude Code, Kimi Code, OpenCode, etc.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
  {
    id: "newcomer" as const,
    title: "I'm new to AI coding agents",
    hint: "I want to learn how AI agents can help me build and work faster.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" />
      </svg>
    ),
  },
];

export function StepPath() {
  const path = useOnboardingStore((s) => s.path);

  return (
    <>
      <div className="onboarding-eyebrow onb-rise">How do you want to work?</div>
      <h2 className="onboarding-title onb-rise">Choose your path</h2>
      <p className="onboarding-lede onb-rise">
        Tell us a bit about your experience. You can always change this later in settings.
      </p>
      <div className="onboarding-stack" role="radiogroup" aria-label="Your experience">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={path === o.id}
            className={`onboarding-radio-card onb-rise${path === o.id ? " selected" : ""}`}
            onClick={() => setOnboardingPath(o.id)}
          >
            <span className="onboarding-radio-icon">{o.icon}</span>
            <span className="onboarding-radio-copy">
              <b>{o.title}</b>
              <span>{o.hint}</span>
            </span>
            <span className="onboarding-radio-dot" aria-hidden="true" />
          </button>
        ))}
      </div>
    </>
  );
}
