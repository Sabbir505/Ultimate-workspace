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
export const updateChatSessionProvider = (chatSessionId: string, provider: string) =>
  safeInvoke<void>("update_chat_session_provider", { chatSessionId, provider });
/** Flip a chat between Auto model routing (backend re-resolves the
 *  provider+model per send — cloud providers only) and a pinned pick. `true`
 *  resets the row's provider/model to "auto" placeholders until the next
 *  send resolves them; `false` clears the flag so a manual pick can take
 *  over. */
export const setChatSessionAuto = (chatSessionId: string, auto: boolean) =>
  safeInvoke<void>("set_chat_session_auto", { chatSessionId, auto });
/** Update a chat session's watch-mode pacing override. null clears the
 *  override so the session inherits the global setting; "on" | "off" set
 *  a per-session override. */
export const updateChatSessionWatchMode = (
  chatSessionId: string,
  mode: "on" | "off" | null,
) =>
  safeInvoke<void>("update_chat_session_watch_mode", { chatSessionId, mode });
/** Update a chat session's dual sandbox + approval policies. `sandbox` is
 *  "read_only" | "workspace_write"; `approval` is "on_request" | "auto_edit"
 *  | "full_access". The legacy permission_mode column is also updated
 *  (derived from the dual policies) for backward compat. The frontend gates
 *  the switch to "full_access" approval behind a one-time confirmation modal
 *  before calling this. */
export const updateChatSessionPolicies = (
  chatSessionId: string,
  sandbox: "read_only" | "workspace_write",
  approval: "on_request" | "auto_edit" | "full_access",
) =>
  safeInvoke<void>("update_chat_session_policies", { chatSessionId, sandbox, approval });
/** Update a chat session's agent selection from the composer's agent-then-model
 *  selector. `"builtin"` | `"local"` | `"harness:<id>"` | null (clears the
 *  selection — back to the locked fresh-chat state). Persisted per session;
 *  selecting a harness does not reroute messages until the headless CLI chat
 *  protocol lands. */
export const updateChatSessionAgent = (
  chatSessionId: string,
  agent: string | null,
) =>
  safeInvoke<void>("update_chat_session_agent", { chatSessionId, agent });
export const cancelChatMessage = (chatSessionId: string) =>
  safeInvoke<void>("cancel_chat_message", { chatSessionId });
/** Resolve a pending per-action tool approval card. `approved` lets the paused
 *  tool loop (or the Claude Code control request) run the action; `false`
 *  injects a "user denied" tool result. */
export const resolveToolAction = (pendingId: string, approved: boolean) =>
  safeInvoke<void>("resolve_tool_action", { pendingId, approved });
/** Persist the partial assistant reply of a cancelled stream, so the text the
 *  user already saw survives the cancel instead of vanishing. */
export const persistPartialChatMessage = (chatSessionId: string, content: string) =>
  safeInvoke<void>("persist_partial_chat_message", { chatSessionId, content });
export const setChatApiKey = (
  provider: string,
  key: string,
  baseUrl?: string,
  model?: string,
) =>
  safeInvoke<void>("set_chat_api_key", {
    provider,
    key,
    baseUrl: baseUrl ?? null,
    model: model ?? null,
  });
export const deleteChatApiKey = (provider: string) =>
  safeInvoke<void>("delete_chat_api_key", { provider });
export const getChatConfig = (provider?: string) =>
  safeInvoke<ChatConfigPayload | null>("get_chat_config", provider ? { provider } : {});
/** Persist ONLY the per-provider default model (chat.<provider>.model) — no
 *  key, base_url, or active_provider changes. Composer model picks call this
 *  so new chats seed with the last-picked model instead of a stale default. */
export const setChatDefaultModel = (provider: string, model: string) =>
  safeInvoke<void>("set_chat_default_model", { provider, model });

export interface ChatModelInfo {
  id: string;
  object: string;
  created: number;
  ownedBy: string;
  /** The provider's own context-window figure when its models API publishes
   *  one (Anthropic `context_window`, OpenRouter `context_length`); null
   *  otherwise — the registry fallback applies. */
  contextWindow?: number | null;
}

export const listChatModels = (
  provider: string,
  baseUrl?: string,
  apiKey?: string,
) =>
  safeInvoke<ChatModelInfo[] | null>("list_chat_models", {
    provider,
    baseUrl: baseUrl ?? null,
    apiKey: apiKey ?? null,
  });

/** One entry of a provider's curated Model list (Settings → API provider).
 *  `contextWindow` is the per-model window the user pinned (0 = auto —
 *  live API figure, else the registry). A non-empty list IS the provider's
 *  model picker content. Mirrors the Rust SelectedModel. */
export interface SelectedModelEntry {
  id: string;
  contextWindow: number;
}

export const setSelectedModels = (provider: string, models: SelectedModelEntry[]) =>
  safeInvoke<void>("set_selected_models", { provider, models });
