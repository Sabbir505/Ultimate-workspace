// Shared helpers for the Automations view + Past Runs table (kept here so
// the lazy-loaded table can import them without a circular dependency).

/** A failure is any status that isn't one of the three sentinel values —
 *  everything else is raw error text recorded by the runner. */
export function isFailureStatus(status: string | null | undefined): boolean {
  return !!status && status !== "ok" && status !== "skipped" && status !== "running";
}

export interface FriendlyError {
  /** One-line plain-language description of what went wrong. */
  text: string;
  /** Optional suggested next step. */
  hint?: string;
}

const FRIENDLY_ERROR_MATCHERS: { test: RegExp; friendly: FriendlyError }[] = [
  {
    // Legacy rows from before the runner started self-healing its run log.
    test: /foreign key constraint failed/i,
    friendly: {
      text: "The run log chat this automation pointed to no longer exists.",
      hint: "Fixed automatically — the next run recreates a fresh log.",
    },
  },
  {
    test: /no api key configured/i,
    friendly: {
      text: "No API key is set for this provider.",
      hint: "Add one in Settings → Connectors, then Run again.",
    },
  },
  {
    test: /no model configured/i,
    friendly: {
      text: "No model is configured for this agent.",
      hint: "Pick a model for this automation or set the agent's default.",
    },
  },
  {
    test: /failed to spawn|enoent|program not found|is not recognized/i,
    friendly: {
      text: "The agent CLI couldn't be started.",
      hint: "If the harness isn't installed, use the one-time Install button, then Run again.",
    },
  },
  {
    test: /timed? ?out|time limit/i,
    friendly: {
      text: "The run hit its 2-hour safety limit and was stopped.",
      hint: "If it needs longer, split the prompt into smaller steps.",
    },
  },
];

/** Translate raw runner error text into something a user can act on.
 *  Unrecognized errors pass through verbatim (still better than hiding). */
export function friendlyRunError(statusOrSummary: string): FriendlyError {
  const s = statusOrSummary.trim();
  if (!s) return { text: "Unknown error." };
  for (const m of FRIENDLY_ERROR_MATCHERS) {
    if (m.test.test(s)) return m.friendly;
  }
  return { text: s };
}

/** True when an automation's `harness` names a CLI harness that is registered
 *  but NOT installed on this device — the case where the failure banner's
 *  "Run again" becomes a one-time "Install". Provider/local agent ids
 *  ("anthropic", "local_gguf", …) are absent from the harness registry and
 *  never match. */
export function harnessNeedsInstall(
  harness: string,
  harnesses: { id: string; installed: boolean }[],
): boolean {
  return harnesses.some((h) => h.id === harness && !h.installed);
}

/** Unified per-automation state — one concept instead of separate
 *  enabled/last-status/dot signals. */
export type AutomationStateKey = "healthy" | "failing" | "running" | "paused" | "never";

export function automationState(
  a: { enabled: boolean; lastStatus: string | null; lastRunAt: number | null },
  runningNow: boolean,
): AutomationStateKey {
  if (!a.enabled) return "paused";
  if (runningNow || a.lastStatus === "running") return "running";
  if (a.lastRunAt == null) return "never";
  if (isFailureStatus(a.lastStatus)) return "failing";
  return "healthy";
}

export const AUTOMATION_STATE_META: Record<
  AutomationStateKey,
  { label: string; color: string }
> = {
  healthy: { label: "Healthy", color: "var(--green, #4caf7d)" },
  failing: { label: "Failing", color: "var(--red, #ff6b6b)" },
  running: { label: "Running", color: "var(--blue, #2196f3)" },
  paused: { label: "Paused", color: "var(--text-dim)" },
  never: { label: "Not run yet", color: "var(--text-dim)" },
};
