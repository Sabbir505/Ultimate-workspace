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
}
export interface AutomationInput {
  name: string;
  prompt: string;
  harness: string;
  model?: string;
  cwd?: string;
  schedule: string;
  enabled?: boolean;
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

/** Next fire time (unix seconds, local time) for a 5-field cron schedule,
 *  strictly after now — same math the scheduler uses for due-ness.
 *  Null when the schedule never fires again. */
export const automationNextFire = (schedule: string) =>
  safeInvoke<number | null>("automation_next_fire", { schedule });

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
  /** "scheduled" (cron tick) | "manual" (run-now button). */
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

/** Switch a chat session's provider (e.g. to/from "local_gguf" when picking a
 *  local model from the selector in a cloud session, or vice versa). */
