// First-run onboarding gating + wizard state (PRD §9).
//
// The wizard shows ONCE on a true first launch, gated by the
// `onboarding.completed` KV. Two rules make the gate safe:
//  * Upgrading installs (the flag predates the wizard) must never see it —
//    any profile with existing projects or sessions auto-completes silently.
//  * The decision runs only after the projects store has loaded, so the
//    wizard can't flash on every launch while stores boot.
// Skipping and finishing persist the same flag: the wizard never re-nags,
// and replays go through the command palette / Settings → Data.
//
// Finishing (or skipping past) the chat-model step also writes
// `localModels.onboarded`, so the standalone local-model nudge doesn't fire
// right after the user just made (or deferred) exactly that choice.
import { create } from "zustand";
import { getSetting, setSetting } from "../lib/ipc";
import { useProjectsStore } from "./projects";

export const K_ONBOARDING_COMPLETED = "onboarding.completed";
export const K_LOCAL_MODELS_ONBOARDED = "localModels.onboarded";

/** Step indices. The model step suppresses the standalone local-model nudge
 *  once seen (maxStep >= ONBOARDING_MODEL_STEP). */
export const ONBOARDING_MODEL_STEP = 1;
export const ONBOARDING_STEP_COUNT = 4;

interface OnboardingState {
  /** Gating resolved (flag read + upgrade heuristic done). */
  loaded: boolean;
  visible: boolean;
  step: number;
  /** Highest step reached — skips write-through per-step nudges. */
  maxStep: number;
  completed: boolean;
}

export const useOnboardingStore = create<OnboardingState>(() => ({
  loaded: false,
  visible: false,
  step: 0,
  maxStep: 0,
  completed: false,
}));

let initPromise: Promise<void> | null = null;

/** Boot-time gating. Singleton: concurrent callers share one decision. */
export function initOnboarding(): Promise<void> {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit(): Promise<void> {
  const done = await getSetting(K_ONBOARDING_COMPLETED).catch(() => null);
  const projects = useProjectsStore.getState();
  const existingUser = projects.projects.length > 0 || projects.sessions.length > 0;
  if (done || existingUser) {
    // Backfill the flag for upgrading installs so this check stays cheap.
    if (!done) void setSetting(K_ONBOARDING_COMPLETED, "1").catch(() => {});
    useOnboardingStore.setState({ loaded: true, completed: true, visible: false });
    return;
  }
  useOnboardingStore.setState({ loaded: true, visible: true, step: 0, maxStep: 0, completed: false });
}

/** Replay entry (command palette / Settings → Data). Always starts over. */
export function openOnboarding(): void {
  useOnboardingStore.setState({ visible: true, step: 0, maxStep: 0 });
}

function persistCompletion(): void {
  const { maxStep } = useOnboardingStore.getState();
  void setSetting(K_ONBOARDING_COMPLETED, "1").catch(() => {});
  if (maxStep >= ONBOARDING_MODEL_STEP) {
    void setSetting(K_LOCAL_MODELS_ONBOARDED, "1").catch(() => {});
  }
}

/** Finish or skip: persist the flag (both are consent to never re-nag) and
 *  hide the wizard. */
export function closeOnboarding(): void {
  persistCompletion();
  useOnboardingStore.setState({ visible: false, completed: true });
}

/** Leave the wizard through a deep-link (e.g. the Model Market): same
 *  persistence as finishing, so the flow doesn't re-open next launch. */
export function closeOnboardingForDeepLink(): void {
  closeOnboarding();
}

export function goToStep(step: number): void {
  useOnboardingStore.setState((s) => ({
    step,
    maxStep: Math.max(s.maxStep, step),
  }));
}
