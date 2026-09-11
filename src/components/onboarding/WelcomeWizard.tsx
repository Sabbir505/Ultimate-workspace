// First-run welcome wizard (PRD §9): a single skippable overlay shown once on
// a true first launch. Mounted lazily from App only while the onboarding
// store says visible, which keeps it out of the entry bundle for the 99% of
// launches (existing users) that never see it.
//
// Shell behavior mirrors Modal.tsx: portal to <body>, focus trap with focus
// restore, its own webview-occlusion id (M22). Escape = skip, and like Skip
// it persists the completed flag — the wizard never blocks or re-nags.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useOcclusion } from "../../hooks/useOcclusion";
import {
  closeOnboarding,
  goToStep,
  ONBOARDING_STEP_COUNT,
  useOnboardingStore,
} from "../../state/onboarding";
import { StepChatModel } from "./steps/StepChatModel";
import { StepFinish } from "./steps/StepFinish";
import { StepHarnesses } from "./steps/StepHarnesses";
import { StepWelcome } from "./steps/StepWelcome";

const STEPS = [StepWelcome, StepChatModel, StepHarnesses, StepFinish];

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function WelcomeWizard() {
  const step = useOnboardingStore((s) => s.step);
  const boxRef = useRef<HTMLDivElement>(null);
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
  const Current = STEPS[step];

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
          <span className="onboarding-brand">RELAY</span>
          {!isLast && (
            <button type="button" className="onboarding-skip" onClick={closeOnboarding}>
              Skip
            </button>
          )}
        </header>

        <div
          className="onboarding-progress"
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={ONBOARDING_STEP_COUNT}
          aria-valuenow={step + 1}
          aria-label="Setup progress"
        >
          <div
            className="onboarding-progress-fill"
            style={{ width: `${((step + 1) / ONBOARDING_STEP_COUNT) * 100}%` }}
          />
        </div>

        {/* key={step} re-runs the step's entrance animation on navigation. */}
        <div className="onboarding-body" key={step}>
          <Current />
        </div>

        <footer className="onboarding-foot">
          <span className="onboarding-step-label">
            Step {step + 1} of {ONBOARDING_STEP_COUNT}
          </span>
          <span className="onboarding-foot-spacer" />
          {step > 0 && (
            <button type="button" className="onboarding-btn" onClick={() => goToStep(step - 1)}>
              Back
            </button>
          )}
          {isLast ? (
            <button type="button" className="onboarding-btn onboarding-btn-primary" onClick={closeOnboarding}>
              Done
            </button>
          ) : (
            <button type="button" className="onboarding-btn onboarding-btn-primary" onClick={() => goToStep(step + 1)}>
              Continue
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
