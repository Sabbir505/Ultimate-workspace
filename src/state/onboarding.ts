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
// Reaching the agent step (or finishing) also writes `localModels.onboarded`,
// so the standalone local-model nudge doesn't fire right after the user just
// saw — or deliberately opened — exactly that choice.
//
// The 5-step flow (matching the approved onboarding-redesign.html mock):
// 0 Meet Relay · 1 Choose your path · 2 Pick an agent · 3 Workspace ·
// 4 Set your defaults. The defaults step writes two REAL settings directly
// on selection: `chat.defaultApproval` (new-session posture — read back by
// db::create_chat_session) and the provider default model
// (set_chat_default_model).
import { create } from "zustand";
import { getSetting, setSetting } from "../lib/ipc";
import { useProjectsStore } from "./projects";

export const K_ONBOARDING_COMPLETED = "onboarding.completed";
export const K_LOCAL_MODELS_ONBOARDED = "localModels.onboarded";
/** New-session approval posture ("manual" | "read_only" | "full_auto" — the
 *  legacy PermissionMode vocabulary). Read by create_chat_session; unset
 *  keeps the historical full-auto default. */
export const K_DEFAULT_APPROVAL = "chat.defaultApproval";

/** Step indices. The agent step carries the Local Model row, so reaching it
 *  suppresses the standalone local-model nudge (maxStep >= ONBOARDING_AGENT_STEP). */
export const ONBOARDING_AGENT_STEP = 2;
export const ONBOARDING_STEP_COUNT = 5;

/** Step 2 radio choice — in-memory tailoring only (not persisted). */
export type OnboardingPath = "experienced" | "newcomer";

interface OnboardingState {
  /** Gating resolved (flag read + upgrade heuristic done). */
  loaded: boolean;
  visible: boolean;
  step: number;
  /** Highest step reached — skips write-through per-step nudges. */
  maxStep: number;
  completed: boolean;
  path: OnboardingPath | null;
}

export const useOnboardingStore = create<OnboardingState>(() => ({
  loaded: false,
  visible: false,
  step: 0,
  maxStep: 0,
  completed: false,
  path: null,
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
  useOnboardingStore.setState({ loaded: true, visible: true, step: 0, maxStep: 0, completed: false, path: null });
}

/** Replay entry (command palette / Settings → Data). Always starts over. */
export function openOnboarding(): void {
  useOnboardingStore.setState({ visible: true, step: 0, maxStep: 0, path: null });
}

function persistCompletion(): void {
  const { maxStep } = useOnboardingStore.getState();
  void setSetting(K_ONBOARDING_COMPLETED, "1").catch(() => {});
  if (maxStep >= ONBOARDING_AGENT_STEP) {
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

export function setOnboardingPath(path: OnboardingPath): void {
  useOnboardingStore.setState({ path });
}
