// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";

// ---- Budget / spend alerts (roadmap #10) ----

export interface BudgetConfig {
  projectId: string;
  monthlyUsd: number;
  thresholdPct: number;
}

export interface BudgetAlertPayload {
  projectId: string;
  projectName: string;
  monthlyUsd: number;
  spentUsd: number;
  usedPct: number;
}

export const listBudgets = () => safeInvoke<BudgetConfig[] | null>("list_budgets");
export const setBudget = (projectId: string, monthlyUsd: number, thresholdPct?: number) =>
  safeInvoke<BudgetConfig | null>("set_budget", {
    projectId,
    monthlyUsd,
    thresholdPct: thresholdPct ?? null,
  });
export const removeBudget = (projectId: string) =>
  safeInvoke<void>("remove_budget", { projectId });
export const checkBudgets = () =>
  safeInvoke<BudgetAlertPayload[] | null>("check_budgets");

// Projects show up on the Cost page automatically once they accrue spend;
// these hide/unhide them from that page's per-project list (display-only —
// usage data and configured budgets are untouched).
export const listHiddenCostProjects = () =>
  safeInvoke<string[] | null>("list_hidden_cost_projects");
export const hideCostProject = (projectId: string) =>
  safeInvoke<void>("hide_cost_project", { projectId });
export const unhideCostProject = (projectId: string) =>
  safeInvoke<void>("unhide_cost_project", { projectId });

// ── Self-improving artifacts (SELF_IMPROVING_ARTIFACTS.md P0) ────────────

export interface ImproveArtifact {
  id: string;
  kind: "skill" | "loop" | "prompt_template" | "automation";
  refKey: string;
  name: string;
  createdAt: number;
}

export interface ImproveVersion {
  id: string;
  artifactId: string;
  version: number;
  body: string;
  metaJson: string | null;
  origin: string;
  parentVersion: number | null;
  createdAt: number;
}

export interface LoopSessionRecord {
  id: string;
  chatSessionId: string;
  goal: string;
  iteration: number;
  maxIterations: number;
  status: string;
  runId: string | null;
}

export const listImproveArtifacts = () =>
  safeInvoke<ImproveArtifact[] | null>("list_improve_artifacts");
export const listImproveVersions = (artifactId: string) =>
  safeInvoke<ImproveVersion[] | null>("list_improve_versions", { artifactId });
export const setImproveChannel = (artifactId: string, channel: string, version: number) =>
  safeInvoke<void>("set_improve_channel", { artifactId, channel, version });
/** Record one execution of a frontend-known artifact (e.g. template fill). */
export const recordArtifactRun = (
  chatSessionId: string,
  kind: string,
  refKey: string,
  name: string,
  body: string,
) =>
  safeInvoke<string | null>("record_artifact_run", {
    chatSessionId,
    kind,
    refKey,
    name,
    body,
  });
/** Close the session's open runs: `applied` on turn success, `failed`+code on error. */
export const finishArtifactRuns = (
  chatSessionId: string,
  outcome: string,
  errorCode?: string,
) =>
  safeInvoke<number | null>("finish_artifact_runs", {
    chatSessionId,
    outcome,
    errorCode: errorCode ?? null,
  });
export const recordArtifactFeedback = (
  chatSessionId: string | null,
  verdict: "up" | "down",
  reason?: string,
  artifactId?: string,
) =>
  safeInvoke<void>("record_artifact_feedback", {
    chatSessionId,
    artifactId: artifactId ?? null,
    verdict,
    reason: reason ?? null,
  });

export const loopSessionStart = (chatSessionId: string, goal: string, maxIterations: number) =>
  safeInvoke<LoopSessionRecord | null>("loop_session_start", {
    chatSessionId,
    goal,
    maxIterations,
  });
export const loopSessionAdvance = (loopId: string, iteration: number) =>
  safeInvoke<void>("loop_session_advance", { loopId, iteration });
export const loopSessionFinish = (loopId: string, status: string) =>
  safeInvoke<void>("loop_session_finish", { loopId, status });
export const getLoopSession = (loopId: string) =>
  safeInvoke<LoopSessionRecord | null>("get_loop_session", { loopId });
export const latestLoopSession = (chatSessionId: string) =>
  safeInvoke<LoopSessionRecord | null>("latest_loop_session", { chatSessionId });

export interface ImproveProposal {
  id: string;
  artifactId: string;
  baseVersion: number;
  candidateVersion: number;
  changeSummary: string;
  rootCausesJson: string | null;
  expectedEffect: string | null;
  riskNotes: string | null;
  status: "open" | "evaluating" | "passed" | "failed_eval" | "applied" | "rejected" | "stale";
  evalRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

export const listImprovementProposals = (status?: string) =>
  safeInvoke<ImproveProposal[] | null>("list_improvement_proposals", { status: status ?? null });
export const runImprovementSweep = () =>
  safeInvoke<ImproveProposal[] | null>("run_improvement_sweep");
export const evaluateImprovementProposal = (proposalId: string) =>
  safeInvoke<string | null>("evaluate_improvement_proposal", { proposalId });
export const applyImprovementProposal = (proposalId: string) =>
  safeInvoke<void>("apply_improvement_proposal", { proposalId });
export const rejectImprovementProposal = (proposalId: string) =>
  safeInvoke<void>("reject_improvement_proposal", { proposalId });
export interface ImproveEvalCase {
  id: string;
  artifactId: string;
  inputText: string;
  expectJson: string;
  source: string;
  enabled: boolean;
  createdAt: number;
}
export const listImproveEvalCases = (artifactId: string) =>
  safeInvoke<ImproveEvalCase[] | null>("list_improve_eval_cases", { artifactId });

export const setImproveAutonomy = (artifactId: string, tier: "manual" | "auto" | "canary") =>
  safeInvoke<void>("set_improve_autonomy", { artifactId, tier });
export const getImproveAutonomy = (artifactId: string) =>
  safeInvoke<string | null>("get_improve_autonomy", { artifactId });
export const checkImprovementCanaries = () =>
  safeInvoke<string[] | null>("check_improvement_canaries");

/** Stream `budget:alert` events (threshold crossed) — drives the in-app toast. */
export const onBudgetAlert = (handler: (p: BudgetAlertPayload) => void) =>
  safeListen<BudgetAlertPayload>("budget:alert", handler);
