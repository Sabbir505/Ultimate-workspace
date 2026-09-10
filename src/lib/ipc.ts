// Thin wrappers around the Tauri IPC contract (CONTRACT.md). Command names and
// payload shapes here are binding — do not "improve" them without updating the
// contract and the Rust backend in lockstep. Domain modules live in
// src/lib/ipc/*.ts and are re-exported here; the transport core is
// src/lib/ipcCore.ts.

import type {
  AcpAgentStatus,
  ChangedFile,
  GitStatusInfo,
  HarnessId,
  HarnessStatus,
  HarnessUpdateStatus,
  Project,
  SessionRecord,
} from "../types";
import { safeInvoke, safeListen } from "./ipcCore";

export type {
  ChangedFile,
  DocCorpus,
  DocsEmbeddingStatus,
  DocsIndexProgressPayload,
} from "../types";

export {
  tauriRuntimeAvailable,
  safeInvoke,
  safeListen,
  toastError,
  toastInfo,
  toastSuccess,
} from "./ipcCore";

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
  // Fire-and-forget by design (the pty may already be dead) — swallow
  // rejections so a failed write never becomes an unhandled rejection (A6).
  void writePty(paneId, text).catch(() => {});
  window.setTimeout(() => void writePty(paneId, "\r").catch(() => {}), 250);
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
export const browserCreateTab = (
  paneId: string,
  tabId: string,
  url: string,
  rect: BrowserRect,
  projectId?: string | null,
) =>
  safeInvoke<void>("browser_create", { paneId, tabId, url, rect, projectId: projectId ?? null });
/** Clear the current site's session (page-visible cookies + storage) and
 *  reload — the trust strip's "clear this site" escape hatch. */
export const browserClearSiteData = (paneId: string, tabId: string) =>
  safeInvoke<void>("browser_clear_site_data", { paneId, tabId });
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
/** Document title reported by the injected bridge once a page settles —
 *  drives the tab bar label + derived favicon. */
export interface BrowserTitlePayload {
  paneId: string;
  tabId: string;
  title: string;
}
export const listenBrowserTitle = (handler: (payload: BrowserTitlePayload) => void) =>
  safeListen<BrowserTitlePayload>("browser:title", handler);
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
export const browserOpenPaneResult = (reqId: number, paneId: string | null, tabId?: string | null) =>
  safeInvoke<void>("browser_open_pane_result", { reqId, paneId: paneId ?? null, tabId: tabId ?? null });
/** Answers for the tab-management roundtrips (switch/new/close): tabId echoes
 *  the affected tab, null = the operation could not be performed. */
export const browserSwitchTabResult = (reqId: number, tabId: string | null) =>
  safeInvoke<void>("browser_tab_result", { reqId, tabId });
export const browserNewTabResult = (reqId: number, tabId: string | null) =>
  safeInvoke<void>("browser_tab_result", { reqId, tabId });
export const browserCloseTabResult = (reqId: number, tabId: string | null) =>
  safeInvoke<void>("browser_tab_result", { reqId, tabId });

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

// --- Tab-management roundtrips (MCP list/switch/new/close_tab tools) ---
export interface BrowserSwitchTabRequestPayload {
  reqId: number;
  paneId: string;
  tabId: string;
}
export interface BrowserNewTabRequestPayload {
  reqId: number;
  paneId: string;
  url: string;
}
export interface BrowserCloseTabRequestPayload {
  reqId: number;
  paneId: string;
  tabId: string;
}
export const listenBrowserSwitchTabRequest = (
  handler: (payload: BrowserSwitchTabRequestPayload) => void,
) => safeListen<BrowserSwitchTabRequestPayload>("browser:switch-tab-request", handler);
export const listenBrowserNewTabRequest = (
  handler: (payload: BrowserNewTabRequestPayload) => void,
) => safeListen<BrowserNewTabRequestPayload>("browser:new-tab-request", handler);
export const listenBrowserCloseTabRequest = (
  handler: (payload: BrowserCloseTabRequestPayload) => void,
) => safeListen<BrowserCloseTabRequestPayload>("browser:close-tab-request", handler);

/** Emitted by the backend whenever the agent performs any browser action
 *  (harness MCP ops via resolve_or_open; chat-mode browser_* tools). The
 *  frontend surfaces the Browser tab so the work is visible as it happens. */
export interface BrowserActivityPayload {
  paneId: string | null;
}
export const listenBrowserActivity = (
  handler: (payload: BrowserActivityPayload) => void,
) => safeListen<BrowserActivityPayload>("browser:activity", handler);

// --- Trust layer (Phase 2): gates, takeover, pause/stop, timeline ----------
export interface BrowserConfirmRequestPayload {
  reqId: number;
  paneId: string;
  op: string;
  target: string;
  url: string;
  riskClass: string;
  reason: string;
}
export const listenBrowserConfirmRequest = (
  handler: (payload: BrowserConfirmRequestPayload) => void,
) => safeListen<BrowserConfirmRequestPayload>("browser:confirm-request", handler);
export const browserConfirmResult = (
  reqId: number,
  approved: boolean,
  alwaysForSite: boolean,
) =>
  safeInvoke<void>("browser_confirm_result", {
    reqId,
    approved,
    alwaysForSite,
  });

export interface BrowserTakeoverRequestPayload {
  paneId: string;
  reason: string;
  url: string;
  target: string;
}
export const listenBrowserTakeoverRequest = (
  handler: (payload: BrowserTakeoverRequestPayload) => void,
) => safeListen<BrowserTakeoverRequestPayload>("browser:takeover-request", handler);

export const browserSetAgentPaused = (paneId: string, paused: boolean) =>
  safeInvoke<void>("browser_set_agent_paused", { paneId, paused });
export const browserCancelAgent = (paneId: string) =>
  safeInvoke<void>("browser_cancel_agent", { paneId });
export const browserTimeline = (paneId: string) =>
  safeInvoke<
    Array<{
      tsMs: number;
      op: string;
      target: string;
      outcome: string;
      riskClass?: string;
      detail?: string;
    }>
  >("browser_timeline", { paneId });

export interface BrowserTimelineEntryPayload {
  paneId: string;
  entry: {
    tsMs: number;
    op: string;
    target: string;
    outcome: string;
    riskClass?: string;
    detail?: string;
  };
}
export const listenBrowserTimelineEntry = (
  handler: (payload: BrowserTimelineEntryPayload) => void,
) => safeListen<BrowserTimelineEntryPayload>("browser:timeline-entry", handler);

// --- Harnesses ---
/** Probe harness install status. Cached server-side for 30s unless `force` —
 *  the Settings "Re-check" button passes true so an out-of-band install or
 *  uninstall is picked up immediately. */
export const listHarnesses = (force = false) =>
safeInvoke<HarnessStatus[] | null>("list_harnesses", { force });
/** Installed-vs-registry-latest version check per harness (Settings "Update"
 *  button + boot notification). Cached server-side for 1h unless `force` —
 *  the Settings "Re-check" button and the post-install refresh pass true.
 *  One HTTP GET + one `--version` spawn per installed harness. */
export const checkHarnessUpdates = (force = false) =>
safeInvoke<HarnessUpdateStatus[] | null>("check_harness_updates", { force });
export const runHarnessLogin = (paneId: string, harnessId: HarnessId, cwd: string) =>
safeInvoke<void>("run_harness_login", { paneId, harnessId, cwd });
/** One-click global npm install of a harness CLI (Harnesses settings panel;
 *  the Update button reuses it — plain `npm install -g` always resolves the
 *  latest dist-tag). Long-running — resolves with a confirmation line or
 *  rejects with the npm stderr tail. Re-probe via listHarnesses() afterwards. */
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

export * from "./ipc/modelMarket";
export * from "./ipc/chatSessions";
export * from "./ipc/approvals";
export * from "./ipc/budget";
export * from "./ipc/voice";
export * from "./ipc/prompts";
export * from "./ipc/artifacts";
export * from "./ipc/automations";
export * from "./ipc/localModels";
export * from "./ipc/harnessChat";
export * from "./ipc/exportImport";
export * from "./ipc/updater";
export * from "./ipc/workspaces";
export * from "./ipc/marketFiles";
export * from "./ipc/github";
export * from "./ipc/rag";
export * from "./ipc/mcp";
