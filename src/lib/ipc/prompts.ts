// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";
import { ChatAttachmentInput, getSetting, setSetting } from "../ipc";
import type { AvailableSkill, InstalledSkill } from "../../types";

// ---- Prompt templates (roadmap #14) ----
// A prompt template is a reusable prompt body with `{{variable}}` placeholders.
// Selecting one in the composer fills the variables and inserts the completed
// text. Stored as a JSON array under the `prompts.templates` app_settings key.

export interface PromptTemplate {
  id: string;
  name: string;
  /** Prompt body with `{{varName}}` placeholders. */
  body: string;
  /** Optional `/trigger` that lists this template in the slash menu. */
  trigger?: string;
  createdAt: number;
}

const PROMPT_TEMPLATES_KEY = "prompts.templates";

export async function listPromptTemplates(): Promise<PromptTemplate[]> {
  try {
    const raw = await getSetting(PROMPT_TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PromptTemplate[]) : [];
  } catch {
    return [];
  }
}

export async function savePromptTemplates(templates: PromptTemplate[]): Promise<void> {
  await setSetting(PROMPT_TEMPLATES_KEY, JSON.stringify(templates));
}

/** Extract `{{var}}` placeholders from a template body (deduped, in order). */
export function templateVariables(body: string): string[] {
  const vars: string[] = [];
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (!vars.includes(m[1])) vars.push(m[1]);
  }
  return vars;
}

/** Substitute `{{var}}` placeholders using the provided values (missing → empty). */
export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => values[name] ?? "");
}

// --- Installed skills / loops (harness skill directories) ---
export const listInstalledSkills = () => safeInvoke<InstalledSkill[] | null>("list_installed_skills");
export const listInstalledLoops = () => safeInvoke<InstalledSkill[] | null>("list_installed_loops");
export const readInstalledSkill = (slug: string, kind: string) =>
  safeInvoke<string | null>("read_installed_skill", { slug, kind });
export const saveInstalledSkill = (slug: string, kind: string, content: string) =>
  safeInvoke<void>("save_installed_skill", { slug, kind, content });
export const createInstalledSkill = (name: string, kind: string, content: string) =>
  safeInvoke<InstalledSkill | null>("create_installed_skill", { name, kind, content });
export const deleteInstalledSkill = (slug: string, kind: string) =>
  safeInvoke<void>("delete_installed_skill", { slug, kind });

/**
 * Make every installed skill/loop global — i.e. readable by any harness.
 * Copies each entry that currently lives in only one harness dir into the
 * other so its source becomes "both". Returns the number of entries mirrored.
 */
export const makeInstalledGlobal = (kind: string) =>
  safeInvoke<number>("make_installed_global", { kind });

// --- Chat `/` menu: on-disk harness skills merged with the built-in
// doc/pptx/pdf/diagram skills (on-disk wins on slug collision). ---
export const listChatSkills = () =>
  safeInvoke<AvailableSkill[] | null>("list_chat_skills");

// --- Chat mode (direct LLM HTTP API, separate from CLI agent panes) ---
// Command names and arg shapes are binding per CONTRACT.md — do not rename
// without updating the Rust backend in lockstep. Types mirror the serde
// structs (camelCase fields).
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
