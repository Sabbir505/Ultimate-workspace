// Chat-session wire types and session mutation wrappers — rehomed from
// prompts.ts / automations.ts during the ipc domain split.
import { safeInvoke } from "../ipcCore";
import type { ChatAttachmentInput } from "./artifacts";

export type ChatProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "anthropic_compatible"
  | "openai_compatible"
  | "local_gguf";

export interface ChatSession {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  createdAt: number;
  lastActiveAt: number;
  /** Starred chats are pinned to the top of the sidebar list. */
  starred?: boolean;
  /** Marked-unread chats show an unread dot in the sidebar. */
  unread?: boolean;
  /** Per-session watch-mode pacing override. null = inherit global setting;
   *  "on" | "off" = per-session override. */
  watchMode?: string | null;
  /** Per-session agent selection from the composer's agent-then-model
   *  selector. null/undefined = no agent picked yet (model chip locked, Send
   *  disabled). Values: "builtin" | "local" | "harness:<id>" (e.g.
   *  "harness:claude_code"). */
  agent?: string | null;
  /** The project this chat is nested under in the sidebar. null/undefined =
   *  unbound (shows in the flat "Chat History" list); a project id nests it
   *  under that project's expandable row. Persisted in the DB. */
  projectId?: string | null;
  /** Per-session isolated git worktree (roadmap P0 §3.1.1). null/undefined =
   *  the chat works in its bound project's working tree; a path = the chat's
   *  isolated git worktree (sibling of the project, branch `relay/<id>`),
   *  which becomes its working dir for sends/spawns/diffs. */
  worktreePath?: string | null;
  /** Legacy per-session permission posture — superseded by the dual
   *  sandbox/approval policies below. Retained for backward compat. */
  permissionMode?: string;
  /** Per-session sandbox scope: "read_only" | "workspace_write". Decides
   *  which tools are visible to the model. Defaults to "workspace_write". */
  sandboxPolicy?: string;
  /** Per-session approval posture: "on_request" | "auto_edit" |
   *  "full_access". Decides when visible tools pause for approval.
   *  Defaults to "on_request". */
  approvalPolicy?: string;
  /** Auto model routing: every send re-resolves the provider+model through
   *  the backend's auto router (cloud providers only). The row's
   *  provider/model hold the LAST resolution (post-first-send they name the
   *  model that actually ran); the chip shows "Auto" while this is set. */
  autoModel?: boolean;
}

export interface ChatMessageRecord {
  id: number;
  chatSessionId: string;
  role: string;
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  createdAt: number;
  /** Wall-clock window of the assistant turn that produced this row (Unix
   *  seconds). Both null for user/system rows and legacy rows predating the
   *  columns; `durationSec` is derived from `completedAt - startedAt`. */
  startedAt: number | null;
  completedAt: number | null;
  /** Perf metrics persisted per assistant turn (ms / tok/s). Null for legacy
   *  rows and rows that predated the instrumentation. */
  llmTimeMs?: number | null;
  toolTimeMs?: number | null;
  ttftMs?: number | null;
  tokensPerSecond?: number | null;
  /** Id of the message this row was superseded/forked from (roadmap #9, and
   *  compaction summaries). Non-null means the row is part of a retired branch
   *  or was folded into a `[compacted context]` summary — it no longer feeds
   *  the model but stays in the timeline for reference. */
  supersededBy?: number | null;
  /** Live attachment objects for the optimistic just-sent user message, so the
   *  bubble can show real image thumbnails before the backend persists. Not
   *  present on persisted messages (those carry attachment text markers in
   *  `content`). Never sent by the backend. */
  attachments?: ChatAttachmentInput[];
}

export interface ChatConfigPayload {
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  /** True when an API key exists in the keychain for this provider. */
  hasKey: boolean;
}

/** View-model type used by MessageBubble — lightweight { role, content }. The
 *  `system` role is used only by compaction-summary rows, which MessageBubble
 *  renders as a muted "earlier context compacted" marker (not a real bubble). */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** How long the assistant turn took (seconds), from the persisted
   *  `completedAt - startedAt`. Absent for the live streaming bubble, for
   *  user/system rows, and for legacy rows with no recorded window. */
  durationSec?: number;
  /** Live perf snapshot (elapsedMs, etc.) from `chat:perf` for the streaming
   *  bubble — used to show "Working for Xs" while the turn is in flight. */
  livePerf?: ChatPerfPayload | null;
  /** Wall-clock creation time for the bubble's end-of-turn timestamp. Persisted
   *  rows carry Unix SECONDS (db now_ts()); the optimistic just-sent message
   *  carries Date.now() MILLISECONDS — consumers normalize via the 1e12
   *  threshold. Absent on the live streaming bubble, so the stamp appears only
   *  once the turn ends and the persisted row swaps in. */
  createdAt?: number;
  /** Live attachment objects (with image base64) for the optimistic just-sent
   *  message, so image cards get a real thumbnail before the backend persists.
   *  Persisted messages carry attachments as text markers inside `content`
   *  instead (parsed by MessageAttachments). */
  attachments?: ChatAttachmentInput[];
}

// Chat event payloads (backend -> frontend).
export interface ChatTokenPayload {
  chatSessionId: string;
  token: string;
}
/** Pre-token status notice (e.g. a local model is cold-starting). */
export interface ChatStatusPayload {
  chatSessionId: string;
  /** "local_model_loading" | "thinking" */
  reason: string;
  /** Human-facing line shown next to the spinner. */
  message: string;
}
export interface ChatDonePayload {
  chatSessionId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Cache-write tokens from harness turns that report them (claude/pi/
   *  commandcode/opencode); null when the harness didn't report a split. */
  cacheCreationInputTokens?: number | null;
  /** Cache-read tokens from harness turns that report them — the bulk of a
   *  mid-session claude prompt. `inputTokens` stays the uncached slice. */
  cacheReadInputTokens?: number | null;
  /** Cumulative wall-clock the model spent actively generating text (ms). */
  llmTimeMs: number | null;
  /** Cumulative wall-clock spent executing tools (ms), excluding approval waits. */
  toolTimeMs: number | null;
  /** Time from the first model request to the first streamed token (ms). */
  ttftMs: number | null;
  /** Decode throughput = outputTokens / decode time (tokens per second);
   *  prefill and connection time excluded. */
  tokensPerSecond: number | null;
  /** Prompt/KV-cache hit rate (0.0–1.0), computed from usage cache fields. */
  cacheHitRate: number | null;
}

/** End-of-turn citation-integrity verdict for a research report, emitted as
 *  `chat:citation-report`. The backend lints the generated report against the
 *  session's source ledger — zero model calls, purely mechanical — so the
 *  numbers describe what was actually verified, not what the model claims. */
export interface ChatCitationReportPayload {
  chatSessionId: string;
  /** Backend message row the report is attached to (null when unknown). */
  messageId: number | null;
  /** `[n]`-style markers found in the report. */
  totalCitations: number;
  /** Markers that don't resolve to a ledger-backed source (fabricated or
   *  never-read). */
  orphanCount: number;
  /** Readable ledger sources that never made it into the report. */
  unusedCount: number;
  /** Substantive sentences carrying no citation marker at all. */
  uncitedSentences: number;
  /** Cited sentences whose overlap with the cited excerpt is suspiciously
   *  low (weak attribution). */
  weakCount: number;
  /** Which citation numbers were flagged weak (amber chips). */
  weakNumbers: number[];
  /** Which citation numbers are orphans (red chips). */
  orphanNumbers: number[];
}

/** Live per-session perf snapshot, emitted (throttled) while a turn is streaming
 *  as `chat:perf`. The frontend uses this to update the composer metrics row
 *  without waiting for `chat:done`. */
export interface ChatPerfPayload {
  chatSessionId: string;
  /** Cumulative model-round time so far (ms): connect + prefill + decode. */
  llmTimeMs: number;
  /** Cumulative tool-execution time so far (ms). */
  toolTimeMs: number;
  /** Time from the first model request to the first streamed token (ms), if known yet. */
  ttftMs: number | null;
  /** Running decode throughput = outputTokens / decode time. */
  tokensPerSecond: number | null;
  /** Output tokens generated so far in this turn (text-delta estimate). */
  outputTokens: number;
  /** Wall-clock elapsed since turn start (ms). */
  elapsedMs: number;
  /** Prompt tokens billed so far (accumulated at each tool-loop round
   *  boundary). null until the provider reports its first round usage. */
  inputTokens: number | null;
  /** Live prompt-cache hit rate from the round usage so far; null when the
   *  provider hasn't reported cache fields. */
  cacheHitRate: number | null;
}
export interface ChatArtifactPayload {
  chatSessionId: string;
  path: string;
  filename: string;
}
export interface ChatOpenBrowserPayload {
  chatSessionId: string;
  url: string;
}
export interface ChatOpenPreviewPayload {
  chatSessionId: string;
  path: string;
  filename: string;
}

/** A pending per-action tool approval surfaced as a card. Emitted when the
 *  central `check_permission` gate (built-in chat) or the Claude Code
 *  can_use_tool control request (harness chat) returns NeedsApproval. The
 *  user's choice is sent back via `resolveToolAction`. */
export interface ChatApprovalRequestPayload {
  chatSessionId: string;
  pendingId: string;
  tool: string;
  summary: string;
  args: unknown;
}

/** Emitted when the user has resolved a pending approval card (so the UI can
 *  dismiss the card). `approved` ran the tool; a denied card returned a
 *  "user denied" tool result instead. */
export interface ChatApprovalResolvedPayload {
  chatSessionId: string;
  pendingId: string;
  approved: boolean;
}

/** Live progress for a background chat task (download_file / run_shell),
 *  pushed as `chat:task-progress` while the task runs and on completion. */
export interface ChatTaskProgressPayload {
  chatSessionId: string;
  taskId: string;
  /** "download" | "shell" */
  kind: string;
  /** running | completed | failed | cancelled */
  state: "running" | "completed" | "failed" | "cancelled";
  message: string;
  downloaded: number;
  total: number | null;
  speedBps: number;
  destPath: string | null;
}

/** Plan step progress pushed as `chat:plan-step-progress`. Lighter than
 *  ChatTaskProgressPayload — no download/speed fields, just status. */
export interface PlanStepProgressPayload {
  chatSessionId: string;
  stepLabel: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  detail: string | null;
  toolCall: string | null;
}

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
