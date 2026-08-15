// Thin wrappers around the Tauri IPC contract (CONTRACT.md). Command names and
// payload shapes here are binding — do not "improve" them without updating the
// contract and the Rust backend in lockstep.
//
// Every invoke is routed through `safeInvoke`, which rejects quietly (with a
// console warning) when the Tauri runtime is absent — e.g. inside jsdom tests
// or a plain `vite dev` browser session. Event listeners go through
// `safeListen` for the same reason: they are registered lazily (React
// effects / bootstrap), never at module import time.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useUiStore } from "../state/ui";
import type {
  AvailableSkill,
  ChangedFile,
  CostEvent,
  CostRollups,
  DocsEmbeddingStatus,
  DocCorpus,
  DocsIndexProgressPayload,
  GitStatusInfo,
  HarnessId,
  HarnessStatus,
  InstalledSkill,
  Project,
  QuickAction,
  SessionRecord,
  Skill,
} from "../types";

export type { ChangedFile, DocCorpus, DocsEmbeddingStatus, DocsIndexProgressPayload };

function tauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Exported so components can pick a non-Tauri fallback (e.g. the browser
 *  pane's iframe mode under jsdom / plain vite dev). */
export const tauriRuntimeAvailable = tauriAvailable;

export async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!tauriAvailable()) {
    // Outside Tauri there is no backend; resolve with a benign empty value so
    // bootstrap code and tests don't explode. Callers treat null as "empty".
    console.warn(`[conduit] invoke("${cmd}") skipped — Tauri runtime not available`);
    return null as T;
  }
  return invoke<T>(cmd, args);
}

export async function safeListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!tauriAvailable()) return () => {};
  try {
    return await listen<T>(event, (e) => handler(e.payload));
  } catch (err) {
    console.warn(`[conduit] listen("${event}") failed`, err);
    return () => {};
  }
}

// --- Global toast helpers (the app's error surface) ---
// Use these at IPC call sites instead of bare console.warn/console.error so
// failures (git push, downloads, connector calls, …) are visible to the user
// in the bottom-right toast stack, not just in devtools.

function errorDetail(err: unknown): string | undefined {
  if (err == null) return undefined;
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

export function toastError(message: string, err?: unknown): void {
  const detail = errorDetail(err);
  if (detail) console.warn(`[conduit] ${message}:`, detail);
  useUiStore.getState().pushToast("error", message, detail);
}

export function toastInfo(message: string): void {
  useUiStore.getState().pushToast("info", message);
}

export function toastSuccess(message: string, detail?: string): void {
  useUiStore.getState().pushToast("success", message, detail);
}

// --- Projects / sessions ---
export const listProjects = () => safeInvoke<Project[] | null>("list_projects");
export const addProject = (path: string) => safeInvoke<Project | null>("add_project", { path });
export const removeProject = (projectId: string) => safeInvoke<void>("remove_project", { projectId });
export const renameProject = (projectId: string, name: string) =>
  safeInvoke<void>("rename_project", { projectId, name });
export const initGitRepo = (projectId: string) => safeInvoke<void>("init_git_repo", { projectId });
export const listSessions = (projectId?: string) =>
  safeInvoke<SessionRecord[] | null>("list_sessions", projectId ? { projectId } : {});
export const createSession = (projectId: string, harness: HarnessId) =>
  safeInvoke<SessionRecord | null>("create_session", { projectId, harness });
export const updateSessionTitle = (sessionId: string, title: string) =>
  safeInvoke<void>("update_session_title", { sessionId, title });
export const deleteSession = (sessionId: string) => safeInvoke<void>("delete_session", { sessionId });
export const touchSession = (sessionId: string) => safeInvoke<void>("touch_session", { sessionId });

// --- PTY ---
export const spawnAgentSession = (paneId: string, sessionId: string) =>
  safeInvoke<void>("spawn_agent_session", { paneId, sessionId });
export const spawnShell = (paneId: string, cwd: string, command: string, injectSecretsProjectId?: string) =>
  safeInvoke<void>("spawn_shell", { paneId, cwd, command, injectSecretsProjectId });
export const writePty = (paneId: string, data: string) => safeInvoke<void>("write_pty", { paneId, data });
/** Send a full prompt to a harness and SUBMIT it: writes the text, then a
 *  separate `\r` write shortly after. A trailing `\r` merged into the text
 *  write does not reliably register as Enter for TUI harnesses (opencode /
 *  Claude Code / Kimi) through the ConPTY input path, so the Enter must be
 *  its own write — the same shape a real user produces by pressing Enter
 *  (xterm.js emits "\r" as a standalone chunk). The delay lets the TUI
 *  render the typed text before the submit key arrives. */
export const writePtySubmit = (paneId: string, text: string) => {
  void writePty(paneId, text);
  window.setTimeout(() => void writePty(paneId, "\r"), 250);
};
export const resizePty = (paneId: string, cols: number, rows: number) =>
  safeInvoke<void>("resize_pty", { paneId, cols, rows });
export const killPty = (paneId: string) => safeInvoke<void>("kill_pty", { paneId });
/** Dev-only: resident memory (bytes) of a pane's child process. 0 when the
 *  process is gone or unknown. */
export const paneMemory = (paneId: string) => safeInvoke<number>("pane_memory", { paneId });

// --- Native browser panes (child webviews; Linux falls back to iframe) ---
//
// Multi-tab API: every command and the `browser:navigated` event carry a
// `tabId` (webview label = `browser-{paneId}-tab-{tabId}`). Use `tabId =
// "default"` for the single-tab path — there is one code path for both.
//
// Logical-pixel rect from getBoundingClientRect — Tauri does HiDPI conversion.
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BrowserNavigatedPayload {
  paneId: string;
  tabId: string;
  url: string;
}
export const browserCreateTab = (paneId: string, tabId: string, url: string, rect: BrowserRect) =>
  safeInvoke<void>("browser_create", { paneId, tabId, url, rect });
export const browserNavigateTab = (paneId: string, tabId: string, url: string) =>
  safeInvoke<void>("browser_navigate", { paneId, tabId, url });
/** Open the WebView2 DevTools window for a browser pane (console + network). */
export const browserOpenDevtools = (paneId: string, tabId: string) =>
  safeInvoke<void>("browser_open_devtools", { paneId, tabId });
export const browserGoBackTab = (paneId: string, tabId: string) =>
  safeInvoke<void>("browser_go_back", { paneId, tabId });
export const browserGoForwardTab = (paneId: string, tabId: string) =>
  safeInvoke<void>("browser_go_forward", { paneId, tabId });
export const browserReloadTab = (paneId: string, tabId: string) =>
  safeInvoke<void>("browser_reload", { paneId, tabId });
export const browserSetBoundsTab = (paneId: string, tabId: string, rect: BrowserRect) =>
  safeInvoke<void>("browser_set_bounds", { paneId, tabId, rect });
export const browserSetVisibleTab = (paneId: string, tabId: string, visible: boolean) =>
  safeInvoke<void>("browser_set_visible", { paneId, tabId, visible });
export const browserCloseTab = (paneId: string, tabId: string) =>
  safeInvoke<void>("browser_close", { paneId, tabId });
/** Close ALL tab webviews for a pane (used when the entire pane is closed). */
export const browserClosePane = (paneId: string) =>
  safeInvoke<void>("browser_close_pane", { paneId });
export const listenBrowserNavigatedTab = (handler: (payload: BrowserNavigatedPayload) => void) =>
  safeListen<BrowserNavigatedPayload>("browser:navigated", handler);

// --- Browser pane project registry + MCP roundtrip wrappers ---
export const registerBrowserPaneProject = (paneId: string, projectId: string) =>
  safeInvoke<void>("register_browser_pane_project", { paneId, projectId });
export const unregisterBrowserPaneProject = (paneId: string) =>
  safeInvoke<void>("unregister_browser_pane_project", { paneId });
export const browserResolvePaneResult = (reqId: number, paneId: string | null) =>
  safeInvoke<void>("browser_resolve_pane_result", { reqId, paneId: paneId ?? null });
export const browserOpenPaneResult = (reqId: number, paneId: string | null) =>
  safeInvoke<void>("browser_open_pane_result", { reqId, paneId: paneId ?? null });

export interface BrowserResolvePaneRequestPayload {
  reqId: number;
  projectId: string;
}
export interface BrowserOpenBrowserRequestPayload {
  reqId: number;
  projectId: string;
  url: string;
}
export const listenBrowserResolvePaneRequest = (
  handler: (payload: BrowserResolvePaneRequestPayload) => void,
) => safeListen<BrowserResolvePaneRequestPayload>("browser:resolve-pane-request", handler);
export const listenBrowserOpenBrowserRequest = (
  handler: (payload: BrowserOpenBrowserRequestPayload) => void,
) => safeListen<BrowserOpenBrowserRequestPayload>("browser:open-browser-request", handler);

/** Emitted by the backend whenever the agent performs any browser action
 *  (harness MCP ops via resolve_or_open; chat-mode browser_* tools). The
 *  frontend surfaces the Browser tab so the work is visible as it happens. */
export interface BrowserActivityPayload {
  paneId: string | null;
}
export const listenBrowserActivity = (
  handler: (payload: BrowserActivityPayload) => void,
) => safeListen<BrowserActivityPayload>("browser:activity", handler);

// --- Harnesses ---
export const listHarnesses = () => safeInvoke<HarnessStatus[] | null>("list_harnesses");
export const runHarnessLogin = (paneId: string, harnessId: HarnessId, cwd: string) =>
  safeInvoke<void>("run_harness_login", { paneId, harnessId, cwd });

// --- Git ---
export const getGitStatus = (path: string) => safeInvoke<GitStatusInfo | null>("get_git_status", { path });
export const createWorktree = (projectId: string, branchName: string) =>
  safeInvoke<string | null>("create_worktree", { projectId, branchName });
export const getGitDiff = (path: string) => safeInvoke<string | null>("get_git_diff", { path });
/** Per-file diff for the Changes panel. Returns the unified diff for a
 *  single file in the working tree (or an empty string when the file has no
 *  changes / isn't a git repo). Used when the user clicks a file row in the
 *  ToolPanel's Changes tab — we want THAT file's diff, not the whole tree. */
export const getGitFileDiff = (path: string, filePath: string) =>
  safeInvoke<string | null>("get_git_file_diff", { path, filePath });
/** Per-pane change list for the Changes panel. The argument is the
 *  pane's actual working directory (project root or worktree path), not the
 *  project root alone — worktree-scoped sessions (PRD §7.10) must see the
 *  worktree's own diff, not the parent repo's. */
export const getChangedFiles = (path: string) =>
  safeInvoke<ChangedFile[] | null>("get_changed_files", { path });

// --- Git branch management ---
export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  lastCommitSha: string;
  lastCommitMessage: string;
}
export interface GitLogEntry {
  graph: string;
  sha: string;
  message: string;
  refs: string;
}
export const listGitBranches = (path: string) =>
  safeInvoke<BranchInfo[] | null>("list_git_branches", { path });
export const createGitBranch = (path: string, name: string) =>
  safeInvoke<void>("create_git_branch", { path, name });
export const checkoutGitBranch = (path: string, name: string) =>
  safeInvoke<void>("checkout_git_branch", { path, name });
export const deleteGitBranch = (path: string, name: string) =>
  safeInvoke<void>("delete_git_branch", { path, name });
export const getGitLog = (path: string) =>
  safeInvoke<GitLogEntry[] | null>("get_git_log", { path });

export const gitCommit = (path: string, message: string) =>
  safeInvoke<string>("git_commit", { path, message });

export const gitPush = (path: string) =>
  safeInvoke<string>("git_push", { path });
export const getRemoteUrl = (path: string) =>
  safeInvoke<string | null>("get_remote_url", { path });

/** Generate a Conventional-Commits message from the working-tree diff, using the
 *  active chat session's configured model. Null when there's no diff or no model. */
export const generateCommitMessage = (path: string, chatSessionId: string) =>
  safeInvoke<string | null>("generate_commit_message", { path, chatSessionId });

// --- Settings / skills / quick actions / secrets / cost ---
export const getSetting = (key: string) => safeInvoke<string | null>("get_setting", { key });
export const setSetting = (key: string, value: string) => safeInvoke<void>("set_setting", { key, value });
/** Absolute path of the chat DB (read-only; fixed at the app data dir). */
export const getChatDbPath = () => safeInvoke<string | null>("get_chat_db_path", {});

// ---- Approval rules (roadmap #8) ----
// A user-defined rule auto-approves a filesystem tool call matching
// `(tool, path-glob)` past the approval card. Stored as a JSON array under the
// `permissions.rules` app_settings key; matched per-turn in chat tool dispatch.

export interface ApprovalRule {
  id: string;
  tool: string;
  pattern: string;
  createdAt: number;
}

const RULES_KEY = "permissions.rules";

/** Load the current approval rules (empty array when unset/invalid). */
export async function getPermissionsRules(): Promise<ApprovalRule[]> {
  try {
    const raw = await getSetting(RULES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ApprovalRule[]) : [];
  } catch {
    return [];
  }
}

/** Persist the full approval-rules list. */
export async function setPermissionsRules(rules: ApprovalRule[]): Promise<void> {
  await setSetting(RULES_KEY, JSON.stringify(rules));
}

export interface DataPaths {
  chatDbPath: string;
  chatDbSize: number;
  artifactsDir: string;
  artifactsSize: number;
}
export const getDataPaths = () => safeInvoke<DataPaths | null>("get_data_paths", {});
export const setChatDbDir = (dir: string | null) =>
  safeInvoke<void>("set_chat_db_dir", { dir });
export const listSkills = (projectId?: string) =>
  safeInvoke<Skill[] | null>("list_skills", projectId ? { projectId } : {});
export const createSkill = (name: string, slashCommand: string, content: string, scope: string) =>
  safeInvoke<Skill | null>("create_skill", { name, slashCommand, content, scope });
export const updateSkill = (id: string, name: string, slashCommand: string, content: string) =>
  safeInvoke<void>("update_skill", { id, name, slashCommand, content });
export const deleteSkill = (id: string) => safeInvoke<void>("delete_skill", { id });
export const listQuickActions = (projectId: string) =>
  safeInvoke<QuickAction[] | null>("list_quick_actions", { projectId });
export const createQuickAction = (
  projectId: string,
  label: string,
  command: string,
  keybinding?: string,
  runOnWorktree?: boolean,
) => safeInvoke<QuickAction | null>("create_quick_action", { projectId, label, command, keybinding, runOnWorktree });
export const updateQuickAction = (id: string, label: string, command: string, keybinding?: string, runOnWorktree?: boolean) =>
  safeInvoke<void>("update_quick_action", { id, label, command, keybinding, runOnWorktree });
export const deleteQuickAction = (id: string) => safeInvoke<void>("delete_quick_action", { id });
export const setSecret = (projectId: string, key: string, value: string) =>
  safeInvoke<void>("set_secret", { projectId, key, value });
export const deleteSecret = (projectId: string, key: string) =>
  safeInvoke<void>("delete_secret", { projectId, key });
export const listSecretKeys = (projectId: string) =>
  safeInvoke<string[] | null>("list_secret_keys", { projectId });
export const getCostEvents = (sessionId?: string) =>
  safeInvoke<CostEvent[] | null>("get_cost_events", {
    sessionId: sessionId ?? null,
    // M6: bounded by default (backend also caps at 500 when null).
    limit: 500,
    beforeTs: null,
  });
export const getCostRollups = (rangeDays?: 7 | 30 | 90) =>
  safeInvoke<CostRollups | null>("get_cost_rollups", rangeDays ? { rangeDays } : {});
export const exportSessionMarkdown = (paneId: string) =>
  safeInvoke<string | null>("export_session_markdown", { paneId });
export const readFileText = (path: string) => safeInvoke<string | null>("read_file_text", { path });

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

/** Stream `budget:alert` events (threshold crossed) — drives the in-app toast. */
export const onBudgetAlert = (handler: (p: BudgetAlertPayload) => void) =>
  safeListen<BudgetAlertPayload>("budget:alert", handler);

// ---- Voice input (roadmap #16) ----

export interface TranscriptionResult {
  text: string;
  baseUrl: string;
}

/** Transcribe a recorded audio clip (base64 WAV/MP3) via a whisper-compatible
 *  endpoint. Returns the recognized text. */
export const transcribeAudio = (payload: string, mime?: string) =>
  safeInvoke<TranscriptionResult | null>("transcribe_audio", {
    payload,
    mime: mime ?? null,
  });

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
  /** Per-session permission posture: "read_only" | "manual" | "auto_edit" |
   *  "full_auto". Defaults to "manual" server-side. */
  permissionMode?: string;
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
  /** Cumulative wall-clock the model spent actively generating text (ms). */
  llmTimeMs: number | null;
  /** Cumulative wall-clock spent executing tools (ms), excluding approval waits. */
  toolTimeMs: number | null;
  /** Time from turn start to the first emitted token (ms). */
  ttftMs: number | null;
  /** Generation speed = outputTokens / llmTimeMs (tokens per second). */
  tokensPerSecond: number | null;
  /** Prompt/KV-cache hit rate (0.0–1.0), computed from usage cache fields. */
  cacheHitRate: number | null;
}

/** Live per-session perf snapshot, emitted (throttled) while a turn is streaming
 *  as `chat:perf`. The frontend uses this to update the composer metrics row
 *  without waiting for `chat:done`. */
export interface ChatPerfPayload {
  chatSessionId: string;
  /** Cumulative model-generation time so far (ms). */
  llmTimeMs: number;
  /** Cumulative tool-execution time so far (ms). */
  toolTimeMs: number;
  /** Time from turn start to the first emitted token (ms), if known yet. */
  ttftMs: number | null;
  /** Running generation speed = outputTokens / llmTimeMs. */
  tokensPerSecond: number | null;
  /** Output tokens generated so far in this turn. */
  outputTokens: number;
  /** Wall-clock elapsed since turn start (ms). */
  elapsedMs: number;
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

/** A persisted artifact in the sidebar library (30-day retention). */
export interface ArtifactRecord {
  id: string;
  chatSessionId: string | null;
  /** The assistant message that produced this artifact (null until attributed). */
  chatMessageId: number | null;
  filename: string;
  path: string;
  kind: string;
  createdAt: number;
  expiresAt: number;
}

/** Session-level aggregate perf metrics returned by `get_chat_session_metrics`
 *  for the composer metrics row. All fields are cumulative across the session's
 *  assistant turns. */
export interface ChatSessionMetricsPayload {
  chatSessionId: string;
  /** Sum of per-turn LLM time (ms). */
  llmTimeMs: number | null;
  /** Sum of per-turn tool-execution time (ms). */
  toolTimeMs: number | null;
  /** Average TTFT across turns that recorded one (ms). */
  ttftAvgMs: number | null;
  /** Weighted-average generation speed (tok/s), weighted by output tokens. */
  tokensPerSecond: number | null;
  /** Session cache-hit rate (0.0–1.0), null when no cache data. */
  cacheHitRate: number | null;
  /** Cumulative input tokens across all turns. */
  inputTokens: number;
  /** Cumulative output tokens across all turns. */
  outputTokens: number;
  /** Number of assistant turns that contributed. */
  turnCount: number;
}

/** All persisted artifacts, most recent first. */
export const listArtifacts = () => safeInvoke<ArtifactRecord[]>("list_artifacts", {});

/** Artifacts for one chat session (oldest first) so a reopened chat restores them. */
export const listChatArtifacts = (chatSessionId: string) =>
  safeInvoke<ArtifactRecord[]>("list_chat_artifacts", { chatSessionId });

/** Delete an artifact (row + on-disk file). */
export const deleteArtifact = (id: string) =>
  safeInvoke<void>("delete_artifact", { id });

/** Delete every artifact: rows + on-disk files, plus a sweep of leftover
 *  files inside the resolved artifacts dir. Returns the files removed. */
export const deleteAllArtifacts = () =>
  safeInvoke<number>("delete_all_artifacts", {});

/** Delete a single chat message (user or assistant) by id. No-op on the
 *  backend for unknown ids; the optimistic just-sent message (negative id)
 *  simply doesn't match anything server-side. The UI removes the bubble
 *  from local state regardless. */
export const deleteChatMessage = (messageId: number) =>
  safeInvoke<void>("delete_chat_message", { messageId });

/** Retire the conversation branch at `messageId` (edit-to-fork): marks that
 *  message and every later row of its session as superseded so the model no
 *  longer sees the old tail. Returns how many rows were retired. */
export const supersedeChatTail = (messageId: number) =>
  safeInvoke<number>("supersede_chat_tail", { messageId });

/** In-app preview of a generated artifact (see `read_artifact_preview`). */
export interface ArtifactPreview {
  path: string;
  filename: string;
  ext: string;
  kind:
    | "text"
    | "markdown"
    | "csv"
    | "json"
    | "html"
    | "diagram"
    | "code"
    | "jsx"
    | "image"
    | "pdf"
    | "office"
    | "binary";
  text: string | null;
  dataUri: string | null;
  /** Signal to frontend that dataUri contains raw bytes (not base64-encoded HTML). */
  originalBytes?: boolean;
  size: number;
  truncated: boolean;
}
export interface ChatErrorPayload {
  chatSessionId: string;
  message: string;
  code: string | null;
}

export const listChatSessions = () =>
  safeInvoke<ChatSession[] | null>("list_chat_sessions");
/** One hit from searchChatMessages (command palette "Chats" section).
 *  messageId/snippet/role are null for title-only matches. */
export interface ChatSearchResult {
  chatSessionId: string;
  sessionTitle: string | null;
  messageId: number | null;
  /** Short plain-text excerpt around the match (no highlight markers). */
  snippet: string | null;
  role: string | null;
  createdAt: number;
  lastActiveAt: number;
}
/** Full-text search across chat message content + session titles. */
export const searchChatMessages = (query: string, limit?: number) =>
  safeInvoke<ChatSearchResult[] | null>("search_chat_messages", { query, limit: limit ?? null });

/** One file entry in a checkpoint's changed-files list. status: A/M/D. */
export interface CheckpointFile {
  path: string;
  status: string;
}

/** A per-turn git working-tree snapshot. messageId is the assistant message
 *  the checkpoint follows (null = baseline / pre-restore safety snapshot). */
export interface ChatCheckpoint {
  id: number;
  chatSessionId: string;
  messageId: number | null;
  /** Hidden git ref backing the snapshot (empty if ref creation failed). */
  refName: string;
  treeSha: string;
  repoPath: string;
  /** Files changed vs the session's previous checkpoint. */
  files: CheckpointFile[];
  createdAt: number;
}

/** All checkpoints for a session, oldest first (timeline order). */
export const listChatCheckpoints = (chatSessionId: string) =>
  safeInvoke<ChatCheckpoint[] | null>("list_chat_checkpoints", { chatSessionId });

/** Roll a checkpoint's repo back to its snapshot. Returns the SAFETY
 *  checkpoint taken of the current state first (restore-the-restore). */
export const restoreChatCheckpoint = (checkpointId: number) =>
  safeInvoke<ChatCheckpoint | null>("restore_chat_checkpoint", { checkpointId });
export const createChatSession = (provider: string, model: string, projectId?: string | null) =>
  safeInvoke<ChatSession | null>("create_chat_session", { provider, model, projectId: projectId ?? null });
/** Bind (or unbind with null) a chat session to a project, so it nests under
 *  that project's expandable sidebar row. */
export const setChatSessionProject = (chatSessionId: string, projectId?: string | null) =>
  safeInvoke<void>("set_chat_session_project", { chatSessionId, projectId: projectId ?? null });
export const deleteChatSession = (chatSessionId: string) =>
  safeInvoke<void>("delete_chat_session", { chatSessionId });
/** Sweep empty "Untitled" session rows (zero messages), keeping the session
 *  the app is about to restore. Returns the number of sessions deleted. */
export const deleteEmptyChatSessions = (keepSessionId?: string) =>
  safeInvoke<number>("delete_empty_chat_sessions", { keepSessionId: keepSessionId ?? null });
/** Delete every chat session + its messages (bulk form of deleteChatSession,
 *  same per-session cleanup). Returns the number of sessions deleted. */
export const deleteAllChatSessions = () =>
  safeInvoke<number>("delete_all_chat_sessions", {});
export const updateChatSessionTitle = (chatSessionId: string, title: string) =>
  safeInvoke<void>("update_chat_session_title", { chatSessionId, title });
/** Ask the session's model for a short auto-generated title. Returns the new
 *  title, or null if one couldn't be produced (e.g. no API key/model). */
export const generateChatTitle = (chatSessionId: string) =>
  safeInvoke<string | null>("generate_chat_title", { chatSessionId });
export const setChatSessionStarred = (chatSessionId: string, starred: boolean) =>
  safeInvoke<void>("set_chat_session_starred", { chatSessionId, starred });
export const setChatSessionUnread = (chatSessionId: string, unread: boolean) =>
  safeInvoke<void>("set_chat_session_unread", { chatSessionId, unread });
export const getChatMessages = (chatSessionId: string, beforeId?: number, limit?: number) =>
  safeInvoke<ChatMessageRecord[] | null>("get_chat_messages", {
    chatSessionId,
    beforeId: beforeId ?? null,
    limit: limit ?? null,
  });
export const getChatSessionMetrics = (chatSessionId: string) =>
  safeInvoke<ChatSessionMetricsPayload | null>("get_chat_session_metrics", { chatSessionId });
export const touchChatSession = (chatSessionId: string) =>
  safeInvoke<void>("touch_chat_session", { chatSessionId });
export interface ChatAttachmentInput {
  name: string;
  kind: "text" | "image" | "doc";
  text?: string;
  data?: string;
  mediaType?: string;
  format?: string;
}
export const sendChatMessage = (
  chatSessionId: string,
  content: string,
  effort?: string,
  toolsEnabled?: boolean,
  codeExecEnabled?: boolean,
  attachments?: ChatAttachmentInput[],
  forceResearch?: boolean,
  // Extended-thinking toggle from the composer "brain" button. undefined
  // means "leave at provider default"; true/false forces on/off.
  thinking?: boolean,
  // Custom working folder chosen via the composer's folder picker — granted
  // as an extra fs_root for this turn's mutating tools.
  extraFsRoot?: string,
) =>
  safeInvoke<void>("send_chat_message", {
    chatSessionId,
    content,
    effort: effort ?? null,
    toolsEnabled: toolsEnabled ?? false,
    codeExecEnabled: codeExecEnabled ?? false,
    attachments: attachments ?? null,
    forceResearch: forceResearch ?? false,
    thinking: thinking ?? null,
    extraFsRoot: extraFsRoot ?? null,
  });
export const updateChatSessionModel = (chatSessionId: string, model: string) =>
  safeInvoke<void>("update_chat_session_model", { chatSessionId, model });

// Headless CLI chat (Phase 2 — agent_sessions.rs). Backs chat sessions whose
// agent is a CLI harness ("harness:claude_code", …); same chat:* events as
// the built-in path, so useChatEvents works unchanged.
export const sendAgentChatMessage = (
  chatSessionId: string,
  content: string,
  harnessId: string,
  model?: string,
  cwd?: string,
  projectId?: string,
) =>
  safeInvoke<void>("send_agent_chat_message", {
    chatSessionId,
    content,
    harnessId,
    model: model ?? null,
    cwd: cwd ?? null,
    projectId: projectId ?? null,
  });
export const cancelAgentChatMessage = (chatSessionId: string) =>
  safeInvoke<void>("cancel_agent_chat_message", { chatSessionId });

/** Models/endpoint discovered in a CLI harness's own config files
 *  (harness_config.rs): settings.json / config.toml / opencode.json. */
export interface HarnessModelInfo {
  id: string;
  label: string;
  source: "config" | "builtin";
}
export interface HarnessModelConfig {
  defaultModel: string | null;
  endpoint: string | null;
  models: HarnessModelInfo[];
}
export const listHarnessModels = (harnessId: string) =>
  safeInvoke<HarnessModelConfig | null>("list_harness_models", { harnessId });

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

/** Whether the global "ConduitAutomations" Task Scheduler entry is
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

/** Switch a chat session's provider (e.g. to/from "local_gguf" when picking a
 *  local model from the selector in a cloud session, or vice versa). */
export const updateChatSessionProvider = (chatSessionId: string, provider: string) =>
  safeInvoke<void>("update_chat_session_provider", { chatSessionId, provider });
/** Update a chat session's watch-mode pacing override. null clears the
 *  override so the session inherits the global setting; "on" | "off" set
 *  a per-session override. */
export const updateChatSessionWatchMode = (
  chatSessionId: string,
  mode: "on" | "off" | null,
) =>
  safeInvoke<void>("update_chat_session_watch_mode", { chatSessionId, mode });
/** Update a chat session's permission posture
 *  (`read_only` | `manual` | `auto_edit` | `full_auto`). Per-session; new
 *  sessions start at `manual`. Honored by the built-in chat tool loops and by
 *  headless Claude Code sessions; Kimi/OpenCode headless always run full-auto.
 *  The frontend gates the switch to `full_auto` behind a one-time
 *  confirmation modal before calling this. */
export const updateChatSessionPermissionMode = (
  chatSessionId: string,
  mode: "read_only" | "manual" | "auto_edit" | "full_auto",
) =>
  safeInvoke<void>("update_chat_session_permission_mode", { chatSessionId, mode });
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

export const listChatModels = (
  provider: string,
  baseUrl?: string,
  apiKey?: string,
) =>
  safeInvoke<{ id: string; object: string; created: number; ownedBy: string }[] | null>("list_chat_models", {
    provider,
    baseUrl: baseUrl ?? null,
    apiKey: apiKey ?? null,
  });

// ---- Local models (GGUF scan / llama-server sidecar) ----

export interface GgufModel {
  id: string;
  path: string;
  filename: string;
  sizeBytes: number;
  name: string | null;
  architecture: string | null;
  paramCountLabel: string | null;
  quantization: string | null;
  memoryClass: "fits" | "tight" | "too_large";
  source: string;
  /** Whether a companion mmproj vision-projector GGUF was found next to this model. */
  hasVision: boolean;
  /** Absolute path to the companion mmproj GGUF, if one exists. */
  mmprojPath: string | null;
}

export interface StartedModel {
  modelId: string;
  port: number;
  /** Effective context window the sidecar was launched with. */
  nCtx: number;
  /**
   * Effective `--n-gpu-layers` value the sidecar launched with after the
   * stepwise GPU-fallback ladder. 0 = CPU-only, >0 = partial or full offload.
   * The UI surfaces this so the user understands the offload decision.
   */
  nGpuLayers: number;
  baseUrl: string;
}

export interface ActiveLocalModel {
  modelId: string;
  port: number;
  nCtx: number;
  /** Effective `--n-gpu-layers` of the running sidecar. */
  nGpuLayers: number;
  baseUrl: string;
}

export const scanLocalModels = (folder?: string) =>
  safeInvoke<GgufModel[] | null>("scan_local_models", folder ? { folder } : {});

export const startLocalModel = (modelId: string, path: string, ngl?: number, ctx?: number, mmprojPath?: string | null) =>
  safeInvoke<StartedModel | null>("start_local_model", {
    modelId,
    path,
    ngl: ngl ?? null,
    ctx: ctx ?? null,
    mmprojPath: mmprojPath ?? null,
  });

export const stopLocalModel = (modelId: string) =>
  safeInvoke<void>("stop_local_model", { modelId });

export const localModelStatus = () =>
  safeInvoke<ActiveLocalModel | null>("local_model_status");

/** Live context-window usage for a local-model session, returned by
 *  `count_context_tokens`. `usedTokens` is null when no sidecar is running
 *  or the tokenizer errored; `maxTokens` is the sidecar's `-c` cap (0 for
 *  non-local / no-sidecar). */
export interface ContextUsage {
  usedTokens: number | null;
  maxTokens: number;
}
export const countContextTokens = (chatSessionId: string) =>
  safeInvoke<ContextUsage | null>("count_context_tokens", { chatSessionId });

/** Per-category context-window breakdown for the rich context-meter tooltip. */
export interface ContextBreakdown {
  totalTokens: number;
  maxTokens: number;
  systemPromptTokens: number;
  messagesTokens: number;
  toolSpecsTokens: number;
  connectorToolsTokens: number;
  skillsTokens: number;
  metacontextTokens: number;
}

export const countContextBreakdown = (chatSessionId: string) =>
  safeInvoke<ContextBreakdown | null>("count_context_breakdown", { chatSessionId });

export const listenChatToken = (handler: (payload: ChatTokenPayload) => void) =>
  safeListen<ChatTokenPayload>("chat:token", handler);
export const listenChatStatus = (handler: (payload: ChatStatusPayload) => void) =>
  safeListen<ChatStatusPayload>("chat:status", handler);
export const listenChatDone = (handler: (payload: ChatDonePayload) => void) =>
  safeListen<ChatDonePayload>("chat:done", handler);
/** Throttled (~1 Hz) live perf snapshot while a turn is streaming. The
 *  composer metrics row subscribes here so it can update without waiting
 *  for the next chat:done event. */
export const listenChatPerf = (handler: (payload: ChatPerfPayload) => void) =>
  safeListen<ChatPerfPayload>("chat:perf", handler);
export const listenChatError = (handler: (payload: ChatErrorPayload) => void) =>
  safeListen<ChatErrorPayload>("chat:error", handler);
export const listenChatArtifact = (handler: (payload: ChatArtifactPayload) => void) =>
  safeListen<ChatArtifactPayload>("chat:artifact", handler);
/** Emitted after each checkpoint row+ref is created (baseline, post-turn,
 *  or pre-restore safety snapshot) so the chip can appear live. */
export const listenCheckpointCreated = (handler: (payload: ChatCheckpoint) => void) =>
  safeListen<ChatCheckpoint>("checkpoint:created", handler);
export const listenChatOpenBrowser = (handler: (payload: ChatOpenBrowserPayload) => void) =>
  safeListen<ChatOpenBrowserPayload>("chat:open-browser", handler);

export const listenChatTaskProgress = (handler: (payload: ChatTaskProgressPayload) => void) =>
  safeListen<ChatTaskProgressPayload>("chat:task-progress", handler);

export const listenChatApprovalRequest = (handler: (payload: ChatApprovalRequestPayload) => void) =>
  safeListen<ChatApprovalRequestPayload>("chat:approval-request", handler);
export const listenChatApprovalResolved = (handler: (payload: ChatApprovalResolvedPayload) => void) =>
  safeListen<ChatApprovalResolvedPayload>("chat:approval-resolved", handler);

export const listenPlanStepProgress = (handler: (payload: PlanStepProgressPayload) => void) =>
  safeListen<PlanStepProgressPayload>("chat:plan-step-progress", handler);

// ---- Subagent events ----

export interface SubagentInfo {
  id: string;
  role: string;
  task: string;
  prompt: string;
  output: string;
  status: "running" | "completed" | "error";
  error?: string;
}

export interface SubagentSpawnPayload {
  chatSessionId: string;
  id: string;
  role: string;
  task: string;
  prompt: string;
}

export interface SubagentTokenPayload {
  chatSessionId: string;
  subagentId: string;
  chunk: string;
}

export interface SubagentDonePayload {
  chatSessionId: string;
  id: string;
  output: string;
  error?: string;
}

export const listenChatSubagentSpawn = (handler: (payload: SubagentSpawnPayload) => void) =>
  safeListen<SubagentSpawnPayload>("chat:subagent-spawn", handler);

export const listenChatSubagentTokens = (handler: (payload: SubagentTokenPayload) => void) =>
  safeListen<SubagentTokenPayload>("chat:subagent-tokens", handler);

export const listenChatSubagentDone = (handler: (payload: SubagentDonePayload) => void) =>
  safeListen<SubagentDonePayload>("chat:subagent-done", handler);

/** Re-broadcast a chat event to the mobile relay. Used from useChatEvents.ts to
 *  forward chat:token, chat:status, chat:done, chat:error,
 *  and chat:artifact events to the per-session mobile connection. */
export const emitMobileSessionChatEvent = (
  sessionId: string,
  kind: string,
  payload: unknown,
) => {
  if (!tauriAvailable()) return Promise.resolve();
  return import("@tauri-apps/api/event")
    .then(({ emit }) =>
      emit("mobile:session_chat_event", { session_id: sessionId, kind, payload }),
    )
    .catch((err) => console.warn("[conduit] emitMobileSessionChatEvent failed", err));
};

export interface ChatOwnerPayload {
  chatSessionId: string;
  ownerSessionId: string;
}
export const listenChatOwner = (handler: (payload: ChatOwnerPayload) => void) =>
  safeListen<ChatOwnerPayload>("mobile:session_chat_owner", handler);

/** Read a generated artifact for in-app preview. */
export const readArtifactPreview = (path: string) =>
  safeInvoke<ArtifactPreview | null>("read_artifact_preview", { path });

/** True when LibreOffice is installed — the pptx→pdf preview path needs it.
 *  When false, pptx previews fall back to the built-in HTML converter. */
export const isLibreofficeAvailable = () =>
  safeInvoke<boolean>("is_libreoffice_available");

/** Open a generated artifact file with the OS default application. */
export async function openArtifact(path: string): Promise<void> {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  } catch (err) {
    console.warn("openArtifact failed", err);
  }
}

/**
 * Save (download) a single artifact to a user-chosen location via a save
 * dialog. Returns true if saved, false if the user cancelled.
 */
export async function downloadArtifact(
  path: string,
  filename: string,
): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({ defaultPath: filename });
  if (!dest) return false;
  await safeInvoke<void>("download_artifact", { src: path, dest });
  return true;
}

/**
 * Save all given artifacts into a single `.zip` at a user-chosen location.
 * Returns true if saved, false if the user cancelled.
 */
export async function downloadArtifactsZip(
  paths: string[],
  defaultName = "artifacts.zip",
): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({
    defaultPath: defaultName,
    filters: [{ name: "Zip archive", extensions: ["zip"] }],
  });
  if (!dest) return false;
  await safeInvoke<void>("download_artifacts_zip", { paths, dest });
  return true;
}

// ---- Chat export / import (local-first backup, roadmap #7) ----

/** Export one chat session to a `.zip` at a user-chosen location. Returns
 *  true if saved, false if the user cancelled. */
export async function exportChatZip(
  sessionId: string,
  defaultName = `${Date.now()}-chat.zip`,
): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({
    defaultPath: defaultName,
    filters: [{ name: "Conduit backup", extensions: ["zip"] }],
  });
  if (!dest) return false;
  await safeInvoke<void>("export_chat_zip", { sessionId, dest });
  return true;
}

/** Export every chat bound to a project to a `.zip` at a user-chosen location.
 *  Returns true if saved, false if the user cancelled. */
export async function exportProjectZip(
  projectId: string,
  defaultName = `${Date.now()}-project-backup.zip`,
): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({
    defaultPath: defaultName,
    filters: [{ name: "Conduit backup", extensions: ["zip"] }],
  });
  if (!dest) return false;
  await safeInvoke<void>("export_project_zip", { projectId, dest });
  return true;
}

/** Import a chat-export `.zip` (single chat or whole project). Opens a picker
 *  and returns the `chat_session` ids it restored, or `null` if cancelled. */
export async function importChatZip(): Promise<string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const src = await open({
    multiple: false,
    filters: [{ name: "Conduit backup", extensions: ["zip"] }],
    title: "Select a Conduit backup (.zip) to restore",
  });
  if (typeof src !== "string" || !src) return null;
  return safeInvoke<string[]>("import_chat_zip", { src });
}

// ---- Auto-updater (Tauri updater plugin) ----

/** Info about an available update, or update_available:false when current. */
export interface UpdateInfo {
  updateAvailable: boolean;
  version: string | null;
  notes: string | null;
  pubDate: string | null;
}

export interface UpdateProgressPayload {
  downloaded: number;
  total: number | null;
}

/** Check the configured endpoint for a newer version. Non-throwing on network
 *  failure — the backend returns update_available:false instead. */
export const checkForUpdate = (): Promise<UpdateInfo | null> =>
  safeInvoke<UpdateInfo | null>("check_for_update");

/** Download + verify + install the pending update. Emits `updater:progress`
 *  during download, then `updater:installed`. The backend restarts the app
 *  automatically after a successful install. */
export const downloadAndInstallUpdate = (): Promise<void> =>
  safeInvoke<void>("download_and_install_update");

export const listenUpdaterProgress = (handler: (payload: UpdateProgressPayload) => void) =>
  safeListen<UpdateProgressPayload>("updater:progress", handler);

export const listenUpdaterInstalled = (handler: () => void) =>
  safeListen("updater:installed", () => handler());

// --- Connectors (OAuth + remote MCP) ---

export interface ConnectorStatus {
  connected: boolean;
  /** True when the stored access token has expired (the backend transparently
   *  refreshes on next use; if no refresh token exists — Notion — the user
   *  must reconnect). */
  expired: boolean;
  accountDisplay?: string | null;
  grantedScopes?: string | null;
  expiresAt?: number | null;
}

/** A supported connector + its current connection status. Mirrors the Rust
 *  `ConnectorWithStatus` (the Connector fields are flattened in). */
export interface ConnectorWithStatus {
  id: string;
  displayName: string;
  icon: string;
  /** Product family the Settings UI groups this connector under (e.g. "google"). */
  family: string;
  mcpServerUrl: string;
  revokeUrl?: string | null;
  status: ConnectorStatus;
}

export interface DisconnectOutcome {
  revoked: boolean;
  note?: string | null;
}

export interface OAuthCallbackPayload {
  flowId: number;
  connectorId: string;
  /** "connected" | "denied" | "error" */
  status: string;
  error?: string | null;
  accountDisplay?: string | null;
}

export const listConnectors = () =>
  safeInvoke<ConnectorWithStatus[] | null>("list_connectors");
export const connectorConnect = (connectorId: string) =>
  safeInvoke<number>("connector_connect", { connectorId });
/** One OAuth flow for a whole connector family ("google") — connects every member. */
export const connectorConnectFamily = (family: string) =>
  safeInvoke<number>("connector_connect_family", { family });
export const connectorDisconnect = (connectorId: string) =>
  safeInvoke<DisconnectOutcome>("connector_disconnect", { connectorId });
export const setSessionConnectors = (chatSessionId: string, connectorIds: string[]) =>
  safeInvoke<void>("set_session_connectors", { chatSessionId, connectorIds });
export const listSessionConnectors = (chatSessionId: string) =>
  safeInvoke<string[]>("list_session_connectors", { chatSessionId });
export const listenOAuthCallback = (handler: (payload: OAuthCallbackPayload) => void) =>
  safeListen<OAuthCallbackPayload>("oauth:callback", handler);

// ---- Workspaces (pane layout save/restore) ----

export interface WorkspaceRecord {
  id: string;
  projectId: string;
  name: string;
  data: string; // JSON string
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceData {
  panes: Array<{
    kind: "terminal" | "browser";
    harness?: string;
    sessionId?: string;
    label?: string;
    url?: string;
    cwd?: string;
  }>;
  splitFractions?: { colFrac?: number; rowFracs?: number[] };
}

export const listWorkspaces = (projectId: string) =>
  safeInvoke<WorkspaceRecord[] | null>("list_workspaces", { projectId });

export const saveWorkspace = (projectId: string, name: string, data: string) =>
  safeInvoke<WorkspaceRecord | null>("save_workspace", { projectId, name, data });

export const deleteWorkspace = (id: string) =>
  safeInvoke<void>("delete_workspace", { id });

// ---- Mobile relay (desktop ↔ mobile companion app) ----

export interface MobileRelayStatus {
  running: boolean;
  port: number;
}

export const startMobileRelay = () =>
  safeInvoke<number | null>("start_mobile_relay");

export const stopMobileRelay = () =>
  safeInvoke<void>("stop_mobile_relay");

export const getMobileRelayStatus = () =>
  safeInvoke<MobileRelayStatus | null>("get_mobile_relay_status");


// ---- Local Models market (Hugging Face browse + download) ----

export type ModelSort = "downloads" | "likes" | "modified" | "trending";

export interface CatalogEntry {
  id: string;
  displayName: string;
  author: string;
  repoId: string;
  filename: string;
  downloads: number;
  likes: number;
  lastModified?: string | null;
  sizeBytes: number;
  description?: string | null;
  tags: string[];
  sha256?: string | null;
  downloadUrl: string;
  vision: boolean;
  paramsLabel?: string | null;
  quantization?: string | null;
  license?: string | null;
  gated: boolean;
}

export interface FetchCatalogResult {
  entries: CatalogEntry[];
  hasHuggingFaceToken: boolean;
  defaultModelsDir?: string | null;
}

export interface MarketSettings {
  modelsDir?: string | null;
  defaultModelsDir?: string | null;
  hasHuggingFaceToken: boolean;
}

export type DownloadState =
  | "starting"
  | "downloading"
  | "verifying"
  | "done"
  | "error"
  | "cancelled";

export interface DownloadProgress {
  id: string;
  downloadedBytes: number;
  totalBytes?: number | null;
  state: DownloadState;
  bytesPerSecond: number;
  finalPath?: string | null;
  error?: string | null;
}

export interface FetchCatalogArgs {
  query?: string;
  sort?: ModelSort;
  limit?: number;
}

export interface StartDownloadArgs {
  id: string;
  repoId: string;
  filename: string;
  downloadUrl: string;
  expectedSha256?: string | null;
  destDir?: string | null;
}

export const fetchModelCatalog = (args: FetchCatalogArgs = {}) =>
  // Flat payload — the Rust command takes top-level `query`/`sort`/`limit`
  // params, not a nested `args` object. (Nesting silently broke search/sort
  // and made every download fail with "missing required argument id".)
  safeInvoke<FetchCatalogResult | null>("fetch_model_catalog", {
    query: args.query ?? null,
    sort: args.sort ?? null,
    limit: args.limit ?? null,
  });

/** GPU VRAM info for the model-market size gate. Null when no discrete GPU. */
export interface GpuVramInfo {
  totalVramBytes: number | null;
  deviceName: string | null;
}

export const getGpuVram = () => safeInvoke<GpuVramInfo | null>("get_gpu_vram");

export const getMarketSettings = () =>
  safeInvoke<MarketSettings | null>("get_market_settings");

export const setModelsDirectory = (dir: string) =>
  safeInvoke<void>("set_models_directory", { dir });

export const pickModelsDirectory = () =>
  safeInvoke<string | null>("pick_models_directory");

export const setHuggingFaceToken = (token: string) =>
  safeInvoke<void>("set_hugging_face_token", { token });

export const clearHuggingFaceToken = () =>
  safeInvoke<void>("clear_hugging_face_token");

export const startModelDownload = (args: StartDownloadArgs) =>
  // Flat payload — see fetchModelCatalog note above.
  safeInvoke<void>("start_model_download", {
    id: args.id,
    repoId: args.repoId,
    filename: args.filename,
    downloadUrl: args.downloadUrl,
    expectedSha256: args.expectedSha256 ?? null,
    destDir: args.destDir ?? null,
  });

export const cancelModelDownload = (id: string) =>
  safeInvoke<void>("cancel_model_download", { id });

export const onModelDownloadProgress = (
  handler: (p: DownloadProgress) => void,
) => safeListen<DownloadProgress>("local-model:download:progress", handler);

// ---- Local Models market: file management + auto-sidecar download ----

export const deleteDownloadedModel = (path: string) =>
  safeInvoke<void>("delete_downloaded_model", { path });

export const downloadMmproj = (
  repoId: string,
  mmprojFilename?: string,
) =>
  safeInvoke<void>("download_mmproj", { repoId, mmprojFilename });


// ---- GitHub Pulls tab ----

export interface PullRequestSummary {
  number: number;
  title: string;
  author: string;
  authorAvatar: string | null;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
  state: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: boolean | null;
}

export interface PullRequestFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PullRequestChecks {
  state: string; // "success" | "failure" | "pending" | "none"
  total: number;
  failing: number;
  pending: number;
}

export interface PullRequestDraft {
  title: string;
  body: string;
}

export const githubListPrs = (projectId: string, state: "open" | "closed" | "all" = "open") =>
  safeInvoke<PullRequestSummary[]>("github_list_prs", { projectId, state });
export const githubCreatePr = (
  projectId: string,
  title: string,
  body: string,
  head: string,
  base: string,
  draft: boolean,
) => safeInvoke<PullRequestSummary>("github_create_pr", { projectId, title, body, head, base, draft });
export const githubGetPr = (projectId: string, number: number) =>
  safeInvoke<PullRequestDetail>("github_get_pr", { projectId, number });
export const githubPrFiles = (projectId: string, number: number) =>
  safeInvoke<PullRequestFile[]>("github_pr_files", { projectId, number });
export const githubSubmitReview = (
  projectId: string,
  number: number,
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
  body: string,
) => safeInvoke<void>("github_submit_review", { projectId, number, event, body });
export const githubPrChecks = (projectId: string, number: number) =>
  safeInvoke<PullRequestChecks>("github_pr_checks", { projectId, number });
/** Agent-drafted PR title+body from the branch diff. null = no model
 *  configured or the branch has no diff vs base. */
export const githubDraftPrText = (projectId: string, base: string, chatSessionId: string) =>
  safeInvoke<PullRequestDraft | null>("github_draft_pr_text", { projectId, base, chatSessionId });

export interface BranchOption {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

/** Local + remote branches of the project's repo (create-form pickers). */
export const githubLocalBranches = (projectId: string) =>
  safeInvoke<BranchOption[]>("github_local_branches", { projectId });


// ---- Local Knowledge (RAG corpora) ----
//
// Backend contract lives in src-tauri/src/docs_index.rs and src/db/docs.rs.
// Commands are registered in src-tauri/src/lib.rs::invoke_handler.
// The `search_docs` model tool (auto-exposed when the sidecar is up and at
// least one corpus is indexed) consumes these corpora from the chat tool loop
// — see src-tauri/src/chat/tools/mod.rs SEARCH_DOCS + ToolCaps.local_docs.

export const docsEmbeddingStatus = () =>
  safeInvoke<DocsEmbeddingStatus | null>("docs_embedding_status");

/** Add a folder as a corpus. The backend canonicalises the path and rejects
 *  re-adds of an already-indexed folder; `name` defaults to the folder's
 *  last segment when omitted. */
export const docsAddCorpus = (path: string, name?: string) =>
  safeInvoke<DocCorpus | null>("docs_add_corpus", {
    path,
    name: name ?? null,
  });

export const docsRemoveCorpus = (corpusId: string) =>
  safeInvoke<void>("docs_remove_corpus", { corpusId });

export const docsListCorpora = () =>
  safeInvoke<DocCorpus[] | null>("docs_list_corpora");

export const docsSetCorpusEnabled = (corpusId: string, enabled: boolean) =>
  safeInvoke<void>("docs_set_corpus_enabled", { corpusId, enabled });

/** Start an index run for one corpus. Returns once the run is queued — actual
 *  progress arrives via `onDocsIndexProgress`. */
export const docsStartIndex = (corpusId: string) =>
  safeInvoke<void>("docs_start_index", { corpusId });

export const docsCancelIndex = (corpusId: string) =>
  safeInvoke<boolean>("docs_cancel_index", { corpusId });

/** Stream `docs:index:progress` events for an in-flight index run. */
export const onDocsIndexProgress = (
  handler: (p: DocsIndexProgressPayload) => void,
) =>
  safeListen<DocsIndexProgressPayload>("docs:index:progress", handler);

/** Emitted by the backend when a corpus row's totals change (counts /
 *  lastIndexedAt updated after an index run finishes). The UI re-fetches the
 *  row to refresh the displayed counts. */
export const onDocsCorpusUpdated = (
  handler: (corpusId: string) => void,
) =>
  safeListen<DocCorpus>("docs:corpus:updated", (c) => handler(c.id));

