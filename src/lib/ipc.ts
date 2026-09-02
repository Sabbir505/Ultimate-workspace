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
  AcpAgentStatus,
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
/** WebView2 NavigationCompleted (success only) — the label of the webview
 *  ("browser-{pane}-tab-{tab}"). The ground-truth "this page really finished
 *  loading" signal, used to clear the pane's loading flag even when the
 *  navigation-start event never surfaced. */
export const listenBrowserLoadCompleted = (handler: (label: string) => void) =>
  safeListen<string>("browser:load-completed", handler);

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
/** One-click global npm install of a harness CLI (Harnesses settings panel).
 *  Long-running — resolves with a confirmation line or rejects with the
 *  npm stderr tail. Re-probe via listHarnesses() afterwards. */
export const installHarness = (harnessId: HarnessId) =>
safeInvoke<string>("install_harness", { harnessId });

// --- ACP agents (roadmap #20) ---
// ACP = Agent Client Protocol: JSON-RPC 2.0 over stdio, spoken by Zed/Devin-
// ecosystem agents. The agent menu lists static registry entries + user-defined
// agents (see AcpAgentsPanel); user definitions persist as a JSON array under
// the `acp.agents` app_settings key (same KV-blob pattern as prompts.templates).

export const listAcpAgents = () => safeInvoke<AcpAgentStatus[] | null>("list_acp_agents");

export interface AcpAgentDef {
  id: string;
  displayName: string;
  /** Command on PATH (or an absolute path). */
  command: string;
  /** Args that launch the ACP stdio server (e.g. ["--stdio"]). */
  args: string[];
  /** Extra environment variables for the spawn. */
  env: Record<string, string>;
}

const ACP_AGENTS_KEY = "acp.agents";

export async function listAcpAgentDefs(): Promise<AcpAgentDef[]> {
  try {
    const raw = await getSetting(ACP_AGENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AcpAgentDef[]) : [];
  } catch {
    return [];
  }
}

export async function saveAcpAgentDefs(agents: AcpAgentDef[]): Promise<void> {
  await setSetting(ACP_AGENTS_KEY, JSON.stringify(agents));
}

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
/** Per-file diff against a chosen base — backs the Changes panel's filters:
 *  "worktree" (the classic per-file diff), "staged" (HEAD vs index), and
 *  "base:<tree-sha>" (<sha> vs worktree; "base:empty" = the empty tree). */
export const getGitFileDiffScoped = (path: string, filePath: string, scope: string) =>
  safeInvoke<string | null>("get_git_file_diff_scoped", { path, filePath, scope });
/** Every change on the current branch vs its base (merge-base vs working
 *  tree + untracked files), plus the merge-base sha the UI can expand any
 *  file against ("base:<mergeBase>"). */
export interface BranchChanges {
  files: ChangedFile[];
  mergeBase: string;
}
export const getBranchChangedFiles = (path: string) =>
  safeInvoke<BranchChanges | null>("get_branch_changed_files", { path });
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
  /** Decoration refs, e.g. "HEAD -> master, origin/master" (no parens). */
  refs: string;
  author: string;
  /** Commit date (%ci): "YYYY-MM-DD HH:MM:SS ±ZZ:ZZ" — sliced client-side. */
  date: string;
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

/** Generate a model-backed review of the working-tree diff (§3.2.8).
 *  Reviews either the whole working tree (`filePath` = null) or a single file.
 *  Returns the review text, or null when there's no diff or generation failed. */
export const generateDiffReview = (path: string, chatSessionId?: string, filePath?: string) =>
  safeInvoke<string | null>("generate_diff_review", { path, chatSessionId, filePath });

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

// ---- Speech-to-text models (Settings → Knowledge manages; mic uses) ----

export interface SttModelInfo {
  id: string;
  label: string;
  filename: string;
  downloadUrl: string;
  sizeBytes: number;
  note: string;
  recommended: boolean;
  installed: boolean;
  isDefault: boolean;
}

export interface SttStatus {
  running: boolean;
  port: number | null;
  modelPath: string | null;
  binaryPath: string | null;
  defaultModel: string | null;
  autoStart: boolean;
  sttDir: string | null;
  catalog: SttModelInfo[];
}

export const sttStatus = () => safeInvoke<SttStatus>("stt_status");
export const sttStart = () => safeInvoke<SttStatus>("stt_start");
export const sttStop = () => safeInvoke<void>("stt_stop");
/** One-click install: downloads the pinned upstream whisper.cpp release,
 *  extracts whisper-server.exe (+ DLLs) into the app-data bin dir, and saves
 *  its path into `stt.whisperServerPath`. Progress arrives on
 *  `onModelDownloadProgress` under id "stt-whisper-server". */
export const sttInstallServer = () => safeInvoke<SttStatus>("stt_install_server");
export const sttSetDefault = (filename: string) =>
  safeInvoke<void>("stt_set_default", { filename });
export const sttSetAutoStart = (autoStart: boolean) =>
  safeInvoke<void>("stt_set_auto_start", { autoStart });
export const sttSetServerPath = (path: string | null) =>
  safeInvoke<void>("stt_set_server_path", { path: path ?? null });

/** Pop a chat session out into its own OS window (roadmap #17). */
export const popOutChat = (sessionId: string) =>
  safeInvoke<void>("pop_out_chat", { sessionId });

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
   *  isolated git worktree (sibling of the project, branch `conduit/<id>`),
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
  /** Time from the first model request to the first streamed token (ms). */
  ttftMs: number | null;
  /** Decode throughput = outputTokens / decode time (tokens per second);
   *  prefill and connection time excluded. */
  tokensPerSecond: number | null;
  /** Prompt/KV-cache hit rate (0.0–1.0), computed from usage cache fields. */
  cacheHitRate: number | null;
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

// ---- Structured plan tracking (todo_write / enter_plan_mode / present_plan) ----

/** One item of the model-declared task list. Same shape on the wire for the
 *  `todo_write` tool input, `present_plan` proposals, and every plan event. */
export interface PlanTodo {
  content: string;
  /** "pending" | "in_progress" | "completed" */
  status: "pending" | "in_progress" | "completed";
  /** Present-continuous label shown while the step runs ("Writing parser"). */
  activeForm?: string | null;
}

/** The model's authoritative task list for a session, pushed as
 *  `chat:plan-updated` on every todo_write call and after a plan approval. */
export interface ChatPlanUpdatedPayload {
  chatSessionId: string;
  todos: PlanTodo[];
}

/** Plan mode flipped on/off for a session (`chat:plan-mode`) — from the
 *  mode menu, the model's `enter_plan_mode` call, or a plan approval.
 *  `label` is the session's permissionMode AFTER the transition ("plan" when
 *  active; otherwise the restored posture label). */
export interface ChatPlanModePayload {
  chatSessionId: string;
  active: boolean;
  reason?: string | null;
  label: string;
}

/** An APPROVED plan — the approach document the model presented via
 *  present_plan and the user accepted. Listed in the sidebar Plans section;
 *  execution steps live separately in the todo list (Progress). */
export interface ChatPlanRecord {
  id: string;
  title: string;
  /** The full plan markdown. */
  content: string;
  approvedAt: number;
}

/** A `present_plan` proposal awaiting the user's decision
 *  (`chat:plan-proposal`). Resolved via `resolvePlanProposal`. */
export interface ChatPlanProposalPayload {
  chatSessionId: string;
  pendingId: string;
  /** Short heading for the card. */
  title: string;
  /** The plan markdown (the approach — NOT a step checklist). */
  plan: string;
}

/** Emitted when the user approves a plan proposal — appends to the session's
 *  Plans list in the sidebar. */
export interface ChatPlanAcceptedPayload {
  chatSessionId: string;
  plan: ChatPlanRecord;
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

// --- Conversational Artifact Creation (Phase 1) ---

export type ArtifactType = "skill" | "loop" | "prompt_template" | "automation";

export type ArtifactAction = "create" | "save" | "update" | "none";

export interface InputDefinition {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: string;
}

export interface OutputDefinition {
  name: string;
  type: string;
  description: string;
}

export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export type PermissionPolicy = "read_only" | "workspace_write" | "full_access" | "unknown";

export interface Example {
  input: Record<string, string>;
  output: string;
}

export interface SkillSpec {
  name: string;
  description: string;
  instructions: string;
  inputs: InputDefinition[];
  outputs: OutputDefinition[];
  tools?: string[];
  model?: ModelConfig;
  permissions?: PermissionPolicy;
  examples?: Example[];
}

export interface LoopSpec {
  name: string;
  description: string;
  objective: string;
  inputs: InputDefinition[];
  steps: WorkflowStep[];
  iteration: IterationConfig;
  outputs: OutputDefinition[];
  permissions?: PermissionPolicy;
}

export interface WorkflowStep {
  label: string;
  action: string;
  inputs?: Record<string, string>;
  condition?: string;
}

export interface IterationConfig {
  maxIterations: number;
  stopCondition?: string;
}

export interface PromptVariable {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: string;
}

export interface PromptExample {
  input: Record<string, string>;
  output: string;
}

export interface PromptTemplateSpec {
  name: string;
  description: string;
  template: string;
  variables: PromptVariable[];
  outputFormat?: string;
  examples?: PromptExample[];
}

export interface AutomationTrigger {
  kind: "schedule" | "event" | "webhook";
  schedule?: string; // cron expression for schedule trigger
}

export interface AutomationSpec {
  name: string;
  description: string;
  trigger: AutomationTrigger;
  steps: WorkflowStep[];
  /** The harness/agent to run (e.g. "claude_code", "opencode"). Present when user has chosen. */
  harness?: string;
  /** The model to use within the harness. Empty = harness's default. */
  model?: string;
  inputs?: InputDefinition[];
  outputs?: OutputDefinition[];
  permissions?: PermissionPolicy;
  enabled: boolean;
}

export type ArtifactSpec =
  | ({ type: "skill" } & SkillSpec)
  | ({ type: "loop" } & LoopSpec)
  | ({ type: "prompt_template" } & PromptTemplateSpec)
  | ({ type: "automation" } & AutomationSpec);

export interface ArtifactProvenance {
  source: "manual" | "chat";
  conversationId?: string;
  sourceMessageIds?: number[];
  createdAt: number;
  schemaVersion: number;
  generatorVersion: string;
}

export interface ArtifactProposal {
  id: string;
  artifactType: ArtifactType;
  spec: ArtifactSpec;
  confidence: number;
  missingFields: string[];
  assumptions: string[];
  /** Original user instruction used to generate this proposal, retained for regeneration. */
  originalInstruction?: string;
  /** Persisted chat message id that triggered this proposal, when the frontend
   *  persisted the command as a real DB row. Used to render the proposal card
   *  inline next to the command bubble in the chat timeline. */
  sourceMessageId?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface CreatedArtifact {
  id: string;
  artifactType: ArtifactType;
  name: string;
}

export interface GenerateArtifactRequest {
  chatSessionId: string;
  userMessage: string;
  artifactType?: ArtifactType;
  [key: string]: unknown;
}

export interface ValidateArtifactRequest {
  proposal: ArtifactProposal;
  [key: string]: unknown;
}

export interface CreateArtifactRequest {
  spec: ArtifactSpec;
  provenance: ArtifactProvenance;
  [key: string]: unknown;
}

export interface RegenerateArtifactRequest {
  chatSessionId: string;
  userMessage: string;
  additionalInstruction: string;
  originalInstruction: string;
  artifactType?: ArtifactType;
  [key: string]: unknown;
}

export interface IntentDecision {
  decision: "create_proposal" | "save_proposal" | "update_proposal" | "ask_clarification" | "normal_conversation";
  intent?: ArtifactIntent;
  message?: string;
}

export interface ArtifactIntent {
  action: ArtifactAction;
  artifactType?: ArtifactType;
  instruction?: string;
}

export interface ArtifactSummary {
  id: string;
  name: string;
  description: string;
  artifactType: ArtifactType;
  createdAt: number;
}

export interface ArtifactUpdateResult {
  success: boolean;
  artifactId: string;
  artifactType: string;
  name: string;
  diff: string;
}

export interface ArtifactContextResponse {
  availableTools: string[];
  availableSkills: string[];
  messages: { role: string; content: string }[];
}

export const persistChatCommandMessage = (chatSessionId: string, content: string) =>
  safeInvoke<ChatMessageRecord>("persist_chat_command_message", { chatSessionId, content });

export const generateArtifact = (request: GenerateArtifactRequest) =>
  safeInvoke<ArtifactProposal>("generate_artifact_cmd", { request });

export const validateArtifact = (request: ValidateArtifactRequest) =>
  safeInvoke<ValidationResult>("validate_artifact_cmd", { request });

export const createArtifact = (request: CreateArtifactRequest) =>
  safeInvoke<CreatedArtifact>("create_artifact_cmd", { request });

export const regenerateArtifact = (request: RegenerateArtifactRequest) =>
  safeInvoke<ArtifactProposal>("regenerate_artifact_cmd", {
    chatSessionId: request.chatSessionId,
    userMessage: request.userMessage,
    additionalInstruction: request.additionalInstruction,
    originalInstruction: request.originalInstruction,
    artifactType: request.artifactType,
  });

export const saveArtifact = (request: GenerateArtifactRequest) =>
  safeInvoke<CreatedArtifact>("save_artifact_cmd", { request });

export const searchArtifacts = (query: string, artifactType?: string) =>
  safeInvoke<ArtifactSummary[]>("search_artifacts_cmd", { query, artifactType });

export const updateArtifact = (artifactId: string, artifactType: string, newSpec: ArtifactSpec) =>
  safeInvoke<ArtifactUpdateResult>("update_artifact_cmd", {
    artifactId,
    artifactType,
    newSpec,
  });

export const getArtifactContext = (chatSessionId: string, includeMessages: boolean) =>
  safeInvoke<ArtifactContextResponse>("get_artifact_context_cmd", { chatSessionId, includeMessages });

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
    | "mermaid"
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

/** Result of a checkpoint restore: the SAFETY checkpoint taken of the
 *  pre-restore state (restore-the-restore) plus how many conversation
 *  messages were rolled back with it (0 when `rollbackMessages` was off or
 *  the checkpoint followed no message). */
export interface RestoreCheckpointResult {
  safety: ChatCheckpoint;
  deletedMessages: number;
}

/** Roll a checkpoint's repo back to its snapshot. Returns the SAFETY
 *  checkpoint taken of the current state first (restore-the-restore). With
 *  `rollbackMessages` (default false) the conversation is trimmed to the
 *  checkpointed turn as well. */
export const restoreChatCheckpoint = (checkpointId: number, rollbackMessages?: boolean) =>
  safeInvoke<RestoreCheckpointResult | null>("restore_chat_checkpoint", {
    checkpointId,
    rollbackMessages: rollbackMessages ?? false,
  });
export const createChatSession = (provider: string, model: string, projectId?: string | null) =>
  safeInvoke<ChatSession | null>("create_chat_session", { provider, model, projectId: projectId ?? null });
/** Bind (or unbind with null) a chat session to a project, so it nests under
 *  that project's expandable sidebar row. */
export const setChatSessionProject = (chatSessionId: string, projectId?: string | null) =>
  safeInvoke<void>("set_chat_session_project", { chatSessionId, projectId: projectId ?? null });
/** Worktree-per-session (roadmap P0 §3.1.1): make sure the chat has an
 *  isolated git worktree and returns its path (null when unbound or the
 *  project isn't a git repo). Idempotent and best-effort — callers must never
 *  block a send on this. */
export const ensureChatSessionWorktree = (chatSessionId: string) =>
  safeInvoke<string | null>("ensure_chat_session_worktree", { sessionId: chatSessionId });
/** "Join main working tree" (or point the chat at a specific worktree): clears
 *  the pointer and best-effort removes the previous on-disk worktree. */
export const setChatSessionWorktree = (chatSessionId: string, worktreePath?: string | null) =>
  safeInvoke<void>("set_chat_session_worktree", { sessionId: chatSessionId, worktreePath: worktreePath ?? null });
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

/** Enter or exit plan mode for a chat session (the "Plan" posture in the
 *  mode menu). Persists the label on the session row and syncs the live
 *  gate; exiting restores the posture the session had before planning. */
export const setChatSessionPlanMode = (chatSessionId: string, active: boolean) =>
  safeInvoke<void>("set_chat_session_plan_mode", { chatSessionId, active });

/** Set a HARNESS session's native permission mode (the harness's own
 *  postures — OpenCode build/plan, Claude Code default/acceptEdits/plan/
 *  bypassPermissions). The harness spawn maps it to CLI flags per turn. */
export const setChatSessionPermissionMode = (chatSessionId: string, mode: string) =>
  safeInvoke<void>("set_chat_session_permission_mode", { chatSessionId, mode });
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
  // Composer attachments, same payload the built-in chat takes. Display
  // markers/extracted text are folded into the persisted message; image/doc
  // bytes are saved to disk paths the CLI's own file tools can open.
  attachments?: ChatAttachmentInput[],
) =>
  safeInvoke<void>("send_agent_chat_message", {
    chatSessionId,
    content,
    harnessId,
    model: model ?? null,
    cwd: cwd ?? null,
    projectId: projectId ?? null,
    attachments: attachments ?? null,
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

/** Per-model llama-server runtime overrides (LM Studio-style tweaks),
 *  persisted as JSON under the `localModels.overrides` app setting keyed by
 *  model id. `undefined` everywhere = auto. `lastGoodNgl` is recorded by the
 *  backend after each successful start ("cached ngl" — restarts skip the
 *  GPU probe ladder). */
export interface LlamaOverrides {
  ngl?: number;
  ctx?: number;
  flashAttn?: boolean;
  /** "f16" | "q8_0" | "q4_0" — K cache; V follows when flashAttn is on. */
  kvCache?: string;
  threads?: number;
  batch?: number;
  ubatch?: number;
  parallel?: number;
  noMmap?: boolean;
  seed?: number;
  temp?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  /** Free-form extra llama-server args, whitespace-split. Escape hatch. */
  extraArgs?: string;
  lastGoodNgl?: number;
}

/** Read/write the whole persisted overrides map (`localModels.overrides`). */
export const getLocalModelOverrides = () =>
  safeInvoke<string | null>("get_setting", { key: "localModels.overrides" });
export const setLocalModelOverrides = (blob: string) =>
  safeInvoke<void>("set_setting", { key: "localModels.overrides", value: blob });

export const startLocalModel = (
  modelId: string,
  path: string,
  mmprojPath?: string | null,
  overrides?: LlamaOverrides | null,
) =>
  safeInvoke<StartedModel | null>("start_local_model", {
    modelId,
    path,
    mmprojPath: mmprojPath ?? null,
    overrides: overrides ?? null,
  });
/**
 * Warm the local model's prompt cache with the exact system+tools prefix the
 * next send will render. Pass the SAME workingDir resolution sendMessage
 * uses (cwdOverride → worktree → bound project). Resolves when the warmup
 * completes (≤90s) — the caller keeps its loading state up until then so
 * "loaded" means the first message answers immediately. Best-effort: errors
 * mean the first message pays the normal cold-start eval.
 */
export const warmupLocalPrompt = (
  workingDir?: string | null,
  chatSessionId?: string | null,
  toolsEnabled?: boolean,
  codeExecEnabled?: boolean,
) =>
  safeInvoke<void>("warmup_local_prompt", {
    workingDir: workingDir ?? null,
    chatSessionId: chatSessionId ?? null,
    toolsEnabled: toolsEnabled ?? null,
    codeExecEnabled: codeExecEnabled ?? null,
  });

export const stopLocalModel = (modelId: string) =>
  safeInvoke<void>("stop_local_model", { modelId });

export const localModelStatus = () =>
  safeInvoke<ActiveLocalModel | null>("local_model_status");

/** Get the user-configured llama-server path (if any). Written by the
 *  "One-click path setup" button in the Local Models settings panel. */
export const getLlamaServerPath = () =>
  safeInvoke<{ path: string | null }>("get_llama_server_path", {});

/** Set the user-configured llama-server path. Returns success with the
 *  new path, or an error if the path is invalid (binary not found). */
export const setLlamaServerPath = (path: string) =>
  safeInvoke<void>("set_llama_server_path", { path });

/** Detect common llama-server installation paths. Returns the detected
 *  path or `null` if none found. Used by "one-click path setup". */
export const detectLlamaServerPath = () =>
  safeInvoke<{ path: string | null }>("detect_llama_server_path", {});

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

/** Force a compaction pass for the session ("Compact now" in the context
 *  meter). Cloud sessions summarize via their own provider; local sessions
 *  via the running sidecar. Returns a short human-facing result line. */
export const compactNow = (chatSessionId: string) =>
  safeInvoke<string>("chat_compact_now", { chatSessionId });

/** Context recovery: the raw turns a `[compacted context]` summary row
 *  folded away. They stay in the DB forever — the summary is lossy, the
 *  rows are the restorable source. Empty when the summary id doesn't belong
 *  to the session. */
export const listCompactedMessages = (chatSessionId: string, summaryId: number) =>
  safeInvoke<ChatMessageRecord[]>("list_compacted_messages", {
    chatSessionId,
    summaryId,
  });

/** Live per-model context windows from a provider's own models API (the
 *  backend holds the API key and caches for 24h). Anthropic publishes
 *  `context_window` per model id; providers without a keyed models API
 *  return an empty map (the static registry fallback stands). */
export const fetchProviderModelWindows = (provider: string) =>
  safeInvoke<Record<string, number>>("fetch_provider_model_windows", { provider });

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
/** `open_file` routed a previewable local file to the in-app tool-panel
 *  preview instead of the OS handler. */
export const listenChatOpenPreview = (handler: (payload: ChatOpenPreviewPayload) => void) =>
  safeListen<ChatOpenPreviewPayload>("chat:open-preview", handler);

export const listenChatTaskProgress = (handler: (payload: ChatTaskProgressPayload) => void) =>
  safeListen<ChatTaskProgressPayload>("chat:task-progress", handler);

export const listenChatApprovalRequest = (handler: (payload: ChatApprovalRequestPayload) => void) =>
  safeListen<ChatApprovalRequestPayload>("chat:approval-request", handler);
export const listenChatApprovalResolved = (handler: (payload: ChatApprovalResolvedPayload) => void) =>
  safeListen<ChatApprovalResolvedPayload>("chat:approval-resolved", handler);

// ---- Harness questions (Claude Code AskUserQuestion over the control protocol) ----

/** One question from a harness `AskUserQuestion` tool call. */
export interface ChatQuestionInput {
  question: string;
  /** Short label shown as a chip (the CLI caps it at 12 chars). */
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** Emitted when a harness asks the user a question mid-turn; the turn is
 *  PAUSED until resolveAgentQuestion answers (or the turn is cancelled →
 *  skipped). */
export interface ChatQuestionRequestPayload {
  chatSessionId: string;
  pendingId: string;
  questions: ChatQuestionInput[];
}

export const listenChatQuestionRequest = (handler: (payload: ChatQuestionRequestPayload) => void) =>
  safeListen<ChatQuestionRequestPayload>("chat:question-request", handler);

/** The model id the session's harness LAST actually ran (claude
 *  message.model / opencode info.modelID) — custom/remapped harness setups
 *  make the session's stored catalog id a lie. Null for built-in/local
 *  sessions or before the first harness turn completes. */
export const getAgentActualModel = (chatSessionId: string) =>
  safeInvoke<string | null>("get_agent_actual_model", { chatSessionId });

/** Answer a pending harness question. `answers` maps question text → chosen
 *  option label (string, or an array for multiSelect); `response` is an
 *  optional free-text reply that replaces the structured answers entirely. */
export const resolveAgentQuestion = (
  chatSessionId: string,
  pendingId: string,
  answers: Record<string, string | string[]>,
  response?: string,
) =>
  safeInvoke<void>("resolve_agent_question", {
    chatSessionId,
    pendingId,
    answers,
    response: response ?? null,
  });

export const listenPlanStepProgress = (handler: (payload: PlanStepProgressPayload) => void) =>
  safeListen<PlanStepProgressPayload>("chat:plan-step-progress", handler);

// ---- Structured plan tracking ----

export const listenPlanUpdated = (handler: (payload: ChatPlanUpdatedPayload) => void) =>
  safeListen<ChatPlanUpdatedPayload>("chat:plan-updated", handler);
export const listenPlanMode = (handler: (payload: ChatPlanModePayload) => void) =>
  safeListen<ChatPlanModePayload>("chat:plan-mode", handler);
export const listenPlanProposal = (handler: (payload: ChatPlanProposalPayload) => void) =>
  safeListen<ChatPlanProposalPayload>("chat:plan-proposal", handler);
export const listenPlanAccepted = (handler: (payload: ChatPlanAcceptedPayload) => void) =>
  safeListen<ChatPlanAcceptedPayload>("chat:plan-accepted", handler);

/** Resolve a `present_plan` proposal card. `approved` seeds the todo list,
 *  unlocks mutations and exits plan mode; `false` returns `feedback` to the
 *  model so it revises the plan. */
export const resolvePlanProposal = (pendingId: string, approved: boolean, feedback?: string) =>
  safeInvoke<void>("resolve_plan_proposal", {
    pendingId,
    approved,
    feedback: feedback ?? null,
  });

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

/** "Accurate view" for Office previews: LibreOffice-converted PDF of the
 *  ORIGINAL file (true pagination, fonts, charts), as a data URI. Null when
 *  LibreOffice is unavailable or the conversion failed — the caller keeps the
 *  fast preview. Cached backend-side by (path, size, mtime). */
export const officeAccuratePdf = (path: string) =>
  safeInvoke<string | null>("office_accurate_pdf", { path });

/** Resolve one JavaScript document-generation run (see DocCodeRunner): the
 *  produced file as base64, or an error message. */
export const docgenComplete = (args: {
  requestId: string;
  base64?: string;
  error?: string;
}) => safeInvoke<null>("docgen_complete", args);

/** Last-modified time of a file (seconds since epoch), or null when the file
 *  doesn't exist. Artifact preview panes poll this to hot-reload when the
 *  model edits an open artifact file. */
export const getFileMtime = (path: string) =>
  safeInvoke<number | null>("get_file_mtime", { path });

/** Search `dir` (bounded breadth-first) for a file with this basename.
 *  Returns the shallowest match or null — recovers a preview target when a
 *  recorded change path no longer exists on disk. */
export const findFileByBasename = (dir: string, basename: string) =>
  safeInvoke<string | null>("find_file_by_basename", { dir, basename });

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
    filters: [{ name: "Relay backup", extensions: ["zip"] }],
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
    filters: [{ name: "Relay backup", extensions: ["zip"] }],
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
    filters: [{ name: "Relay backup", extensions: ["zip"] }],
    title: "Select a Relay backup (.zip) to restore",
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
/** Attach-on-demand: append/remove ONE attachment (@-picker click / chip ×). */
export const addSessionConnector = (chatSessionId: string, connectorId: string) =>
  safeInvoke<void>("add_session_connector", { chatSessionId, connectorId });
export const removeSessionConnector = (chatSessionId: string, connectorId: string) =>
  safeInvoke<void>("remove_session_connector", { chatSessionId, connectorId });
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

// ---- Mobile pairing + Tailscale remote access ----

export interface TailscaleStatus {
  installed: boolean;
  loggedIn: boolean;
  dnsName: string | null;
  /** The machine's Tailscale IP (CGNAT range). Used for direct tailnet
   *  WebSocket connections without needing HTTPS serve enabled on the tailnet. */
  tailscaleIp: string | null;
  backendState: string;
}

export interface MobilePairingInfo {
  running: boolean;
  port: number;
  token: string | null;
  /** ws://127.0.0.1:<port> — for USB-bridge / same-machine connections. */
  localUrl: string | null;
  tailscale: TailscaleStatus;
  /** wss://<machine>.<tailnet>.ts.net — requires HTTPS serve enabled on tailnet. */
  tailscaleUrl: string | null;
  /** ws://<tailscale-ip>:<port> — direct tailnet connection, no HTTPS serve needed. */
  tailnetUrl: string | null;
}

export const getMobilePairingInfo = () =>
  safeInvoke<MobilePairingInfo | null>("get_mobile_pairing_info");

export const tailscaleServeEnable = () =>
  safeInvoke<string | null>("tailscale_serve_enable");

export const tailscaleServeDisable = () =>
  safeInvoke<void>("tailscale_serve_disable");

/** Trigger `tailscale up` in the background (opens browser for login). */
export const tailscaleLogin = () =>
  safeInvoke<void>("tailscale_login");


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
  /** True when huggingface.co was unreachable and a cached copy (any age)
   *  was served — the UI shows an offline hint instead of an error. */
  stale?: boolean;
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

/** Real per-file GGUF sizes for one repo (filename → bytes), from HF's tree
 *  endpoint. The catalog listing API doesn't expose sibling sizes, so entries
 *  there carry estimates; this corrects them for single-repo views. */
export const fetchModelFileSizes = (repoId: string) =>
  safeInvoke<Record<string, number>>("fetch_model_file_sizes", { repoId });

/** GPU VRAM info for the model-market size gate. Null when no discrete GPU. */
export interface GpuVramInfo {
  totalVramBytes: number | null;
  deviceName: string | null;
}

export const getGpuVram = () => safeInvoke<GpuVramInfo | null>("get_gpu_vram");

/** Auto-detect GPU + estimate power draw for the electricity cost calculator. */
export interface GpuPowerDetection {
  deviceName: string | null;
  totalVramBytes: number | null;
  estimatedWatts: number | null;
}
export const detectGpuPower = () =>
  safeInvoke<GpuPowerDetection | null>("detect_gpu_power");

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

// ── Per-chat document attachment (§3.1.7) ────────────────────────────────
// Pin a corpus to a chat session so its chunks are ALWAYS in that chat's
// auto-retrieval context, regardless of the query.
export const docsAttachCorpusToChat = (chatSessionId: string, corpusId: string) =>
  safeInvoke<void>("docs_attach_corpus_to_chat", { chatSessionId, corpusId });

export const docsDetachCorpusFromChat = (chatSessionId: string, corpusId: string) =>
  safeInvoke<void>("docs_detach_corpus_from_chat", { chatSessionId, corpusId });

export const docsAttachedCorpusIds = (chatSessionId: string) =>
  safeInvoke<string[] | null>("docs_attached_corpus_ids", { chatSessionId });

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

// ---- MCP server gallery (§3.2.14) ----
// User-installable stdio MCP servers whose tools join every tool-enabled
// chat turn under prefixed names (`mcp_<server>_<tool>`). Mirrors the Rust
// types in src-tauri/src/mcp_gallery.rs (serde camelCase).

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  envKeys: string[];
}

export interface McpServerDef {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  fromGallery: boolean;
}

export interface McpGalleryList {
  catalog: McpCatalogEntry[];
  installed: McpServerDef[];
}

export interface McpToolView {
  wireName: string;
  rawName: string;
  description?: string | null;
  /** "read" | "write" — same classification as connector tools. */
  kind: string;
}

export interface McpConnectResult {
  serverId: string;
  tools: McpToolView[];
}

export const mcpGalleryList = () =>
  safeInvoke<McpGalleryList | null>("mcp_gallery_list");

export const mcpGalleryInstall = (catalogId?: string, custom?: Partial<McpServerDef>) =>
  safeInvoke<McpServerDef | null>("mcp_gallery_install", { catalogId, custom });

export const mcpGalleryRemove = (id: string) =>
  safeInvoke<null>("mcp_gallery_remove", { id });

export const mcpGallerySetEnabled = (id: string, enabled: boolean) =>
  safeInvoke<null>("mcp_gallery_set_enabled", { id, enabled });

export const mcpGalleryConnect = (id: string) =>
  safeInvoke<McpConnectResult | null>("mcp_gallery_connect", { id });

export const mcpGalleryDisconnect = (id: string) =>
  safeInvoke<null>("mcp_gallery_disconnect", { id });

