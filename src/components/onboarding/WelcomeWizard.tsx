// First-run welcome wizard (PRD §9): a single skippable overlay shown once on
// a true first launch. Mounted lazily from App only while the onboarding
// store says visible, which keeps it out of the entry bundle for the 99% of
// launches (existing users) that never see it.
//
// Shell behavior mirrors Modal.tsx: portal to <body>, focus trap with focus
// restore, its own webview-occlusion id (M22). Escape = skip, and like Skip
// it persists the completed flag — the wizard never blocks or re-nags.
//
// Visuals port the approved onboarding-redesign.html mock: fixed 680px navy
// card, header = real logo + "N / 5" + clickable progress dots, directional
// step transitions (forward slides in from the right, back from the left),
// and a staggered rise on each step's content. The card carries its own
// palette so it renders identically in both app themes.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useOcclusion } from "../../hooks/useOcclusion";
import { AppLogo } from "../common/AppLogo";
import {
  closeOnboarding,
  goToStep,
  ONBOARDING_STEP_COUNT,
  useOnboardingStore,
} from "../../state/onboarding";
import { StepAgents } from "./steps/StepAgents";
import { StepDefaults } from "./steps/StepDefaults";
import { StepMeet } from "./steps/StepMeet";
import { StepPath } from "./steps/StepPath";
import { StepWorkspace } from "./steps/StepWorkspace";

const STEPS = [
  { Component: StepMeet, label: "Get Started", hasBack: false },
  { Component: StepPath, label: "Next", hasBack: true },
  { Component: StepAgents, label: "Next", hasBack: true },
  { Component: StepWorkspace, label: "Continue", hasBack: true },
  { Component: StepDefaults, label: "Finish", hasBack: true },
];

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function WelcomeWizard() {
  const step = useOnboardingStore((s) => s.step);
  const boxRef = useRef<HTMLDivElement>(null);
  // Previous step ref → transition direction. The entering step's CSS reads
  // it via the data-dir attribute on the body wrapper.
  const prevStepRef = useRef(step);
  const dir = step >= prevStepRef.current ? "fwd" : "back";
  prevStepRef.current = step;
  // Occlusion (M22): native browser panes must hide at the OS level while
  // the wizard is up, each popup under its own id.
  useOcclusion("app:onboarding-wizard", true);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    const initial = focusables()[0] ?? box;
    initial.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeOnboarding();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !box.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !box.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, []);

  const isLast = step === STEPS.length - 1;
  const { Component, label, hasBack } = STEPS[step];

  return createPortal(
    <div className="onboarding-overlay">
      <div
        ref={boxRef}
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Relay"
        tabIndex={-1}
      >
        <header className="onboarding-head">
          <span className="onboarding-brand">
            <AppLogo size={26} />
            <span>Relay</span>
          </span>
          <div className="onboarding-head-right">
            {!isLast && (
              <button type="button" className="onboarding-skip" onClick={closeOnboarding}>
                Skip
              </button>
            )}
            <span className="onboarding-progress-label">
              {step + 1} / {ONBOARDING_STEP_COUNT}
            </span>
            <div className="onboarding-dots" role="group" aria-label="Setup progress">
              {STEPS.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className={`onboarding-dot${i === step ? " current" : ""}${i < step ? " done" : ""}`}
                  aria-label={`Go to step ${i + 1}`}
                  aria-current={i === step ? "step" : undefined}
                  onClick={() => goToStep(i)}
                />
              ))}
            </div>
          </div>
        </header>

        {/* key={step} re-runs the step's entrance animation on navigation;
            data-dir picks the slide direction. */}
        <div className="onboarding-body" key={step} data-dir={dir}>
          <div className="onboarding-step" data-step={step + 1}>
            <Component />
          </div>
        </div>

        <footer className={`onboarding-foot${step === 0 ? " foot-end" : ""}`}>
          {hasBack && (
            <button type="button" className="onboarding-btn onboarding-btn-ghost" onClick={() => goToStep(step - 1)}>
              <span aria-hidden="true">←</span> Back
            </button>
          )}
          <span className="onboarding-foot-spacer" />
          <button
            type="button"
            className="onboarding-btn onboarding-btn-primary"
            onClick={() => (isLast ? closeOnboarding() : goToStep(step + 1))}
          >
            {label}
            <span aria-hidden="true">→</span>
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
