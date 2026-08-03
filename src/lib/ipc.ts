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
import type {
  AvailableSkill,
  ChangedFile,
  CostEvent,
  CostRollups,
  GitStatusInfo,
  HarnessId,
  HarnessStatus,
  InstalledSkill,
  Project,
  QuickAction,
  SessionRecord,
  Skill,
} from "../types";

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

// --- Harnesses ---
export const listHarnesses = () => safeInvoke<HarnessStatus[] | null>("list_harnesses");
export const runHarnessLogin = (paneId: string, harnessId: HarnessId, cwd: string) =>
  safeInvoke<void>("run_harness_login", { paneId, harnessId, cwd });

// --- Git ---
export const getGitStatus = (path: string) => safeInvoke<GitStatusInfo | null>("get_git_status", { path });
export const createWorktree = (projectId: string, branchName: string) =>
  safeInvoke<string | null>("create_worktree", { projectId, branchName });
export const getGitDiff = (path: string) => safeInvoke<string | null>("get_git_diff", { path });
/** Per-file diff for the Dev-tab side panel. Returns the unified diff for a
 *  single file in the working tree (or an empty string when the file has no
 *  changes / isn't a git repo). Used when the user clicks a file row in the
 *  right-side Files panel — we want THAT file's diff, not the whole tree. */
export const getGitFileDiff = (path: string, filePath: string) =>
  safeInvoke<string | null>("get_git_file_diff", { path, filePath });
/** Per-pane change list for the Dev-tab side panel. The argument is the
 *  pane's actual working directory (project root or worktree path), not the
 *  project root alone — worktree-scoped sessions (PRD §7.10) must see the
 *  worktree's own diff, not the parent repo's. */
export const getChangedFiles = (path: string) =>
  safeInvoke<ChangedFile[] | null>("get_changed_files", { path });

// --- Settings / skills / quick actions / secrets / cost ---
export const getSetting = (key: string) => safeInvoke<string | null>("get_setting", { key });
export const setSetting = (key: string, value: string) => safeInvoke<void>("set_setting", { key, value });
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
  safeInvoke<CostEvent[] | null>("get_cost_events", sessionId ? { sessionId } : {});
export const getCostRollups = () => safeInvoke<CostRollups | null>("get_cost_rollups");
export const exportSessionMarkdown = (paneId: string) =>
  safeInvoke<string | null>("export_session_markdown", { paneId });
export const readFileText = (path: string) => safeInvoke<string | null>("read_file_text", { path });

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
  /** Per-session filesystem permission posture
   *  (`read_only` | `manual` | `auto_edit` | `full_auto`). New sessions
   *  start at `manual`. See chat::permission::PermissionMode. */
  permissionMode?: string;
  /** Per-session watch-mode pacing override. null = inherit global setting;
   *  "on" | "off" = per-session override. */
  watchMode?: string | null;
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

/** A pending per-action filesystem-tool approval surfaced as a card.
 *  Emitted when the central `check_permission` gate returns NeedsApproval.
 *  The user's choice is sent back via `resolveToolAction`. */
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

/** All persisted artifacts, most recent first. */
export const listArtifacts = () => safeInvoke<ArtifactRecord[]>("list_artifacts", {});

/** Artifacts for one chat session (oldest first) so a reopened chat restores them. */
export const listChatArtifacts = (chatSessionId: string) =>
  safeInvoke<ArtifactRecord[]>("list_chat_artifacts", { chatSessionId });

/** Delete an artifact (row + on-disk file). */
export const deleteArtifact = (id: string) =>
  safeInvoke<void>("delete_artifact", { id });

/** Delete a single chat message (user or assistant) by id. No-op on the
 *  backend for unknown ids; the optimistic just-sent message (negative id)
 *  simply doesn't match anything server-side. The UI removes the bubble
 *  from local state regardless. */
export const deleteChatMessage = (messageId: number) =>
  safeInvoke<void>("delete_chat_message", { messageId });

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
    | "image"
    | "pdf"
    | "office"
    | "binary";
  text: string | null;
  dataUri: string | null;
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
export const createChatSession = (provider: string, model: string) =>
  safeInvoke<ChatSession | null>("create_chat_session", { provider, model });
export const deleteChatSession = (chatSessionId: string) =>
  safeInvoke<void>("delete_chat_session", { chatSessionId });
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
export const getChatMessages = (chatSessionId: string) =>
  safeInvoke<ChatMessageRecord[] | null>("get_chat_messages", { chatSessionId });
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
  });
export const updateChatSessionModel = (chatSessionId: string, model: string) =>
  safeInvoke<void>("update_chat_session_model", { chatSessionId, model });

/** Switch a chat session's provider (e.g. to/from "local_gguf" when picking a
 *  local model from the selector in a cloud session, or vice versa). */
export const updateChatSessionProvider = (chatSessionId: string, provider: string) =>
  safeInvoke<void>("update_chat_session_provider", { chatSessionId, provider });
/** Update a chat session's filesystem permission posture
 *  (`read_only` | `manual` | `auto_edit` | `full_auto`). Per-session; new
 *  sessions start at `manual`. The frontend gates the switch to `full_auto`
 *  behind a one-time confirmation modal before calling this. */
export const updateChatSessionPermissionMode = (
  chatSessionId: string,
  mode: "read_only" | "manual" | "auto_edit" | "full_auto",
) =>
  safeInvoke<void>("update_chat_session_permission_mode", { chatSessionId, mode });
/** Update a chat session's watch-mode pacing override. null clears the
 *  override so the session inherits the global setting; "on" | "off" set
 *  a per-session override. */
export const updateChatSessionWatchMode = (
  chatSessionId: string,
  mode: "on" | "off" | null,
) =>
  safeInvoke<void>("update_chat_session_watch_mode", { chatSessionId, mode });
export const cancelChatMessage = (chatSessionId: string) =>
  safeInvoke<void>("cancel_chat_message", { chatSessionId });
/** Resolve a pending per-action tool approval card. `approved` lets the paused
 *  tool loop run the action; `false` injects a "user denied" tool result. */
export const resolveToolAction = (pendingId: string, approved: boolean) =>
  safeInvoke<void>("resolve_tool_action", { pendingId, approved });
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

export const listenChatToken = (handler: (payload: ChatTokenPayload) => void) =>
  safeListen<ChatTokenPayload>("chat:token", handler);
export const listenChatStatus = (handler: (payload: ChatStatusPayload) => void) =>
  safeListen<ChatStatusPayload>("chat:status", handler);
export const listenChatDone = (handler: (payload: ChatDonePayload) => void) =>
  safeListen<ChatDonePayload>("chat:done", handler);
export const listenChatError = (handler: (payload: ChatErrorPayload) => void) =>
  safeListen<ChatErrorPayload>("chat:error", handler);
export const listenChatArtifact = (handler: (payload: ChatArtifactPayload) => void) =>
  safeListen<ChatArtifactPayload>("chat:artifact", handler);
export const listenChatOpenBrowser = (handler: (payload: ChatOpenBrowserPayload) => void) =>
  safeListen<ChatOpenBrowserPayload>("chat:open-browser", handler);
export const listenChatApprovalRequest = (handler: (payload: ChatApprovalRequestPayload) => void) =>
  safeListen<ChatApprovalRequestPayload>("chat:approval-request", handler);
export const listenChatApprovalResolved = (handler: (payload: ChatApprovalResolvedPayload) => void) =>
  safeListen<ChatApprovalResolvedPayload>("chat:approval-resolved", handler);

export const listenChatTaskProgress = (handler: (payload: ChatTaskProgressPayload) => void) =>
  safeListen<ChatTaskProgressPayload>("chat:task-progress", handler);

/** Re-broadcast a chat event to the mobile relay. Used from useChatEvents.ts to
 *  forward chat:token, chat:status, chat:done, chat:error, chat:approval-request,
 *  and chat:artifact events to the per-session mobile connection. */
export const emitMobileSessionChatEvent = (
  sessionId: string,
  kind: string,
  payload: Record<string, unknown>,
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

export type ModelSort = "downloads" | "likes" | "modified";

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

