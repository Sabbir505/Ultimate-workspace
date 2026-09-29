// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";
import { ChatConfigPayload } from "../ipc";

// ---------------------------------------------------------------------------
// Automations (scheduled headless agent runs — automations.rs). Each run is a
// one-shot turn at full-auto permission, logged into the automation's own
// chat session so transcripts show up in normal chat history.
export interface Automation {
  id: string;
  name: string;
  prompt: string;
  /** "claude_code" | "opencode" (kimi can't auto-approve in prompt mode). */
  harness: string;
  model: string;
  cwd: string;
  /** 5-field cron, local time. */
  schedule: string;
  enabled: boolean;
  lastRunAt: number | null;
  /** "ok" | "skipped" | error text. */
  lastStatus: string | null;
  /** Chat session used as the run log (bound on first run). */
  chatSessionId: string | null;
  createdAt: number;
  /** "user" (Automations form) | "agent" (created by the model's
   *  create_automation tool — badged in the UI so agent-scheduled prompts are
   *  always visible). */
  origin: string;
  /** Firing engine: "cron" (default) | "webhook" | "file" | "git" | "gmail". */
  triggerType: string;
  /** JSON payload for the trigger engine (file: {path, minIntervalSecs?};
   *  git: {cwd, branch?}; gmail: {label?}; webhook: {} — the secret is
   *  redacted here and only comes back from automationWebhookInfo). */
  triggerConfig: string;
  /** Trigger dedupe state (last git SHA / last fs-fire epoch). */
  lastTriggerState: string | null;
  /** Timestamp of the last webhook/file/git run (never moves the cron
   *  clock — that's lastRunAt's job). */
  lastEventRunAt: number | null;
}
export interface AutomationInput {
  name: string;
  prompt: string;
  harness: string;
  model?: string;
  cwd?: string;
  schedule: string;
  enabled?: boolean;
  triggerType?: string;
  triggerConfig?: string;
}
export const listAutomations = () => safeInvoke<Automation[]>("list_automations");
export const createAutomation = (input: AutomationInput) =>
  safeInvoke<Automation>("create_automation", { input });
export const updateAutomation = (automationId: string, input: AutomationInput) =>
  safeInvoke<void>("update_automation", { automationId, input });
export const deleteAutomation = (automationId: string) =>
  safeInvoke<void>("delete_automation", { automationId });
export const setAutomationEnabled = (automationId: string, enabled: boolean) =>
  safeInvoke<void>("set_automation_enabled", { automationId, enabled });
export const runAutomationNow = (automationId: string) =>
  safeInvoke<void>("run_automation_now", { automationId });
/** Kill the in-flight run's process tree and record the row as "stopped".
 *  Resolves false when no run of this automation is in flight in the app
 *  (already ended, or running under Task Scheduler, which an in-app stop
 *  can't reach). */
export const stopAutomationRun = (automationId: string) =>
  safeInvoke<boolean>("stop_automation_run", { automationId });

/** Next fire for a row of any trigger type. Cron rows carry `at` (unix
 *  seconds, local time — same math the scheduler uses for due-ness);
 *  webhook/file/git/gmail rows carry a human `label` ("on webhook call",
 *  "on new email") instead. Cron rows return `at: null` + empty label when
 *  the schedule never fires. */
export interface AutomationNextFire {
  at: number | null;
  label: string;
}
export const automationNextFire = (
  schedule: string,
  triggerType?: string,
  triggerConfig?: string,
) =>
  safeInvoke<AutomationNextFire>("automation_next_fire", {
    schedule,
    triggerType: triggerType ?? null,
    triggerConfig: triggerConfig ?? null,
  });

/** The full local webhook trigger URL + secret for one automation — the
 *  dedicated getter, since list/get responses redact the secret. Rejects
 *  while the listener isn't running or the row isn't a webhook trigger. */
export const automationWebhookInfo = (automationId: string) =>
  safeInvoke<{ url: string; secret: string }>("automation_webhook_info", { automationId });

/** One past (or in-flight) run of an automation — backed by the
 *  automation_runs SQLite table. Used by the Automations view's
 *  "Past runs" list inside the detail pane. */
export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: number;
  finishedAt: number | null;
  /** "running" | "ok" | "skipped" | error text. */
  status: string;
  summary: string;
  chatSessionId: string | null;
  /** "scheduled" (cron tick) | "manual" (run-now) | "webhook" | "fs" | "git"
   *  | "email" (new-email trigger). */
  source: string;
}
export const listAutomationRuns = (automationId: string, limit = 100, beforeStartedAt?: number) =>
  safeInvoke<AutomationRun[]>("list_automation_runs", { automationId, limit, beforeId: beforeStartedAt ?? null });
export const countAutomationRuns = (automationId: string) =>
  safeInvoke<number>("count_automation_runs", { automationId });

// ---- Run while closed (Task Scheduler) + finish notifications ----

/** Whether the global "RelayAutomations" Task Scheduler entry is
 *  registered (the task itself is the source of truth). */
export const getRunWhileClosed = () => safeInvoke<boolean>("get_run_while_closed");
/** Register/unregister the global run-due task. Errors on non-Windows. */
export const setRunWhileClosed = (enabled: boolean) =>
  safeInvoke<void>("set_run_while_closed", { enabled });
/** POST a sample payload to the configured automations webhook URL. */
export const testAutomationWebhook = () => safeInvoke<void>("test_automation_webhook");

export interface AutomationRunFinishedPayload {
  automationId: string;
  name: string;
  /** "ok" | "skipped" | error text. */
  status: string;
  summary: string;
  chatSessionId: string;
  finishedAt: number;
}

export const listenAutomationRunFinished = (
  handler: (payload: AutomationRunFinishedPayload) => void,
) => safeListen<AutomationRunFinishedPayload>("automation:run-finished", handler);

/** Emitted when a run actually begins executing (app-open runs only). The
 *  frontend pre-creates the session's streaming entry with it so the
 *  run-log chat shows the live turn instead of dropping every token. */
export interface AutomationRunStartedPayload {
  automationId: string;
  chatSessionId: string;
}

export const listenAutomationRunStarted = (
  handler: (payload: AutomationRunStartedPayload) => void,
) => safeListen<AutomationRunStartedPayload>("automation:run-started", handler);

/** True when the automation is bound to a subagent (``harness = "agent:<id>"``):
 *  the run routes through the subagent registry (the definition's engine, model,
 *  prompt body and permission scope), not a raw engine id. */
export const isSubagentAutomation = (harness: string): boolean =>
  /^agent:[^\s]+/.test(harness);
