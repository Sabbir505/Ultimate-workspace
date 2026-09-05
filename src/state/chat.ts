// Chat store: sessions, messages, live streaming state, config, and all actions.
// Mirrors the style of src/state/projects.ts and src/state/settings.ts.
//
// IMPORTANT: all streaming updates are keyed by chatSessionId, NOT by
// "active session", so streams complete correctly even if the user switches
// to a different chat in the sidebar.
import { create } from "zustand";
import {
  cancelAgentChatMessage,
  cancelChatMessage,
  persistPartialChatMessage,
  createChatSession,
  setChatSessionProject,
  deleteChatApiKey,
  deleteAllChatSessions,
  deleteChatMessage,
  deleteChatSession,
  generateChatTitle,
  getChatConfig,
  getChatMessages,
  getChatSessionMetrics,
  listChatArtifacts,
  listChatCheckpoints,
  listChatSessions,
  readArtifactPreview,
  sendAgentChatMessage,
  sendChatMessage,
  setChatApiKey,
  setChatDefaultModel,
  setChatSessionStarred,
  setChatSessionUnread,
  supersedeChatTail,
  toastError,
  touchChatSession,
  updateChatSessionAgent,
  updateChatSessionModel,
  updateChatSessionProvider,
  updateChatSessionTitle,
  updateChatSessionPolicies,
  updateChatSessionWatchMode,
  resolveToolAction,
  resolvePlanProposal,
  resolveAgentQuestion,
  setChatSessionPlanMode,
  setChatSessionPermissionMode,
  type ChatPlanAcceptedPayload,
  type ChatPlanRecord,
  ensureChatSessionWorktree,
  setChatSessionWorktree,
  getSetting,
  type ChatApprovalRequestPayload,
  type ChatApprovalResolvedPayload,
  type ChatAttachmentInput,
  type ChatArtifactPayload,
  type ChatCitationReportPayload,
  type ChatCheckpoint,
  type ChatConfigPayload,
  type ChatMessageRecord,
  type ChatPerfPayload,
  type ChatPlanModePayload,
  type ChatPlanProposalPayload,
  type ChatPlanUpdatedPayload,
  type ChatQuestionInput,
  type ChatQuestionRequestPayload,
  type ChatSession,
  type ChatSessionMetricsPayload,
  type ChatTaskProgressPayload,
  type PlanTodo,
  type SubagentInfo,
  type SubagentSpawnPayload,
  type SubagentTokenPayload,
  type SubagentDonePayload,
  finishArtifactRuns,
  loopSessionAdvance,
  loopSessionFinish,
  loopSessionStart,
} from "../lib/ipc";
export type { ArtifactProposal, PlanTodo } from "../lib/ipc";
import type { ArtifactProposal } from "../lib/ipc";
import { generateSessionTitle } from "../lib/sessionTitle";
import { tailCodePoints } from "../lib/safeSlice";
import { openArtifactInBrowserPane } from "../lib/sessionLauncher";
import { useArtifactsStore } from "./artifacts";
import { useProjectsStore } from "./projects";
import { useUiStore } from "./ui";

/** Sessions the user manually renamed — never auto-summarize their title.
 *  Capped at 1000 entries to prevent unbounded growth across long sessions.
 *  Uses a Map (insertion-ordered) so the OLDEST entry is evicted when the cap
 *  is hit — protecting the most-recently-touched sessions from premature
 *  eviction that would re-enable auto-titling for a freshly renamed chat. */
const manuallyRenamed = new Map<string, number>();

/** Sessions deleted during this app run. Background session-list refreshes
 *  (`selectSession`'s touch-then-relist, `onDone`'s relist) fetch the list
 *  over IPC and can race the user's delete: the fetch starts before the
 *  DELETE commits but its payload is applied after — resurrecting the deleted
 *  chat in the sidebar. Every refresh path filters this tombstone set so a
 *  stale payload can never bring a deleted session back.
 *  Capped at 1000 entries to prevent unbounded growth. Using a Map (rather
 *  than a Set) lets us cap by insertion order so a recently-tombstoned
 *  session is never silently dropped from the filter (which would let the
 *  very race condition this set exists to prevent happen again). */
const deletedSessions = new Map<string, number>();

/** True for sessions whose sends route to the headless CLI chat path
 *  (agent_sessions.rs): harness adapters ("harness:<id>") AND ACP agents
 *  ("acp:<id>", roadmap #20). Both kinds use sendAgentChatMessage +
 *  cancelAgentChatMessage and stream the same chat:* events back. Type
 *  predicate so callers get `agent` narrowed to a plain string. */
function isCliAgent(agent: string | null | undefined): agent is string {
  return !!agent && (agent.startsWith("harness:") || agent.startsWith("acp:"));
}

/** Extract the adapter/agent id from a "harness:<id>" / "acp:<id>" value. */
function cliAgentId(agent: string): string {
  return agent.startsWith("acp:") ? agent.slice("acp:".length) : agent.slice("harness:".length);
}

/** Worktree-per-session default (roadmap P0 §3.1.1): give a fresh chat on a
 *  git project its own isolated worktree, and patch the session row when the
 *  path resolves. Fires-and-forgets by design — the send path falls back to
 *  the project root until (or unless) the worktree exists, so this must NEVER
 *  block session creation or a send. Skipped when the chat is unbound, already
 *  isolated, the project isn't a git repo, or the global default is off. */
async function maybeEnsureWorktree(session: ChatSession | null | undefined): Promise<void> {
  if (!session?.id || !session.projectId || session.worktreePath) return;
  const enabled = (await getSetting("worktrees.defaultEnabled").catch(() => null)) !== "false";
  if (!enabled) return;
  const project = useProjectsStore.getState().projectById(session.projectId);
  if (!project?.isGitRepo) return;
  try {
    const path = await ensureChatSessionWorktree(session.id);
    if (path) {
      useChatStore.setState((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === session.id ? { ...sess, worktreePath: path } : sess,
        ),
      }));
    }
  } catch {
    // Best-effort: the chat works in the project root instead.
  }
}

/** Session list with tombstoned (deleted-this-run) sessions removed. */
function withoutDeleted(sessions: ChatSession[]): ChatSession[] {
  return sessions.filter((s) => !deletedSessions.has(s.id));
}

/**
 * Merge a fresh DB page with the buffer's still-optimistic rows (negative
 * ids = sent but not yet seen in any refetch). A refetch snapshot taken
 * BEFORE the backend persisted an in-flight send would otherwise silently
 * drop that send's bubble: the queue drain appends the optimistic bubble
 * and an older handler's refetch (cancelStream, onDone of the previous
 * turn) then replaces the list with rows that predate the persist — the
 * user sees the assistant reply to a message that never appeared. An
 * optimistic row is kept only when no fetched row carries the same
 * role+content (its just-persisted twin), so the finished turn's bubble is
 * never duplicated.
 *
 * The twin test compares the text BEFORE any attachment block, not the full
 * content: the optimistic note for docs is `[Attached file: NAME]`, while
 * the backend persists `Attached file: NAME` + a fenced block with the
 * EXTRACTED body — text we cannot reproduce client-side. Exact matching
 * stranded the optimistic row next to its persisted twin, so every
 * doc/text send showed the same message twice once the turn's refetch
 * landed (the stale optimistic row is re-appended after the fetched
 * history — user card, assistant turn, user card again).
 */
function attachmentBaseText(content: string): string {
  const idx = content.search(/\n\n\[?Attached (?:image|file) ?/);
  return idx === -1 ? content : content.slice(0, idx);
}

export function mergeOptimistic(
  current: ChatMessageRecord[],
  fetched: ChatMessageRecord[],
): ChatMessageRecord[] {
  const optimistic = current.filter((m) => m.id < 0);
  if (optimistic.length === 0) return fetched;
  const key = (m: ChatMessageRecord) => `${m.role}\u0000${attachmentBaseText(m.content)}`;
  const fetchedKeys = new Set(fetched.map(key));
  const missing = optimistic.filter((o) => !fetchedKeys.has(key(o)));
  return missing.length > 0 ? [...fetched, ...missing] : fetched;
}

/** Cap a Map to `max` entries by evicting oldest (insertion-order) entries.
 *  The map's iteration order is insertion order, so the first key seen is
 *  the oldest — which is the one we drop. This protects the most-recently
 *  added entries from being silently lost. */
function capMap<K>(map: Map<K, number>, max: number) {
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}
const SET_CAP = 1000;

function markDeleted(sid: string) {
  deletedSessions.set(sid, Date.now());
  capMap(deletedSessions, SET_CAP);
}

function markManuallyRenamed(sid: string) {
  manuallyRenamed.set(sid, Date.now());
  capMap(manuallyRenamed, SET_CAP);
}

/** Sessions in which the user has already confirmed the full_access approval
 *  modal this app run — the one-time confirmation isn't re-shown per session.
 *  (The policy itself persists in the DB; this set only suppresses
 *  re-prompting.) */
const fullAccessConfirmed = new Set<string>();

/** Extensions that auto-open a tool-panel tab when the agent produces them.
 *  Deliberately ONLY finished, viewable deliverables (a diagram PNG, a PDF
 *  report, an office doc). Everything else — html/tsx/jsx/css/json/… source
 *  files the agent writes — lands in the Artifacts gallery WITHOUT popping a
 *  tab: coding sessions used to open a pane per file write, which was noisy.
 *  The agent shows those deliberately via the `open_file` tool, and svg
 *  renders inline in the bubble (handled separately in onArtifact). */
const AUTO_OPEN_ARTIFACT_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "csv",
]);

function markFullAccessConfirmed(sid: string) {
  fullAccessConfirmed.add(sid);
  if (fullAccessConfirmed.size > SET_CAP) {
    fullAccessConfirmed.delete(fullAccessConfirmed.values().next().value as string);
  }
}

/** Derive the legacy PermissionMode string from the dual policies — used only
 *  to keep `permissionMode` in sync on the client for components still reading
 *  the old field. The backend derives the same value when persisting. */
export const policiesToPermissionMode = (
  sandbox: SandboxPolicy,
  approval: ApprovalPolicy,
): PermissionMode => {
  if (sandbox === "read_only") return "read_only";
  switch (approval) {
    case "on_request":
      return "manual";
    case "auto_edit":
      return "auto_edit";
    case "full_access":
      return "full_auto";
    default:
      return "manual";
  }
};

/** Watch-mode pacing for browser actions. "on" | "off". */
export type WatchMode = "on" | "off";

/** Per-session sandbox scope. "read_only" hides all mutating tools. */
export type SandboxPolicy = "read_only" | "workspace_write";

/** Per-session approval posture. "on_request" gates every mutating tool; "auto_edit"
 *  auto-runs writes/edits but gates deletes/moves/copies; "full_access" bypasses
 *  prompts entirely. */
export type ApprovalPolicy = "on_request" | "auto_edit" | "full_access";

/** Compatibility mapping from legacy permissionMode to dual policies (used by
 *  db migration and by UI elements that still show the legacy mode name). */
export const permissionModeToPolicies = (
  mode: "read_only" | "manual" | "auto_edit" | "full_auto"
): { sandbox: SandboxPolicy; approval: ApprovalPolicy } => {
  switch (mode) {
    case "read_only":
      return { sandbox: "read_only", approval: "on_request" };
    case "manual":
      return { sandbox: "workspace_write", approval: "on_request" };
    case "auto_edit":
      return { sandbox: "workspace_write", approval: "auto_edit" };
    case "full_auto":
      return { sandbox: "workspace_write", approval: "full_access" };
    default:
      return { sandbox: "workspace_write", approval: "on_request" };
  }
};

/** Tool permission mode for chat sessions. "plan" is the plan-mode posture:
 *  the model must propose a plan via `present_plan` and the user approves
 *  before any mutation; the session's real policies are preserved underneath
 *  and resume when the plan is approved (or the mode is switched off). */
export type PermissionMode = "read_only" | "plan" | "manual" | "auto_edit" | "full_auto";

/** A CLI harness's OWN permission postures. Harness sessions show these in
 *  the mode menu instead of the built-in ones — no mapping, the harness's
 *  native contract is what the user sees (and what the spawn passes to the
 *  CLI, e.g. `claude --permission-mode plan` / `opencode run --mode plan`). */
export interface HarnessModeOption {
  value: string;
  label: string;
  description: string;
}

export const HARNESS_PERMISSION_MODES: Record<string, HarnessModeOption[] | undefined> = {
  claude_code: [
    {
      value: "default",
      label: "Default",
      description: "Claude asks before each mutating action.",
    },
    {
      value: "acceptEdits",
      label: "Accept Edits",
      description: "File edits auto-run; other actions still ask.",
    },
    {
      value: "plan",
      label: "Plan",
      description: "Claude's read-only planning mode — no changes until switched out.",
    },
    {
      value: "bypassPermissions",
      label: "Bypass",
      description: "Claude runs everything without asking.",
    },
  ],
  opencode: [
    {
      value: "build",
      label: "Build",
      description: "Full agent — reads and writes.",
    },
    {
      value: "plan",
      label: "Plan",
      description: "OpenCode's read-only planning mode — no changes.",
    },
  ],
  kimi_code: [
    {
      value: "default",
      label: "Default",
      description: "Kimi works normally (prompt mode auto-approves tool calls).",
    },
    {
      value: "plan",
      label: "Plan",
      description: "Kimi researches and replies with a plan — no file changes.",
    },
  ],
};


/** A pending tool-approval card, one per chat session (the tool loop — or
 *  the Claude Code can_use_tool control request — pauses until it resolves). */
export interface PendingApproval {
  pendingId: string;
  tool: string;
  summary: string;
  args: unknown;
}

/** A pending `present_plan` proposal — the plan-approval card. One per chat
 *  session; the turn pauses until the user approves or rejects with feedback.
 *  The plan is the APPROACH DOCUMENT (markdown) — steps come after approval
 *  via the model's todo_write calls. */
export interface PendingPlanProposal {
  pendingId: string;
  title: string;
  plan: string;
}

/** A pending harness question (Claude Code AskUserQuestion). One per chat
 *  session; the harness turn pauses until the user answers or skips. */
export interface PendingQuestion {
  pendingId: string;
  questions: ChatQuestionInput[];
}

/** Live progress of a background chat task (download_file / run_shell),
 *  keyed by task id within a chat session. Updated by `chat:task-progress`
 *  events; the card UI renders the latest snapshot. */
export interface ChatTaskProgress {
  taskId: string;
  /** "download" | "shell" */
  kind: string;
  state: "running" | "completed" | "failed" | "cancelled";
  message: string;
  downloaded: number;
  total: number | null;
  speedBps: number;
  destPath: string | null;
}

/** Final metrics of a session's last completed turn — the composer's idle
 *  metrics row shows these so the numbers match the turn just watched. */
export interface LastTurnMetrics {
  llmTimeMs: number;
  toolTimeMs: number;
  ttftMs: number | null;
  tokensPerSecond: number | null;
  outputTokens: number;
  inputTokens: number | null;
  cacheHitRate: number | null;
  elapsedMs: number | null;
}

/** A single checkpoint/step extracted from a model-generated plan. Displayed
 *  in the Git sidebar Progress section alongside background task items. */
export interface PlanStep {
  stepId: string;           // "plan-{sessionId}-{planIndex}-{stepIndex}"
  label: string;            // human-readable step text
  status: "pending" | "in_progress" | "completed" | "failed";
  source: "parsed" | "todo_write";  // how this step was discovered
  planIndex: number;        // which plan (increments per plan detected)
  stepIndex: number;        // order within the plan
  completedAt?: number;     // Date.now() when marked done
  failedReason?: string;
  matchedToolCall?: string; // e.g. file path that triggered completion
}

/** A file the model generated during a chat, surfaced as a download chip. */
export interface ChatArtifact {
  path: string;
  filename: string;
  /** Inline (non-file) live preview payload — a ```jsx / ```tsx code block
   *  from an assistant message, or an in-memory rendered mermaid SVG (the
   *  "Open in tab" path for ```mermaid fences, which have no file on disk).
   *  When set, the preview pane renders it directly instead of reading
   *  `path` from disk. */
  inline?: { kind: "jsx" | "tsx" | "svg"; code: string };
}

/** A message stacked while a turn is running (composer queue, FIFO).
 *  Drained one-by-one when the session's stream finishes. */
export interface QueuedChatMessage {
  id: number;
  content: string;
  attachments?: ChatAttachmentInput[];
  forceResearch?: boolean;
}

/** Monotonic id for queued messages — `Date.now()` collided when two
 *  messages stacked within the same millisecond, and steer/edit/delete act
 *  BY ID (the collision made steer remove both rows). In-memory only, so a
 *  plain counter is sufficient. */
let NEXT_QUEUE_ID = 1;

/**
 * In-memory image bytes for SENT messages. Attachments are persisted as text
 * markers inside `content` (the backend never stores the bytes), so a
 * persisted user row renders attachment cards WITHOUT image data — the real
 * thumbnail existed only on the optimistic bubble and vanished the moment a
 * refetch replaced it with the persisted twin (the "thumbnail disappears when
 * the reply arrives" bug). sendMessage remembers the live attachments under
 * the same role+content equality mergeOptimistic matches on, and MessageBubble
 * consults the cache, so image cards keep their thumbnail for the whole app
 * session. Restart loses it (by design — bytes never leave the turn), and the
 * card degrades to its name+badge glyph, same as history from older builds.
 */
const liveAttachmentCache = new Map<string, ChatAttachmentInput[]>();
const LIVE_ATTACHMENT_CACHE_CAP = 100;

function liveAttachmentKey(
  chatSessionId: string | null | undefined,
  content: string,
): string {
  return `${chatSessionId}\u0000${content}`;
}

/** Remember the live (byte-carrying) attachments of a send under the exact
 *  content the backend will persist — see liveAttachmentCache. */
export function rememberLiveAttachments(
  chatSessionId: string,
  content: string,
  attachments: ChatAttachmentInput[],
): void {
  if (attachments.length === 0) return;
  liveAttachmentCache.set(liveAttachmentKey(chatSessionId, content), attachments);
  while (liveAttachmentCache.size > LIVE_ATTACHMENT_CACHE_CAP) {
    const oldest = liveAttachmentCache.keys().next().value;
    if (oldest === undefined) break;
    liveAttachmentCache.delete(oldest);
  }
}

/** Live attachment bytes for a message, when THIS app run sent it. Undefined
 *  for history loaded from the DB (or after eviction) — callers fall back to
 *  the marker-derived card without a thumbnail. */
export function liveAttachmentsForMessage(
  message: { chatSessionId: string | null | undefined; content: string },
): ChatAttachmentInput[] | undefined {
  const hit = liveAttachmentCache.get(
    liveAttachmentKey(message.chatSessionId, message.content),
  );
  return hit && hit.length > 0 ? hit : undefined;
}

/** A per-session goal-driven loop (/goal / /loop). The host auto-issues a
 *  follow-up turn whenever the last reply said `LOOP_STATUS: continue`, up to
 *  `max` iterations. `advanceLoop` inspects the sentinel to decide. */
export interface LoopState {
  /** The goal text after the /goal (or /loop) token. */
  goal: string;
  /** Replies/completions seen so far (0 = loop freshly armed, pre-first-turn). */
  iteration: number;
  /** Hard cap on loop turns — safety rail against runaway loops. */
  max: number;
  /** Whether the loop is still live. Set false when it completes, blocks,
   *  errors, is stopped by the user, or the cap is reached. */
  active: boolean;
  /** Backend loop-session id (SELF_IMPROVING_ARTIFACTS.md P0) — set once the
   *  fire-and-forget `loop_session_start` resolves. Telemetry only; the
   *  frontend state machine stays authoritative for loop control. */
  backendId?: string;
}

/** What `advanceLoop` decided after one reply. */
export type LoopDecision = "continue" | "complete" | "blocked" | "stop";

/** Default cap on goal-loop iterations unless the composer overrides it. */
export const GOAL_LOOP_MAX = 10;

/** Parse the machine-readable sentinel out of a last assistant reply. Any
 *  trailing `LOOP_STATUS: <value>` line wins; missing/malformed = "stop" so an
 *  uncooperative model can never drive an infinite loop. */
export function parseLoopStatus(reply: string): "continue" | "complete" | "blocked" | "stop" {
  const lines = reply
    .split(/\r?\n/)
    .map((l) => l.trim())
    .map((l) => l.replace(/^>\s*/, "")); // tolerate a blockquote wrapping in markdown
  // Walk from the end so the final sentinel wins even if it appears mid-text.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^LOOP_STATUS:\s*(continue|complete|blocked)\s*$/i.exec(lines[i]);
    if (m) return m[1].toLowerCase() as "continue" | "complete" | "blocked";
  }
  return "stop";
}

/** Float starred chats to the top while preserving the existing (recency)
 *  order within the starred and unstarred groups. Stable so the optimistic
 *  "bump active chat to top" reordering still works. */
function sortSessions(list: ChatSession[]): ChatSession[] {
  const starred = list.filter((s) => s.starred);
  const rest = list.filter((s) => !s.starred);
  return [...starred, ...rest];
}

/** Strip EVERY per-session keyed entry for one chat session (audit H3).
 *  deleteChat used to clear only some of these — chatStatus, messageQueue,
 *  tasks, planSteps, subagents, livePerf, sessionMetrics, cwdOverrides and
 *  the message-keyed maps survived forever, so churn of create/delete chats
 *  grew these records for the app's lifetime. Message-keyed maps are only
 *  pruned when the buffer holds this session's rows (its ids are then
 *  known); ids are globally unique, so removal is always safe.
 *  Returns a partial state patch — merge with the caller's extra fields. */
function clearSessionState(s: ChatState, chatSessionId: string): Partial<ChatState> {
  const streaming = { ...s.streaming };
  delete streaming[chatSessionId];
  const chatStatus = { ...s.chatStatus };
  delete chatStatus[chatSessionId];
  const artifacts = { ...s.artifacts };
  delete artifacts[chatSessionId];
  const pendingArtifacts = { ...s.pendingArtifacts };
  delete pendingArtifacts[chatSessionId];
  const pendingApprovals = { ...s.pendingApprovals };
  delete pendingApprovals[chatSessionId];
  const pendingQuestions = { ...s.pendingQuestions };
  delete pendingQuestions[chatSessionId];
  const sessionProjects = { ...s.sessionProjects };
  delete sessionProjects[chatSessionId];
  const loopState = { ...s.loopState };
  delete loopState[chatSessionId];
  const messageQueue = { ...s.messageQueue };
  delete messageQueue[chatSessionId];
  const tasks = { ...s.tasks };
  delete tasks[chatSessionId];
  const planSteps = { ...s.planSteps };
  delete planSteps[chatSessionId];
  const sessionTodos = { ...s.sessionTodos };
  delete sessionTodos[chatSessionId];
  const planMode = { ...s.planMode };
  delete planMode[chatSessionId];
  const pendingPlanProposals = { ...s.pendingPlanProposals };
  delete pendingPlanProposals[chatSessionId];
  const sessionPlans = { ...s.sessionPlans };
  delete sessionPlans[chatSessionId];
  const subagents = { ...s.subagents };
  delete subagents[chatSessionId];
  const livePerf = { ...s.livePerf };
  delete livePerf[chatSessionId];
  const sessionMetrics = { ...s.sessionMetrics };
  delete sessionMetrics[chatSessionId];
  const cwdOverrides = { ...s.cwdOverrides };
  delete cwdOverrides[chatSessionId];
  const ownerSessionByChatId = { ...s.ownerSessionByChatId };
  delete ownerSessionByChatId[chatSessionId];
  let artifactsByMessage = s.artifactsByMessage;
  let checkpointsByMessage = s.checkpointsByMessage;
  if (s.messagesSessionId === chatSessionId) {
    artifactsByMessage = { ...s.artifactsByMessage };
    checkpointsByMessage = { ...s.checkpointsByMessage };
    for (const m of s.messages) {
      delete artifactsByMessage[m.id];
      delete checkpointsByMessage[m.id];
    }
  }
  return {
    streaming,
    chatStatus,
    artifacts,
    pendingArtifacts,
    pendingApprovals,
    pendingQuestions,
    sessionProjects,
    loopState,
    messageQueue,
    tasks,
    planSteps,
    sessionTodos,
    planMode,
    pendingPlanProposals,
    sessionPlans,
    subagents,
    livePerf,
    sessionMetrics,
    cwdOverrides,
    ownerSessionByChatId,
    artifactsByMessage,
    checkpointsByMessage,
    streamingChatSessionId:
      s.streamingChatSessionId === chatSessionId ? null : s.streamingChatSessionId,
    fullAccessConfirmingFor:
      s.fullAccessConfirmingFor === chatSessionId ? null : s.fullAccessConfirmingFor,
  };
}

export interface ChatState {
  loaded: boolean;
  sessions: ChatSession[];
  activeChatSessionId: string | null;
  messages: ChatMessageRecord[];
  /** Which session's rows the `messages` buffer currently holds. Guards the
   *  "outgoing chat is empty" check in selectSession — reading the buffer
   *  alone can't tell an empty chat from a not-yet-fetched one (H1). */
  messagesSessionId: string | null;
  streaming: Record<string, string>; // chatSessionId -> accumulating assistant text
  /** LEGACY scalar naming whichever session emitted the last token. The
   *  per-session `streaming` map is the source of truth for "is this session
   *  streaming" — never gate logic on this scalar (sessions can stream
   *  concurrently and flip it between them; see H2/M1/M2). */
  streamingChatSessionId: string | null;
  /** Pre-token status notice per session (chatSessionId -> reason+message),
   *  e.g. a local model cold-starting after a restart. Cleared on the first
   *  token / done / error. */
  chatStatus: Record<string, { reason: string; message: string }>;
  config: ChatConfigPayload | null;
  error: string | null;
  /** Machine-readable classification of the last chat:error for the active
   *  session ("context_overflow", …) — null when unclassified. Cleared with
   *  `error` everywhere `error` is cleared. */
  errorCode: string | null;
  /** Reasoning effort sent with messages ("" = provider default). */
  effort: string;
  /** Per-session extended-thinking toggle. `true` enables the thinking
   *  block on Anthropic / `chat_template_kwargs.enable_thinking` on local
   *  GGUF (Qwen3, DeepSeek-R1); cloud OpenAI ignores it. `false` explicitly
   *  suppresses thinking; `null` falls back to the provider default. */
  thinking: boolean | null;
  /** Context size (tokens) for local GGUF models; 0 = auto (picked from the
   *  GGUF file size). Applied when the llama-server sidecar (re)starts. */
  localCtx: number;
  /** Monotonic counter bumped every time a `context_compacted` chat:status
   *  event lands for the active session. Drives an immediate context-meter
   *  re-poll so the ring ticks down right after compaction instead of
   *  waiting up to one polling interval (2s). */
  compactionRevision: number;
  /** When true, the model may call tools (web search, …) during a turn. */
  toolsEnabled: boolean;
  /** When true, the model may execute code (opt-in, security-sensitive). */
  codeExecEnabled: boolean;
  /** Generated files per chat session (chatSessionId -> artifacts). */
  artifacts: Record<string, ChatArtifact[]>;
  /** Artifacts attributed to a specific assistant message (messageId -> artifacts). */
  artifactsByMessage: Record<number, ChatArtifact[]>;
  /** Per-turn git checkpoints, keyed by messageId → checkpoints (usually one;
   *  pre-restore safety snapshots have messageId null and are excluded here).
   *  Loaded in selectSession, appended live via checkpoint:created. */
  checkpointsByMessage: Record<number, ChatCheckpoint[]>;
  /** Pending tool-approval cards, one per chat session id. Set by
   *  `chat:approval-request`, cleared by resolve/`chat:approval-resolved`. */
  pendingApprovals: Record<string, PendingApproval>;
  /** Session id the full_access approval confirmation modal is open for
   *  (null = none). */
  fullAccessConfirmingFor: string | null;
  /** Artifacts produced by the in-flight turn, keyed by session, until the
   *  assistant message is persisted and they can be attributed to it. */
  pendingArtifacts: Record<string, ChatArtifact[]>;
  /** Artifact proposals from conversational creation, per chat session.
   *  States: "generating" | "ready" | "editing" | "created" | "rejected" */
  artifactProposals: Record<string, { id: string; proposal: ArtifactProposal; state: "generating" | "ready" | "editing" | "created" | "rejected" }[]>;
  /** Background chat tasks (download_file / run_shell) with live progress,
   *  keyed by chat session id → task id → latest snapshot. */
  tasks: Record<string, Record<string, ChatTaskProgress>>;
  /** Plan checkpoints extracted from model-generated plans, keyed by
   *  chat session id → steps array. Displayed in Git sidebar Progress. */
  planSteps: Record<string, PlanStep[]>;
  /** The model's authoritative todo list (todo_write), keyed by session id.
   *  Rendered as the live plan checklist card; also synced into planSteps
   *  (source "todo_write") so the sidebar stays consistent. */
  sessionTodos: Record<string, PlanTodo[]>;
  /** Plan-mode flag per chat session, mirrored from the backend
   *  (chat:plan-mode events) and set locally by the composer toggle. */
  planMode: Record<string, boolean>;
  /** Pending present_plan proposals per chat session — the approval cards. */
  pendingPlanProposals: Record<string, PendingPlanProposal>;
  /** Pending harness questions (Claude Code AskUserQuestion) per chat
   *  session — the question cards. The harness turn is PAUSED until the user
   *  answers/skips; cleared on resolve, cancel, or session close. */
  pendingQuestions: Record<string, PendingQuestion>;
  /** APPROVED plans per chat session (newest first) — the sidebar Plans
   *  list. Execution steps live in sessionTodos/planSteps (Progress). */
  sessionPlans: Record<string, ChatPlanRecord[]>;
  /** Active subagents per chat session, keyed by sessionId → subagent id → info.
   *  Updated by chat:subagent-spawn / chat:subagent-tokens / chat:subagent-done. */
  subagents: Record<string, Record<string, SubagentInfo>>;
  /** Per-turn owner session id (mobile app's session identifier) keyed by
   *  chatSessionId. Set by `sendMessage` when invoked from the mobile relay
   *  so the chat:token / chat:done / chat:error / chat:status / chat:artifact
   *  / chat:approval-request event listeners can re-broadcast a corresponding
   *  `mobile:session_chat_event` Tauri event. The relay's `start_relay`
   *  listener picks that event up and writes the matching `DesktopMessage`
   *  variant onto the WS that originated the message. Cleared on the
   *  terminal `chat:done` / `chat:error` for the session. */
  ownerSessionByChatId: Record<string, string>;
  /** Custom working folder per chat session, chosen via the composer's "+"
   *  folder picker. Overrides the selected project's path as the harness
   *  send's cwd and is granted as an extra fs_root on the built-in path.
   *  In-memory only (a session-scoped convenience, not a persisted setting). */
  cwdOverrides: Record<string, string>;
  /** The project each chat session is bound to, recorded when the user sends
   *  a message or switches projects while viewing that chat. The composer
   *  notch and the working directory sent to the backend follow this binding
   *  instead of the global selection, so switching between chats shows each
   *  chat's own project. In-memory only (same scope as cwdOverrides). */
  sessionProjects: Record<string, string>;
  /** Messages queued while a turn is running, per chat session, FIFO. Sent
   *  one-by-one by `drainQueue` when the session's stream finishes. */
  messageQueue: Record<string, QueuedChatMessage[]>;
  /** Live per-turn perf snapshot for the composer metrics row, keyed by chat
   *  session id. Updated on throttled `chat:perf` events while a turn streams,
   *  cleared on `chat:done`. Mirrors the `ChatPerfPayload` from the backend. */
  livePerf: Record<string, ChatPerfPayload>;
  /** Final metrics of each session's LAST completed turn, keyed by chat
   *  session id. Captured in `onDone` from the done payload + the final live
   *  snapshot. The composer's idle row prefers this over the session
   *  aggregate so the numbers match the turn the user just watched (the
   *  aggregate sums every turn and is empty for providers that don't write
   *  cost events, which read as "wrong data"). */
  lastTurnPerf: Record<string, LastTurnMetrics>;
  /** Session-level aggregate metrics (sums / weighted averages across the
   *  session's assistant turns), keyed by chat session id. Fetched when a
   *  session is opened and after each turn completes (`chat:done`), used for
   *  the composer metrics row. */
  sessionMetrics: Record<string, ChatSessionMetricsPayload>;
  /** Goal-driven loops (/goal / /loop) keyed by chat session id. Only the
   *  active session's loop is advanced, and only while the session is active
   *  (switching away pauses it). */
  loopState: Record<string, LoopState>;
  /** Trimmed content of the session's last USER-STOPPED turn (captured in
   *  `cancelStream`, cleared when the session sends again). The bubble whose
   *  content matches keeps its process section expanded after the stop — the
   *  steps are the only content that turn produced, so auto-collapsing them
   *  into an empty-looking "Worked" row erased it. Completed turns never
   *  match (their content differs), so they keep collapsing normally. */
  stoppedPartial: Record<string, string>;
  /** Latest end-of-turn citation-integrity verdict per chat session
   *  (`chat:citation-report` — research turns only). Rendered as the trust
   *  strip above the composer: what the mechanical ledger lint verified about
   *  the report the user just received. In-memory, event-driven; a session
   *  reopened later doesn't re-show an old verdict. */
  citationReports: Record<string, ChatCitationReportPayload>;

  // Actions
  loadSessions: () => Promise<void>;
  loadMessages: (chatSessionId: string) => Promise<void>;
  /** M7: prepend the next older page (id-keyset) when the user scrolls to
   *  the top of a long session. */
  loadOlderMessages: (chatSessionId: string) => Promise<number>;
  /** True when the backend may still hold messages older than the buffer's
   *  first row (false after a short page or when nothing is loaded). */
  hasMoreHistory: boolean;
  /** --- Split chat view -------------------------------------------------
   *  A second, independent chat view beside the main one ("Open in split
   *  view" in a session row's ⋮ menu). The split pane owns its own message
   *  buffer so BOTH views render full-fidelity histories at once; streaming
   *  was already session-keyed, so live turns work in both without extra
   *  state. `splitChatSessionId === activeChatSessionId` is allowed — the
   *  split pane then follows the main list and the split buffer stays idle. */
  splitChatSessionId: string | null;
  splitMessages: ChatMessageRecord[];
  splitMessagesSessionId: string | null;
  splitHasMoreHistory: boolean;
  /** Open the split pane on a session (loading its history). */
  openChatSplit: (chatSessionId: string) => void;
  /** Close the split pane and drop its buffer. */
  closeChatSplit: () => void;
  loadSplitMessages: (chatSessionId: string) => Promise<void>;
  loadOlderSplitMessages: (chatSessionId: string) => Promise<number>;
  /** Which chat the SHARED chrome (toolbar title, folder/git notches, git
   *  sidebar) displays. Null = the plain active session (the main view). In
   *  split view, interacting with the split half pins it to the split
   *  session; interacting with the main half clears it — so everything in
   *  the toolbar/git surface reflects the chat the user is working in. */
  focusedChatSessionId: string | null;
  setFocusedChatSession: (chatSessionId: string | null) => void;
  /** Reload the message buffer that displays `chatSessionId` — the main list
   *  when it's the active session, the split buffer when it's the split
   *  pane's session, nothing otherwise. */
  reloadFor: (chatSessionId: string) => Promise<void>;
  loadConfig: (provider?: string) => Promise<void>;
  loadSessionMetrics: (chatSessionId: string) => Promise<void>;
  /** Open a chat. Records the switch in the ui store's nav timeline unless
   *  `recordNav: false` (nav Back/Forward restores use that). */
  selectSession: (chatSessionId: string, opts?: { recordNav?: boolean }) => Promise<void>;
  /** Start a new chat. When `projectId` is omitted, the new chat inherits
   *  the previously active chat's project binding (independent when that
   *  chat has none); an explicit projectId (project-row "+") wins. */
  newChat: (provider: string, model: string, projectId?: string | null) => Promise<ChatSession | null>;
  deleteChat: (chatSessionId: string) => Promise<void>;
  /** Delete EVERY chat session + message (Settings → Data). Uses the backend
   *  bulk command, then wipes all in-memory chat state so the sidebar and
   *  chat view reflect the deletion immediately. */
  deleteAllChats: () => Promise<number>;
  /** Delete the active chat session if it has no turns (no persisted
   *  messages). Used when leaving the Chat tab so an untouched new chat
   *  doesn't linger as an empty session — returning to Chat starts fresh
   *  instead of reopening the empty stub (or spawning a duplicate). No-op
   *  when the active chat has any messages, or none is active. Returns the
   *  id of the deleted session (null if nothing was deleted). */
  deleteActiveIfEmpty: () => Promise<string | null>;
  renameChat: (chatSessionId: string, title: string) => Promise<void>;
  /** Star/unstar a chat (pins it to the top of the sidebar). */
  setStarred: (chatSessionId: string, starred: boolean) => Promise<void>;
  /** Mark a chat read/unread (shows an unread dot in the sidebar). */
  setUnread: (chatSessionId: string, unread: boolean) => Promise<void>;
  /** Record the owner session id for a chat session, set when the mobile
   *  relay invokes a session-scoped chat message. Used to re-broadcast chat
   *  events back over the relay's per-session WebSocket. */
  setOwnerSessionId: (chatSessionId: string, ownerSessionId: string) => void;
  /** Look up the owner session id for a chat session (returns undefined if
   *  no mobile relay turn is in flight for this chat session). */
  getOwnerSessionId: (chatSessionId: string) => string | undefined;
  setSessionModel: (chatSessionId: string, model: string) => Promise<void>;
  /** Switch a session's provider (e.g. to "local_gguf" when a local model is
   *  picked from the selector in a cloud session, or back again). */
  setSessionProvider: (chatSessionId: string, provider: string) => Promise<void>;
  /** Set a session's agent selection ("builtin" | "local" | "harness:<id>" |
   *  null). Persisted per chat session; drives the composer's locked/unlocked
   *  model chip. */
  setSessionAgent: (chatSessionId: string, agent: string | null) => Promise<void>;
  setEffort: (effort: string) => void;
  setLocalCtx: (ctx: number) => void;
  setThinking: (thinking: boolean | null) => void;
  setToolsEnabled: (enabled: boolean) => void;
  setCodeExecEnabled: (enabled: boolean) => void;
  /** Set/clear a session's custom working folder (null clears, reverting to
   *  the selected project's path). */
  setCwdOverride: (chatSessionId: string, path: string | null) => void;
  /** Worktree-per-session toggle (roadmap P0 §3.1.1): a session with an
   *  isolated worktree joins the main working tree (removing the worktree
   *  best-effort); a session without one gets isolated. */
  toggleSessionWorktree: (chatSessionId: string) => Promise<void>;
  /** Fully unbind a session from its project: drop the per-chat project
   *  binding AND any custom-folder override, so the composer notch disappears
   *  and the working directory falls back to the global selection. */
  unbindProject: (chatSessionId: string) => void;
  /** Drop one queued message from a session's FIFO queue (composer trash). */
  removeQueuedMessage: (chatSessionId: string, id: number) => void;
  /** STEER: send one queued message IMMEDIATELY. Interrupts the session's
   *  running turn (Stop) and dispatches the picked message ahead of the rest
   *  of the stack; the remaining messages stay queued and drain when the
   *  steered turn finishes. */
  steerQueuedMessage: (chatSessionId: string, id: number) => Promise<void>;
  /** Rewrite a queued message's text in place (composer pencil). */
  editQueuedMessage: (chatSessionId: string, id: number, content: string) => void;
  /** Reorder the stack: move the message at `from` so it lands at `to`
   *  (grip drag-and-drop). */
  moveQueuedMessage: (chatSessionId: string, from: number, to: number) => void;
  /** Send the oldest queued message for a session. No-op unless the session
   *  is active and no stream is running (sendMessage targets the active
   *  session; queued items for background sessions wait for selectSession). */
  drainQueue: (chatSessionId: string) => void;
  /** Arm a goal loop for a session (called when the user sends a /goal or
   *  /loop message). Defaults to the active session; the split pane passes
   *  its own. Iterations tick in `onDone`. */
  startLoop: (goal: string, sessionIdOverride?: string) => void;
  /** Disarm a session's loop (Stop button, or when the loop ends). */
  stopLoop: (sessionIdOverride?: string) => void;
  /** Inspect the last assistant reply against the session's loop state and
   *  return the next action. Pure-ish: mutates loopState to advance/close it. */
  advanceLoop: (chatSessionId: string, lastReply: string) => LoopDecision;
  sendMessage: (
    content: string,
    attachments?: ChatAttachmentInput[],
    forceResearch?: boolean,
    /** Target a specific session instead of the global active one — the
     *  split pane sends with its own session id so both composers work
     *  concurrently. */
    sessionIdOverride?: string,
  ) => Promise<void>;
  /** Team broadcast (roadmap #18): send one prompt to N chat sessions at once.
   *  The active session goes through the normal send; background sessions get
   *  a direct per-session send (streaming state is session-keyed, so they
   *  stream concurrently and the sidebar shows each one working). */
  broadcastToSessions: (
    sessionIds: string[],
    content: string,
    forceResearch?: boolean,
  ) => Promise<void>;
  /** Re-run the last user message to get a fresh assistant response. The
   *  optional override targets the split pane's session (same semantics as
   *  sendMessage's). */
  regenerate: (sessionIdOverride?: string) => Promise<void>;
  /** Edit-to-fork (roadmap #9): retire this message's tail, reload, and send a
   *  fresh turn with `newContent`. The old branch stays in the timeline,
   *  dimmed, but no longer feeds the model. */
  editMessage: (messageId: number, newContent: string, sessionIdOverride?: string) => Promise<void>;
  /** Delete one message (user or assistant) from the active chat, both in
   *  the local state and the backend. The optimistic just-sent message has
   *  a negative id and the backend's DELETE matches zero rows; we still
   *  drop it locally so the bubble disappears immediately. */
  deleteMessage: (messageId: number, sessionIdOverride?: string) => Promise<void>;
  cancelStream: (sessionIdOverride?: string) => Promise<void>;
  /** Open an artifact as its own named tab in the tool panel (delegates to
   *  the ui store's openArtifactTab, which dedupes by path). `null` is a
   *  no-op kept for call-site compatibility. */
  setPreviewArtifact: (artifact: ChatArtifact | null) => void;
  /** Add an artifact proposal for a chat session (starts in "generating" state). */
  addArtifactProposal: (chatSessionId: string, proposal: ArtifactProposal) => void;
  /** Update an artifact proposal's state or proposal data. */
  updateArtifactProposal: (chatSessionId: string, proposalId: string, updates: Partial<{ proposal: ArtifactProposal; state: "generating" | "ready" | "editing" | "created" | "rejected" }>) => void;
  /** Remove an artifact proposal from a chat session. */
  removeArtifactProposal: (chatSessionId: string, proposalId: string) => void;
  /** Get artifact proposals for a chat session. */
  getArtifactProposals: (chatSessionId: string) => { id: string; proposal: ArtifactProposal; state: "generating" | "ready" | "editing" | "created" | "rejected" }[];
  /** Open the appropriate editor tab for an artifact proposal and prefill the form. */
  editArtifactProposal: (chatSessionId: string, proposalId: string, proposal: ArtifactProposal) => void;
  /** Set a session's watch-mode pacing override. on/off = per-session override;
   *  null clears the override so the session inherits the global setting. */
  setSessionWatchMode: (chatSessionId: string, mode: WatchMode | null) => Promise<void>;
  /** Set a session's sandbox + approval policies. Switching INTO
   *  full_access approval opens the one-time confirmation modal instead
   *  (returns false); other combinations apply immediately (returns true). */
  setSessionPolicies: (
    chatSessionId: string,
    sandbox: SandboxPolicy,
    approval: ApprovalPolicy,
  ) => Promise<boolean>;
  /** Confirm the full_access approval switch from the modal (persists + applies). */
  confirmFullAccess: (chatSessionId: string) => Promise<void>;
  /** Dismiss the full_access confirmation modal without switching. */
  cancelFullAccessConfirm: () => void;
  /** Resolve the session's pending approval card (Approve/Deny). */
  resolveApproval: (chatSessionId: string, approved: boolean) => Promise<void>;
  saveApiKey: (provider: string, key: string, baseUrl?: string, model?: string) => Promise<void>;
  clearApiKey: (provider: string) => Promise<void>;

  // Called by the event hook (useChatEvents) — not meant for direct component use.
  onToken: (chatSessionId: string, token: string) => void;
  /** Pre-create the streaming entry for a turn the BACKEND started (an
   *  automation run). Without it, onToken's straggler guard would drop every
   *  token the run emits. Called from automation:run-started. */
  beginRemoteTurn: (chatSessionId: string) => void;
  /** Clear the streaming entry a remote turn began with, and refetch the
   *  active session's messages so the persisted reply appears. Called from
   *  automation:run-finished — covers providers whose one-shot path never
   *  emits chat:done, and failure paths that die before a terminal event. */
  endRemoteTurn: (chatSessionId: string) => Promise<void>;
  onStatus: (chatSessionId: string, reason: string, message: string) => void;
  onDone: (
    chatSessionId: string,
    inputTokens: number | null,
    outputTokens: number | null,
    costUsd: number | null,
    llmTimeMs?: number | null,
    toolTimeMs?: number | null,
    ttftMs?: number | null,
    tokensPerSecond?: number | null,
    cacheHitRate?: number | null,
  ) => void;
  /** Update the live per-turn perf snapshot for a session (from `chat:perf`). */
  onPerf: (payload: ChatPerfPayload) => void;
  /** Record the end-of-turn citation-integrity verdict (research turns). */
  onCitationReport: (payload: ChatCitationReportPayload) => void;
  /** Dismiss the strip (repair turn dispatched). */
  clearCitationReport: (chatSessionId: string) => void;
  onError: (chatSessionId: string, message: string, code: string | null) => void;
  onArtifact: (payload: ChatArtifactPayload) => void;
  /** Append a checkpoint from `checkpoint:created` (baseline, post-turn, or
   *  pre-restore safety snapshot) to the live chip map. */
  onCheckpointCreated: (payload: ChatCheckpoint) => void;
  /** Surface/clear a session's pending approval card (chat:approval-request
   *  / chat:approval-resolved events). */
  onApprovalRequest: (payload: ChatApprovalRequestPayload) => void;
  onApprovalResolved: (payload: ChatApprovalResolvedPayload) => void;
  /** Surface a harness question card (chat:question-request — Claude Code
   *  AskUserQuestion). The harness turn is paused until resolveQuestion. */
  onQuestionRequest: (payload: ChatQuestionRequestPayload) => void;
  /** Answer the session's pending question card (or skip it with no
   *  selections and no free text). */
  resolveQuestion: (
    chatSessionId: string,
    answers: Record<string, string | string[]>,
    response?: string,
  ) => Promise<void>;
  /** Track a background chat task's progress (downloads / shell runs). */
  onTaskProgress: (payload: ChatTaskProgressPayload) => void;
  /** Replace all plan steps for a session (called after parsing a new plan). */
  setPlanSteps: (chatSessionId: string, steps: PlanStep[]) => void;
  /** Update a single plan step's status from a backend event or text match. */
  onPlanStepProgress: (chatSessionId: string, stepId: string, status: PlanStep["status"], detail?: string, toolCall?: string) => void;
  /** Replace the session's authoritative todo list (chat:plan-updated) and
   *  mirror it into planSteps so the sidebar Progress section agrees. */
  onPlanUpdated: (payload: ChatPlanUpdatedPayload) => void;
  /** Plan-mode flag flipped (chat:plan-mode, or the composer mode menu).
   *  `label` mirrors the session's persisted permissionMode so the mode
   *  selector agrees everywhere ("plan" when active, the restored posture
   *  label when not). */
  onPlanMode: (payload: ChatPlanModePayload) => void;
  /** Enter/exit plan mode from the mode menu. Persists via
   *  set_chat_session_plan_mode and syncs the live gate; exiting restores the
   *  posture the session had before planning. */
  setSessionPlanMode: (chatSessionId: string, active: boolean) => Promise<void>;
  /** Set a HARNESS session's native permission mode (harness-mode menu). */
  setSessionPermissionMode: (chatSessionId: string, mode: string) => Promise<void>;
  /** Surface/clear a present_plan proposal card (chat:plan-proposal). */
  onPlanProposal: (payload: ChatPlanProposalPayload) => void;
  onPlanProposalResolved: (chatSessionId: string) => void;
  /** Append an APPROVED plan to the session's Plans list (chat:plan-accepted). */
  onPlanAccepted: (payload: ChatPlanAcceptedPayload) => void;
  /** Deliver the user's approve/reject decision to the paused turn. */
  resolvePlanProposal: (chatSessionId: string, approved: boolean, feedback?: string) => Promise<void>;
  /** Subagent spawn detected — add entry to the store. */
  onSubagentSpawn: (payload: SubagentSpawnPayload) => void;
  /** Subagent token chunk — append to active subagent output. */
  onSubagentTokens: (payload: SubagentTokenPayload) => void;
  /** Subagent completed or errored — finalize the entry. */
  onSubagentDone: (payload: SubagentDonePayload) => void;
}

/** The session whose context the shared UI should display: the split-pane
 *  focus pin when set, else the plain active session. Toolbar title, folder/
 *  git notches, and the git tools sidebar all select through this so their
 *  data follows whichever chat the user is working in. */
export const selectContextSessionId = (s: ChatState): string | null =>
  s.focusedChatSessionId ?? s.activeChatSessionId;

export const useChatStore = create<ChatState>((set, get) => ({
  loaded: false,
  sessions: [],
  activeChatSessionId: null,
  messages: [],
  messagesSessionId: null,
  hasMoreHistory: false,
  splitChatSessionId: null,
  splitMessages: [],
  splitMessagesSessionId: null,
  splitHasMoreHistory: false,
  focusedChatSessionId: null,
  streaming: {},
  streamingChatSessionId: null,
  chatStatus: {},
  config: null,
  error: null,
  errorCode: null,
  effort: "",
  // null = no override (provider default). The composer's "brain" button
  // flips this to true/false and resets to null on session change.
  thinking: null,
  localCtx: 0,
  // Bumped on every `chat:status` event with reason="context_compacted" so
  // the context meter re-polls immediately when compaction shortens the
  // history. Without this, the meter can keep showing the pre-compaction
  // count for up to one polling interval (2s), which is long enough for the
  // user to send another turn that re-triggers compaction on the same stale
  // number. ChatView derives a per-session value from chatStatus and feeds
  // it to useContextMeter as `compactionRevision`.
  compactionRevision: 0,
  // Tools are on by default so the model itself decides when to web-search,
  // generate a file/document/diagram, fetch a URL or run code — the user no
  // longer has to arm them manually before each relevant request.
  toolsEnabled: true,
  codeExecEnabled: true,
  artifacts: {},
  artifactsByMessage: {},
  checkpointsByMessage: {},
  pendingApprovals: {},
  pendingQuestions: {},
  fullAccessConfirmingFor: null,
  pendingArtifacts: {},
  artifactProposals: {},
  tasks: {},
  planSteps: {},
  sessionTodos: {},
  planMode: {},
  pendingPlanProposals: {},
  sessionPlans: {},
  subagents: {},
  ownerSessionByChatId: {},
  cwdOverrides: {},
  sessionProjects: {},
  messageQueue: {},
  livePerf: {},
  lastTurnPerf: {},
  sessionMetrics: {},
  loopState: {},
  stoppedPartial: {},
  citationReports: {},

  setCwdOverride: (chatSessionId, path) =>
    set((s) => {
      const next = { ...s.cwdOverrides };
      if (path) next[chatSessionId] = path;
      else delete next[chatSessionId];
      return { cwdOverrides: next };
    }),

  unbindProject: (chatSessionId) => {
    void setChatSessionProject(chatSessionId, null);
    set((s) => {
      const sessionProjects = { ...s.sessionProjects };
      delete sessionProjects[chatSessionId];
      const cwdOverrides = { ...s.cwdOverrides };
      delete cwdOverrides[chatSessionId];
      return {
        sessionProjects,
        cwdOverrides,
        sessions: s.sessions.map((sess) =>
          sess.id === chatSessionId ? { ...sess, projectId: null, worktreePath: null } : sess,
        ),
      };
    });
  },

  toggleSessionWorktree: async (chatSessionId) => {
    const session = get().sessions.find((s) => s.id === chatSessionId);
    if (!session) return;
    if (session.worktreePath) {
      // "Join main working tree": backend removes the worktree best-effort
      // (branch stays in the repo) and clears the pointer; mirror locally.
      try {
        await setChatSessionWorktree(chatSessionId, null);
      } catch {
        // Best-effort by design — still clear the local pointer below.
      }
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === chatSessionId ? { ...sess, worktreePath: null } : sess,
        ),
      }));
      return;
    }
    // Isolate: create + persist + watch, patching state when it resolves.
    await maybeEnsureWorktree(session);
  },

  removeQueuedMessage: (chatSessionId, id) =>
    set((s) => ({
      messageQueue: {
        ...s.messageQueue,
        [chatSessionId]: (s.messageQueue[chatSessionId] ?? []).filter((m) => m.id !== id),
      },
    })),

  steerQueuedMessage: async (chatSessionId, id) => {
    const queue = get().messageQueue[chatSessionId] ?? [];
    const steered = queue.find((m) => m.id === id);
    if (!steered) return;
    const remaining = queue.filter((m) => m.id !== id);
    // Park the rest of the stack FIRST: cancelStream drains the queue on
    // completion (chat.ts cancel path), and without this it would fire the
    // WRONG (FIFO-next) message ahead of the steered one.
    set((s) => ({ messageQueue: { ...s.messageQueue, [chatSessionId]: [] } }));
    if (chatSessionId in get().streaming) {
      // Steering = interrupt. Stop the in-flight turn, then dispatch the
      // steered message as the very next turn (the partial reply survives
      // via the cancel path's partial persist). Both calls take the session
      // id explicitly — without it they'd cancel/send into whichever chat is
      // globally active, not the one being steered (audit B-21).
      await get().cancelStream(chatSessionId);
    }
    // Put the not-yet-sent messages back — they drain FIFO once the steered
    // turn finishes (onDone → drainQueue).
    set((s) => ({ messageQueue: { ...s.messageQueue, [chatSessionId]: remaining } }));
    void get().sendMessage(steered.content, steered.attachments, steered.forceResearch, chatSessionId);
  },

  editQueuedMessage: (chatSessionId, id, content) =>
    set((s) => ({
      messageQueue: {
        ...s.messageQueue,
        [chatSessionId]: (s.messageQueue[chatSessionId] ?? []).map((m) =>
          m.id === id ? { ...m, content } : m,
        ),
      },
    })),

  moveQueuedMessage: (chatSessionId, from, to) =>
    set((s) => {
      const queue = [...(s.messageQueue[chatSessionId] ?? [])];
      if (from < 0 || from >= queue.length || to < 0 || to >= queue.length || from === to) {
        return {};
      }
      const [moved] = queue.splice(from, 1);
      queue.splice(to, 0, moved);
      return { messageQueue: { ...s.messageQueue, [chatSessionId]: queue } };
    }),

  drainQueue: (chatSessionId) => {
    // sendMessage takes a per-session override, so a background or split-pane
    // session drains its own queue directly instead of stranding it until
    // the user re-opens the chat.
    // Per-session check (not the shared streamingChatSessionId scalar):
    // sessions A and B can stream concurrently, and A's queued messages must
    // not strand just because B owns the scalar when A finishes.
    if (chatSessionId in get().streaming) return;
    const [next, ...rest] = get().messageQueue[chatSessionId] ?? [];
    if (!next) return;
    set((s) => ({ messageQueue: { ...s.messageQueue, [chatSessionId]: rest } }));
    void get().sendMessage(next.content, next.attachments, next.forceResearch, chatSessionId);
  },

  startLoop: (goal, sessionIdOverride?) => {
    const id = sessionIdOverride ?? get().activeChatSessionId;
    if (!id) return;
    set((s) => ({
      loopState: {
        ...s.loopState,
        [id]: { goal, iteration: 0, max: GOAL_LOOP_MAX, active: true },
      },
    }));
    // Persist the loop session (run telemetry + survival across restarts).
    // Fire-and-forget: telemetry must never block arming the loop.
    void loopSessionStart(id, goal, GOAL_LOOP_MAX)
      .then((ls) => {
        if (!ls) return;
        set((s) => {
          const cur = s.loopState[id];
          if (!cur) return {};
          return { loopState: { ...s.loopState, [id]: { ...cur, backendId: ls.id } } };
        });
      })
      .catch(() => {});
  },

  stopLoop: (sessionIdOverride?) => {
    const id = sessionIdOverride ?? get().activeChatSessionId;
    if (!id) return;
    set((s) => {
      const cur = s.loopState[id];
      if (!cur) return {};
      if (cur.active && cur.backendId) {
        void loopSessionFinish(cur.backendId, "stopped").catch(() => {});
      }
      return { loopState: { ...s.loopState, [id]: { ...cur, active: false } } };
    });
  },

  advanceLoop: (chatSessionId, lastReply) => {
    const cur = get().loopState[chatSessionId];
    // No loop armed for this session — nothing to do.
    if (!cur || !cur.active) return "stop";
    const nextIter = cur.iteration + 1;
    const status = parseLoopStatus(lastReply);
    // Cap reached: stop regardless of what the model said, so a runaway can
    // never drive past the safety rail. Mark complete so onDone's caller
    // treats this as a final stop.
    if (nextIter >= cur.max) {
      set((s) => ({
        loopState: { ...s.loopState, [chatSessionId]: { ...cur, iteration: nextIter, active: false } },
      }));
      if (cur.backendId) void loopSessionFinish(cur.backendId, "maxed").catch(() => {});
      return "stop";
    }
    if (status === "continue") {
      set((s) => ({
        loopState: { ...s.loopState, [chatSessionId]: { ...cur, iteration: nextIter } },
      }));
      if (cur.backendId) void loopSessionAdvance(cur.backendId, nextIter).catch(() => {});
      return "continue";
    }
    // complete | blocked | stop: end the loop.
    set((s) => ({
      loopState: { ...s.loopState, [chatSessionId]: { ...cur, iteration: nextIter, active: false } },
    }));
    if (cur.backendId) {
      const terminal = status === "complete" ? "complete" : status === "blocked" ? "blocked" : "stopped";
      void loopSessionFinish(cur.backendId, terminal).catch(() => {});
    }
    return status === "complete" ? "complete" : status === "blocked" ? "blocked" : "stop";
  },

  loadSessions: async () => {
    const sessions = await listChatSessions();
    const clean = withoutDeleted(sessions ?? []);
    // Seed the in-memory binding cache from the persisted project_id so the
    // sidebar nesting + composer notch survive an app restart.
    const seeded: Record<string, string> = {};
    for (const s of clean) if (s.projectId) seeded[s.id] = s.projectId;
    set({ loaded: true, sessions: clean, sessionProjects: seeded });
  },

  loadMessages: async (chatSessionId) => {
    // M7: latest page only — long sessions no longer deserialize their full
    // history on open. Older pages prepend via loadOlderMessages.
    const messages = await getChatMessages(chatSessionId, undefined, 200);
    set((s) => ({
      // mergeOptimistic: a session opened while its queued message is mid-
      // drain keeps the in-flight bubble instead of snapping back to the
      // pre-persist snapshot.
      messages:
        s.activeChatSessionId === chatSessionId
          ? mergeOptimistic(s.messages, messages ?? [])
          : s.messages,
      messagesSessionId:
        s.activeChatSessionId === chatSessionId ? chatSessionId : s.messagesSessionId,
      hasMoreHistory: s.activeChatSessionId === chatSessionId ? (messages?.length ?? 0) >= 200 : s.hasMoreHistory,
    }));
  },

  loadOlderMessages: async (chatSessionId) => {
    const first = get().messages[0];
    if (!first || first.id <= 0 || !get().hasMoreHistory) return 0;
    const older = await getChatMessages(chatSessionId, first.id, 200);
    if (!older || older.length === 0) {
      // Guard the flag the same way as the set below: an unguarded write
      // while the user switched sessions would kill infinite scroll for the
      // newly-viewed chat (audit L1).
      if (get().activeChatSessionId === chatSessionId) {
        set({ hasMoreHistory: false });
      }
      return 0;
    }
    set((s) => {
      if (s.activeChatSessionId !== chatSessionId) return s;
      // Dedupe by id (the page boundary row may overlap).
      const known = new Set(s.messages.map((m) => m.id));
      const fresh = older.filter((m) => !known.has(m.id));
      return {
        messages: [...fresh, ...s.messages],
        hasMoreHistory: older.length >= 200,
      };
    });
    return older.length;
  },

  // --- Split chat view (session-row ⋮ → "Open in split view") ---
  openChatSplit: (chatSessionId) => {
    set((s) => ({
      splitChatSessionId: chatSessionId,
      // Reopening on the SAME session keeps the loaded buffer (scroll pos
      // resets anyway); a different session starts a fresh buffer.
      splitMessages:
        s.splitMessagesSessionId === chatSessionId ? s.splitMessages : [],
      splitMessagesSessionId:
        s.splitMessagesSessionId === chatSessionId ? s.splitMessagesSessionId : null,
      splitHasMoreHistory:
        s.splitMessagesSessionId === chatSessionId ? s.splitHasMoreHistory : false,
    }));
  },

  closeChatSplit: () => {
    set({ splitChatSessionId: null, splitMessages: [], splitMessagesSessionId: null, splitHasMoreHistory: false, focusedChatSessionId: null });
  },

  setFocusedChatSession: (chatSessionId) => set({ focusedChatSessionId: chatSessionId }),

  loadSplitMessages: async (chatSessionId) => {
    // Mirrors loadMessages but fills the SPLIT pane's buffer; guarded so a
    // slow fetch for a pane the user already re-targeted can't clobber it.
    const messages = await getChatMessages(chatSessionId, undefined, 200);
    set((s) => ({
      splitMessages:
        s.splitChatSessionId === chatSessionId
          ? mergeOptimistic(s.splitMessages, messages ?? [])
          : s.splitMessages,
      splitMessagesSessionId:
        s.splitChatSessionId === chatSessionId ? chatSessionId : s.splitMessagesSessionId,
      splitHasMoreHistory:
        s.splitChatSessionId === chatSessionId ? (messages?.length ?? 0) >= 200 : s.splitHasMoreHistory,
    }));
  },

  loadOlderSplitMessages: async (chatSessionId) => {
    const first = get().splitMessages[0];
    if (!first || first.id <= 0 || !get().splitHasMoreHistory) return 0;
    const older = await getChatMessages(chatSessionId, first.id, 200);
    if (!older || older.length === 0) {
      if (get().splitChatSessionId === chatSessionId) {
        set({ splitHasMoreHistory: false });
      }
      return 0;
    }
    set((s) => {
      if (s.splitChatSessionId !== chatSessionId) return s;
      const known = new Set(s.splitMessages.map((m) => m.id));
      const fresh = older.filter((m) => !known.has(m.id));
      return {
        splitMessages: [...fresh, ...s.splitMessages],
        splitHasMoreHistory: older.length >= 200,
      };
    });
    return older.length;
  },

  reloadFor: async (chatSessionId) => {
    const s = get();
    if (s.activeChatSessionId === chatSessionId) await get().loadMessages(chatSessionId);
    else if (s.splitChatSessionId === chatSessionId) await get().loadSplitMessages(chatSessionId);
  },

  loadConfig: async (provider?: string) => {
    const config = await getChatConfig(provider);
    set({ config });
  },

  loadSessionMetrics: async (chatSessionId) => {
    const metrics = await getChatSessionMetrics(chatSessionId);
    set((s) => {
      if (!metrics) {
        const next = { ...s.sessionMetrics };
        delete next[chatSessionId];
        return { sessionMetrics: next };
      }
      return { sessionMetrics: { ...s.sessionMetrics, [chatSessionId]: metrics } };
    });
  },

  selectSession: async (chatSessionId, opts) => {
    // Ignore selects for sessions deleted this run (stale sidebar row, in-
    // flight click). The tombstone is the source of truth until restart.
    if (deletedSessions.has(chatSessionId)) return;
    // Capture the outgoing session's emptiness BEFORE the switch: the
    // `messages` buffer is replaced by the target session's messages below,
    // so the post-switch check would always see a non-empty buffer.
    // The buffer only counts as the outgoing session's emptiness when it
    // actually holds THAT session's rows — a rapid A→B→C switch reaches here
    // before B's fetch commits, and the buffer still shows A's (empty) page;
    // trusting it would delete B's whole history (audit H1).
    const outgoingId = get().activeChatSessionId;
    const outgoingEmpty =
      get().messagesSessionId === outgoingId && get().messages.length === 0;
    // Opening a chat clears its unread mark (persisted only if it was set).
    const wasUnread = get().sessions.find((s) => s.id === chatSessionId)?.unread ?? false;
    // Reset the per-session thinking override to the provider default
    // whenever the user switches chats. The "brain" button is per-session.
    set((s) => ({
      activeChatSessionId: chatSessionId,
      error: null,
      errorCode: null,
      thinking: null,
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId && sess.unread ? { ...sess, unread: false } : sess,
      ),
    }));
    if (wasUnread) void setChatSessionUnread(chatSessionId, false);
    // Record the switch in the ui store's browser-style nav timeline so
    // Back/Forward return to the chat the user was reading, not just the
    // view. Restore-driven switches (nav Back/Forward) skip recording.
    if (opts?.recordNav !== false && outgoingId !== chatSessionId) {
      useUiStore.getState().recordChatNav(chatSessionId);
    }
    // Follow the chat's project binding: switching to a chat that was working
    // on a different project moves the global selection (and with it the
    // composer notch, Files tab, and the working directory) to that project.
    // Without this every chat showed whatever project was clicked last.
    const boundProjectId = get().sessionProjects[chatSessionId];
    if (boundProjectId) {
      const ps = useProjectsStore.getState();
      if (ps.selectedProjectId !== boundProjectId && ps.projectById(boundProjectId)) {
        ps.selectProject(boundProjectId);
      }
    }
    const [messages, records, checkpoints] = await Promise.all([
      getChatMessages(chatSessionId, undefined, 200),
      listChatArtifacts(chatSessionId),
      listChatCheckpoints(chatSessionId),
    ]);
    // Only update messages if the user hasn't clicked away to another session
    // while the fetch was in-flight.
    if (get().activeChatSessionId === chatSessionId) {
      set({
        messages: messages ?? [],
        messagesSessionId: chatSessionId,
        activeChatSessionId: chatSessionId,
        hasMoreHistory: (messages?.length ?? 0) >= 200,
      });
      // Restore this chat's generated artifacts (inline diagrams / file chips)
      // so they reappear when the session is reopened. Skip sessions that are
      // mid-stream — their live buffers are the source of truth. Per-session
      // check: the legacy scalar can name another concurrently-streaming chat.
      if (records && !(chatSessionId in get().streaming)) {
        const list: ChatArtifact[] = records.map((r) => ({
          path: r.path,
          filename: r.filename,
        }));
        const byMessage: Record<number, ChatArtifact[]> = {};
        for (const r of records) {
          if (r.chatMessageId == null) continue;
          (byMessage[r.chatMessageId] ??= []).push({
            path: r.path,
            filename: r.filename,
          });
        }
        set((s) => ({
          artifacts: { ...s.artifacts, [chatSessionId]: list },
          artifactsByMessage: { ...s.artifactsByMessage, ...byMessage },
        }));
      }
      // Checkpoint chips: keyed by messageId, REPLACED on session open (not
      // merged — the keys belong to this session's messages only). Baselines
      // and safety snapshots (messageId null) are backend-only.
      if (checkpoints) {
        const byMessage: Record<number, ChatCheckpoint[]> = {};
        for (const c of checkpoints) {
          if (c.messageId == null) continue;
          (byMessage[c.messageId] ??= []).push(c);
        }
        set({ checkpointsByMessage: byMessage });
      }
    }
    // Touch and reorder in the background. Rejection-tolerant: a failed
    // touch/relist must not surface as an unhandled rejection (M9).
    void touchChatSession(chatSessionId)
      .then(async () => {
        const sessions = await listChatSessions();
        if (sessions) set({ sessions: withoutDeleted(sessions) });
      })
      .catch(() => {
        /* best-effort: the sidebar relists on the next interaction */
      });
    // Switching away from a brand-new chat that never received a message
    // (e.g. the auto-started default chat) should not leave an empty session
    // row behind in the sidebar. deleteChat() tombstones it, so the relist
    // above can't resurrect it.
    if (outgoingId && outgoingId !== chatSessionId && outgoingEmpty) {
      void get().deleteChat(outgoingId);
    }
    // Opening a session that has messages stacked in its queue (queued while
    // it was in the background) starts draining them now that it's active.
    get().drainQueue(chatSessionId);
    // Load this session's aggregate perf metrics for the composer row.
    void get().loadSessionMetrics(chatSessionId);
  },

  newChat: async (provider, model, projectId) => {
    // Reuse the active session when it already has no turns — clicking "New
    // Chat" while sitting in a fresh empty chat should not spawn yet another
    // empty session. If the caller wants a different provider/model than the
    // empty session already has (e.g. Settings → "Use this model"), update it
    // in place rather than creating a duplicate.
    const { activeChatSessionId, messages, messagesSessionId, sessions } = get();
    const active = activeChatSessionId
      ? sessions.find((s) => s.id === activeChatSessionId)
      : undefined;
    // Buffer-ownership guard (same H1 shape): only reuse the active session
    // when the buffer actually holds ITS rows — after a fast session switch
    // the buffer can still show the previous chat's (empty) page, and
    // reusing based on that would silently hijack a chat with history.
    if (active && messagesSessionId === active.id && messages.length === 0) {
      if (provider && active.provider !== provider) {
        await updateChatSessionProvider(active.id, provider);
      }
      if (model && active.model !== model) {
        await updateChatSessionModel(active.id, model);
      }
      // Adopt the requested project binding so the reused chat nests under
      // the right project (e.g. clicking "+" on a different project).
      const targetProject = projectId !== undefined ? projectId : active.projectId;
      if (targetProject !== active.projectId) {
        await setChatSessionProject(active.id, targetProject ?? null);
      }
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === active.id
            ? {
                ...sess,
                provider: provider || sess.provider,
                model: model || sess.model,
                projectId: targetProject ?? null,
                // The backend removes the old project's worktree on rebind;
                // mirror that locally so a stale pointer can't block ensure.
                worktreePath:
                  targetProject !== sess.projectId ? null : sess.worktreePath,
              }
            : sess,
        ),
        // Keep the in-memory binding cache in sync with the persisted value.
        sessionProjects:
          targetProject != null
            ? { ...s.sessionProjects, [active.id]: targetProject }
            : Object.fromEntries(
                Object.entries(s.sessionProjects).filter(([id]) => id !== active.id),
              ),
        error: null,
        errorCode: null,
      }));
      // Give the (possibly just rebound) chat its own worktree, fire-and-forget.
      void maybeEnsureWorktree(get().sessions.find((s) => s.id === active.id));
      return active;
    }

    // Project/folder inheritance: a caller that doesn't pass an explicit
    // projectId ("+" on a project row passes one) creates the chat in the
    // SAME project as the previously active chat; when that chat is
    // unbound, the new chat is independent (null). Matches the empty-chat
    // reuse path above, which already adopts active.projectId.
    const inheritedProjectId =
      projectId !== undefined ? projectId : (active?.projectId ?? null);

    const session = await createChatSession(provider, model, inheritedProjectId);
    if (session) {
      // Record the new chat in the nav timeline: Back should return to the
      // chat the user came from.
      useUiStore.getState().recordChatNav(session.id);
      // Insert at the top so it appears immediately in the sidebar (below
      // any starred chats).
      set((s) => ({
        sessions: sortSessions([session, ...s.sessions]),
        activeChatSessionId: session.id,
        messages: [],
        messagesSessionId: session.id,
        error: null,
        errorCode: null,
        // Seed the in-memory binding cache from the persisted value so the
        // composer notch + working-dir resolution work before first send.
        sessionProjects:
          session.projectId != null
            ? { ...s.sessionProjects, [session.id]: session.projectId }
            : s.sessionProjects,
      }));
      // Worktree-per-session default: isolate the new chat, fire-and-forget.
      void maybeEnsureWorktree(session);
    }
    return session;
  },

  deleteChat: async (chatSessionId) => {
    // Kill any running agent for this session before removing the DB row.
    // Without this a persistent harness CLI (or a mid-turn builtin SSE/tool
    // loop) keeps running and emitting chat:token events for a session that
    // no longer exists — and onToken would re-create the streaming state
    // deleteChat just removed.
    const session = get().sessions.find((s) => s.id === chatSessionId);
    if (isCliAgent(session?.agent)) {
      try { await cancelAgentChatMessage(chatSessionId); } catch { /* best-effort */ }
    } else if (chatSessionId in get().streaming) {
      // Builtin-provider turn in flight: the backend delete only kills
      // harness processes, not ChatManager streams — cancel explicitly.
      try { await cancelChatMessage(chatSessionId); } catch { /* best-effort */ }
    }
    await deleteChatSession(chatSessionId);
    // Tombstone this session for the rest of the app run so background
    // session-list refreshes (selectSession's touch-then-relist, onDone's
    // relist) can't resurrect it via a stale IPC payload that raced the
    // DELETE. Cleared on a full app restart.
    markDeleted(chatSessionId);
    manuallyRenamed.delete(chatSessionId);
    set((s) => ({
      // Strip every per-session key (H3), plus the session row and — when
      // the deleted chat was active — the message buffer, so switching
      // sessions never briefly shows this chat's old messages/artifacts.
      ...clearSessionState(s, chatSessionId),
      sessions: s.sessions.filter((sess) => sess.id !== chatSessionId),
      activeChatSessionId: s.activeChatSessionId === chatSessionId ? null : s.activeChatSessionId,
      messages: s.activeChatSessionId === chatSessionId ? [] : s.messages,
      messagesSessionId:
        s.activeChatSessionId === chatSessionId ? null : s.messagesSessionId,
      // A deleted split-pane session closes the split view outright.
      splitChatSessionId: s.splitChatSessionId === chatSessionId ? null : s.splitChatSessionId,
      focusedChatSessionId:
        s.splitChatSessionId === chatSessionId ? null : s.focusedChatSessionId,
      splitMessages: s.splitChatSessionId === chatSessionId ? [] : s.splitMessages,
      splitMessagesSessionId:
        s.splitChatSessionId === chatSessionId ? null : s.splitMessagesSessionId,
      splitHasMoreHistory:
        s.splitChatSessionId === chatSessionId ? false : s.splitHasMoreHistory,
    }));
  },

  deleteAllChats: async () => {
    // Cancel every in-flight stream first (both kinds) — deleting the rows
    // alone doesn't stop backend ChatManager streams or harness children, and
    // their events would recreate state for sessions that no longer exist.
    const state = get();
    const harnessIds = state.sessions
      .filter((s) => isCliAgent(s.agent))
      .map((s) => s.id);
    const builtinIds = Object.keys(state.streaming).filter((id) => !harnessIds.includes(id));
    await Promise.allSettled([
      ...harnessIds.map((id) => cancelAgentChatMessage(id)),
      ...builtinIds.map((id) => cancelChatMessage(id)),
    ]);
    const count = await deleteAllChatSessions();
    // Tombstone every id that existed so background session-list refreshes
    // can't resurrect any of them (same guard as single deleteChat).
    for (const s of get().sessions) markDeleted(s.id);
    set((s) => ({
      sessions: [],
      activeChatSessionId: null,
      messages: [],
      messagesSessionId: null,
      splitChatSessionId: null,
      splitMessages: [],
      splitMessagesSessionId: null,
      splitHasMoreHistory: false,
      focusedChatSessionId: null,
      streaming: {},
      streamingChatSessionId: null,
      chatStatus: {},
      artifacts: {},
      artifactsByMessage: {},
      checkpointsByMessage: {},
      pendingArtifacts: {},
      pendingApprovals: {},
      pendingQuestions: {},
      tasks: {},
      planSteps: {},
      sessionTodos: {},
      planMode: {},
      pendingPlanProposals: {},
      sessionPlans: {},
      messageQueue: {},
      cwdOverrides: {},
      sessionProjects: {},
      ownerSessionByChatId: {},
      loopState: {},
      subagents: {},
      livePerf: {},
      lastTurnPerf: {},
      sessionMetrics: {},
    }));
    return count;
  },

  deleteActiveIfEmpty: async () => {
    const { activeChatSessionId, messages, messagesSessionId } = get();
    if (!activeChatSessionId) return null;
    // Only delete when the buffer genuinely holds THIS session's (empty)
    // rows — trusting a buffer that still belongs to the previous session
    // after a fast switch would delete a chat with history (same H1 shape).
    if (messagesSessionId !== activeChatSessionId || messages.length > 0) return null;
    await get().deleteChat(activeChatSessionId);
    return activeChatSessionId;
  },

  renameChat: async (chatSessionId, title) => {
    markManuallyRenamed(chatSessionId);
    await updateChatSessionTitle(chatSessionId, title);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, title } : sess,
      ),
    }));
  },

  setStarred: async (chatSessionId, starred) => {
    await setChatSessionStarred(chatSessionId, starred);
    set((s) => ({
      sessions: sortSessions(
        s.sessions.map((sess) =>
          sess.id === chatSessionId ? { ...sess, starred } : sess,
        ),
      ),
    }));
  },

  setUnread: async (chatSessionId, unread) => {
    await setChatSessionUnread(chatSessionId, unread);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, unread } : sess,
      ),
    }));
  },

  setSessionModel: async (chatSessionId, model) => {
    // For a harness session, a model change requires killing the running CLI
    // process: claude_code is spawned with `--model`, so the old process is
    // bound to the old model and must be respawned (the next send does that
    // via the spawned_model check, but killing here stops any in-flight work
    // immediately instead of letting it finish on the old model).
    const session = get().sessions.find((s) => s.id === chatSessionId);
    if (session && isCliAgent(session.agent) && session.model !== model) {
      try { await cancelAgentChatMessage(chatSessionId); } catch { /* best-effort */ }
    }
    await updateChatSessionModel(chatSessionId, model);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, model } : sess,
      ),
    }));
    // Keep the per-provider default in sync with explicit picks so freshly
    // created chats seed with THIS model instead of a long-stale one (the
    // auto-start path reads get_chat_config → chat.<provider>.model).
    // Skipped for harness/ACP sessions (their model ids are CLI-specific)
    // and local_gguf (its default is owned by start_local_model — it must
    // stay identical to the id llama-server was started with or sends 400).
    if (session && !isCliAgent(session.agent) && session.provider !== "local_gguf") {
      void setChatDefaultModel(session.provider, model).catch(() => {
        /* best-effort — seeding just falls back to the previous default */
      });
    }
  },

  setSessionProvider: async (chatSessionId, provider) => {
    await updateChatSessionProvider(chatSessionId, provider);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, provider } : sess,
      ),
    }));
  },

  setSessionAgent: async (chatSessionId, agent) => {
    // Switching away from a harness agent, or switching between different
    // harnesses, must kill the running CLI process — otherwise it keeps
    // executing and emitting tokens for this session.
    const prev = get().sessions.find((s) => s.id === chatSessionId);
    if (prev && isCliAgent(prev.agent) && prev.agent !== agent) {
      try { await cancelAgentChatMessage(chatSessionId); } catch { /* best-effort */ }
    }
    // Reset the per-session permission mode when the harness actually
    // CHANGES (e.g. built-in → opencode, or opencode → claude_code). The
    // session row's permission_mode label is harness-specific — Claude Code's
    // "default"/"acceptEdits" or OpenCode's "build"/"plan" are meaningless
    // outside their CLI, so reusing the previous label made the mode menu
    // show a stale posture. Switch INTO harness: start at the harness's
    // first catalog entry. Switch OUT of harness to builtin: leave the
    // built-in posture alone (the toggle stays on the same dual policies).
    let nextPermissionMode: string | null | undefined = undefined;
    let ejectToFullAuto: string | null = null;
    if (agent && agent.startsWith("harness:") && agent !== prev?.agent) {
      const harnessId = agent.slice("harness:".length);
      const catalog = HARNESS_PERMISSION_MODES[harnessId];
      nextPermissionMode = catalog?.[0]?.value ?? "default";
    } else if (agent === null && prev?.agent && prev.agent.startsWith("harness:")) {
      // Built-in sessions don't track a mode in permission_mode; the store
      // treats the built-in posture as derived from the dual policies.
      // Return to the built-in DEFAULT (full-auto), not manual — ejection
      // must not silently downgrade the session to per-action approvals.
      // Goes through setSessionPolicies (not the label-only mode setter) so
      // older sessions created before the full-auto default actually get
      // the matching policies instead of a lying label.
      ejectToFullAuto = chatSessionId;
    }
    await updateChatSessionAgent(chatSessionId, agent);
    if (ejectToFullAuto) {
      try {
        // confirmFullAccess (not setSessionPolicies): full-auto is the app
        // default, so ejecting must not pop the one-time confirmation modal.
        await get().confirmFullAccess(ejectToFullAuto);
      } catch {
        // Best-effort — agent swap still applied.
      }
    }
    if (nextPermissionMode !== undefined) {
      try {
        await setChatSessionPermissionMode(chatSessionId, nextPermissionMode);
      } catch {
        // Best-effort — agent swap still applied; the harness menu will
        // read the session row on the next render regardless.
      }
    }
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId
          ? {
              ...sess,
              agent,
              permissionMode:
                nextPermissionMode !== undefined
                  ? nextPermissionMode
                  : sess.permissionMode,
            }
          : sess,
      ),
    }));
  },

  setEffort: (effort) => set({ effort }),

  setLocalCtx: (localCtx) => set({ localCtx }),

  /** Toggle the extended-thinking flag for the next message. `null` clears
   *  the override so the provider default is used. */
  setThinking: (thinking) => set({ thinking }),

  setToolsEnabled: (toolsEnabled) =>
    set(toolsEnabled ? { toolsEnabled } : { toolsEnabled, codeExecEnabled: false }),

  // Enabling code execution implies tools are on (the tool loop must run).
  setCodeExecEnabled: (codeExecEnabled) =>
    set(codeExecEnabled ? { codeExecEnabled, toolsEnabled: true } : { codeExecEnabled }),

  sendMessage: async (content, attachments, forceResearch, sessionIdOverride) => {
    const {
      messages,
      sessions,
      effort,
      toolsEnabled,
      codeExecEnabled,
      thinking,
    } = get();
    // The split pane passes its own session id; without an override this is
    // the plain active-session send. Every reference below keys off this
    // local, so the whole action naturally targets the right session.
    const activeChatSessionId = sessionIdOverride ?? get().activeChatSessionId;
    if (!activeChatSessionId) return;
    if (deletedSessions.has(activeChatSessionId)) return;
    // A turn is already running for this session: stack the message above
    // the composer instead of dropping it. drainQueue sends the queue FIFO
    // when the current turn finishes (onDone / onError / cancelStream).
    // Per-session check (H2): concurrent sessions each own a `streaming` key,
    // and the legacy scalar may name whichever session last emitted a token —
    // gating on it would let a second turn start in an already-streaming chat.
    if (activeChatSessionId in get().streaming) {
      const queued: QueuedChatMessage = {
        id: NEXT_QUEUE_ID++,
        content,
        attachments: attachments ?? undefined,
        forceResearch: forceResearch || undefined,
      };
      set((s) => ({
        messageQueue: {
          ...s.messageQueue,
          [activeChatSessionId]: [...(s.messageQueue[activeChatSessionId] ?? []), queued],
        },
      }));
      return;
    }

    // Client-side fallback title. The LLM auto-titling in onDone
    // (generateChatTitle) silently no-ops for harness-backed sessions (no
    // stored API key) and other failure modes, leaving "Untitled Chat"
    // forever. Derive a deterministic title from the first user message
    // instead. Persisted via the same backend command renameChat uses, but
    // WITHOUT markManuallyRenamed — this is an auto title, so the turn-3
    // generateChatTitle refinement may still improve it later.
    const untitled = sessions.find((s) => s.id === activeChatSessionId);
    if (untitled && !(untitled.title ?? "").trim()) {
      const derived = generateSessionTitle(content);
      if (derived) {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === activeChatSessionId ? { ...sess, title: derived } : sess,
          ),
        }));
        void updateChatSessionTitle(activeChatSessionId, derived).catch(() => {
          /* best-effort: the local title above still stands for this run */
        });
      }
    }

    // Optimistic bubble mirrors what the backend will persist: the typed text
    // plus a compact note per attachment (the model gets the real content).
    // Optimistic bubble mirrors what the backend will persist. Mirror
    // process_attachments folding EXACTLY where the frontend can: text
    // attachments inline the body in the same fenced block the backend
    // writes, so the optimistic card even shows the same preview. Docs keep
    // the compact bracket note (extraction is backend-side) and rely on
    // mergeOptimistic's base-text twin match.
    const attachNote = (attachments ?? [])
      .map((a) => {
        if (a.kind === "image") return `\n\n[Attached image: ${a.name}]`;
        if (a.kind === "text" && a.text) {
          return `\n\nAttached file: ${a.name}\n\`\`\`\n${a.text}\n\`\`\``;
        }
        return `\n\n[Attached file: ${a.name}]`;
      })
      .join("");
    const displayContent = `${content}${attachNote}`;
    // Remember the real bytes under the persisted content so the sent message
    // keeps its image thumbnails after the optimistic bubble is swapped for
    // the persisted row (see liveAttachmentCache).
    rememberLiveAttachments(activeChatSessionId, displayContent, attachments ?? []);

    // Optimistically append the user message.
    const userMsg: ChatMessageRecord = {
      id: -Date.now(), // temporary negative id
      chatSessionId: activeChatSessionId,
      role: "user",
      content: displayContent,
      // Carry the live attachments so the bubble can render real image
      // thumbnails before the backend persists (persisted messages parse
      // attachment markers out of `content` instead).
      attachments: attachments ?? undefined,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };
    set((s) => {
      // A split-pane send (override names the split session, which is not
      // the global active one) lands in the SPLIT buffer so the main view's
      // list stays untouched; everything else appends to the active list.
      const forSplit =
        sessionIdOverride != null &&
        sessionIdOverride === s.splitChatSessionId &&
        sessionIdOverride !== s.activeChatSessionId;
      // A fresh turn supersedes any stop-marker for this session.
      const stoppedPartial = { ...s.stoppedPartial };
      delete stoppedPartial[activeChatSessionId];
      return {
        messages: forSplit ? s.messages : [...messages, userMsg],
        splitMessages: forSplit ? [...s.splitMessages, userMsg] : s.splitMessages,
        streamingChatSessionId: activeChatSessionId,
        streaming: { ...get().streaming, [activeChatSessionId]: "" },
        chatStatus: { ...get().chatStatus, [activeChatSessionId]: { reason: "thinking", message: "" } },
        // Start a fresh artifact buffer for this turn.
        pendingArtifacts: { ...get().pendingArtifacts, [activeChatSessionId]: [] },
        stoppedPartial,
        error: null,
        errorCode: null,
      };
    });

    // Bump the session to top of the list. Re-read from state rather than
    // using the `sessions` snapshot — the derived-title set() above may
    // already have updated this session's entry.
    const active = get().sessions.find((s) => s.id === activeChatSessionId);
    if (active) {
      set((s) => ({
        sessions: sortSessions([
          active,
          ...s.sessions.filter((sess) => sess.id !== activeChatSessionId),
        ]),
      }));
    }

    const session = get().sessions.find((s) => s.id === activeChatSessionId);

    // Working folder resolution, shared by both send paths: a custom folder
    // from the composer "+" picker wins, then the chat's isolated worktree
    // (roadmap P0 §3.1.1), then the chat's explicitly bound project. This is
    // read-only — browsing a project does NOT rebind the chat to it (binding
    // is explicit; see newChat and unbindProject). A brand-new chat has no
    // binding and NO working directory: it runs in the app's default
    // directory, NOT the previously-selected project — clicking a project in
    // the sidebar must never silently scope a fresh chat to it.
    const projectsState = useProjectsStore.getState();
    const boundProject = projectsState.projectById(
      get().sessionProjects[activeChatSessionId],
    );
    const workingDir =
      get().cwdOverrides[activeChatSessionId] ??
      session?.worktreePath ??
      boundProject?.path;

    // CLI harness / ACP agents (Phase 2 + roadmap #20): the turn goes to the
    // headless CLI process (agent_sessions.rs) instead of the built-in
    // provider path. Same chat:* events come back, so streaming/done handling
    // above works unchanged.
    if (session && isCliAgent(session.agent)) {
      const projects = useProjectsStore.getState();
      const cwd = workingDir;
      try {
        await sendAgentChatMessage(
          activeChatSessionId,
          content,
          cliAgentId(session.agent),
          session.model || undefined,
          cwd,
          // Feeds the conduit-browser MCP registration (CONDUIT_PROJECT_ID) so
          // browser auto-open is scoped to the selected project.
          projects.selectedProjectId ?? undefined,
          // Attachments ride along: the backend folds display markers +
          // extracted doc text into the persisted message and saves image/
          // doc bytes to disk paths the CLI's own file tools can open.
          attachments ?? undefined,
        );
      } catch (err) {
        console.error('[agent] sendAgentChatMessage failed:', err);
        // Delete the keys (not `undefined` assignments — those keep the key
        // present, so `sid in streaming` stays true and the sidebar "Working…"
        // dot never clears; it also breaks the Record<string, string> type).
        const streaming = { ...get().streaming };
        const chatStatus = { ...get().chatStatus };
        delete streaming[activeChatSessionId];
        delete chatStatus[activeChatSessionId];
        set({
          streamingChatSessionId: null,
          streaming,
          chatStatus,
          error: String(err),
          errorCode: null,
        });
        return;
      }
      return;
    }

    // The built-in path can reject synchronously (unknown session/provider,
    // local-model warmup failure) before any chat:error event exists. Without
    // a catch the session wedges: streamingChatSessionId stays set, the
    // double-send guard blocks every later send, and the user stares at a
    // permanent "thinking" spinner with no error. Mirror the harness reset.
    try {
      await sendChatMessage(
        activeChatSessionId,
        content,
        effort || undefined,
        toolsEnabled,
        codeExecEnabled,
        attachments,
        forceResearch,
        thinking === null ? undefined : thinking,
        // Working folder for this chat (custom folder → bound project →
        // global selection, resolved above). The backend grants it as an
        // fs_root AND names it in the system prompt so the model knows
        // which directory it is working in.
        workingDir,
      );
    } catch (err) {
      console.error('[chat] sendChatMessage failed:', err);
      const streaming = { ...get().streaming };
      const chatStatus = { ...get().chatStatus };
      delete streaming[activeChatSessionId];
      delete chatStatus[activeChatSessionId];
      set({
        streamingChatSessionId: null,
        streaming,
        chatStatus,
        error: String(err),
        errorCode: null,
      });
    }
  },

  // Team broadcast (roadmap #18): one prompt to N sessions. The active session
  // reuses sendMessage (optimistic bubble + queue rules); background sessions
  // get a direct send — streaming state is session-keyed so they run
  // concurrently and each sidebar row shows its own working dot.
  broadcastToSessions: async (sessionIds, content, forceResearch) => {
    const state = get();
    const targets = sessionIds.filter(
      (id) => state.sessions.some((s) => s.id === id) && !(id in state.streaming),
    );
    if (targets.length === 0) return;

    const activeId = get().activeChatSessionId;
    const projectsState = useProjectsStore.getState();

    for (const sid of targets) {
      if (sid === activeId) {
        // Active session: full optimistic path.
        await get().sendMessage(content, undefined, forceResearch);
        continue;
      }
      // Background session: mark it streaming and fire the send directly.
      // No optimistic bubble — `messages` only holds the active session's
      // list; the persisted user row will appear when the session is opened.
      const session = get().sessions.find((s) => s.id === sid);
      if (!session) continue;
      set((s) => ({
        streaming: { ...s.streaming, [sid]: "" },
        chatStatus: { ...s.chatStatus, [sid]: { reason: "thinking", message: "" } },
        pendingArtifacts: { ...s.pendingArtifacts, [sid]: [] },
      }));
      // Same resolution as sendMessage: explicit binding only — an unbound
      // (fresh) chat runs in the app's default directory, never the
      // previously-selected project.
      const boundProject = projectsState.projectById(
        get().sessionProjects[sid],
      );
      const workingDir =
        get().cwdOverrides[sid] ?? session.worktreePath ?? boundProject?.path;
      try {
        if (isCliAgent(session.agent)) {
          await sendAgentChatMessage(
            sid,
            content,
            cliAgentId(session.agent),
            session.model || undefined,
            workingDir,
            projectsState.selectedProjectId ?? undefined,
          );
        } else {
          // Pass the store's tool flags (audit B-22): ipc.ts maps omitted
          // flags to false, which silently ran every background turn with
          // tools off. Same values the single-session sendMessage path uses.
          await sendChatMessage(
            sid,
            content,
            undefined,
            state.toolsEnabled,
            state.codeExecEnabled,
            undefined,
            forceResearch,
            undefined,
            workingDir,
          );
        }
      } catch (err) {
        // Clear this session's streaming state so its dot doesn't wedge.
        set((s) => {
          const streaming = { ...s.streaming };
          const chatStatus = { ...s.chatStatus };
          delete streaming[sid];
          delete chatStatus[sid];
          return { streaming, chatStatus };
        });
        toastError(`Broadcast to "${session.title ?? sid}" failed`, err);
      }
    }
  },
  // Regenerate resends the most recent user message. The backend appends a
  // new assistant turn (history is rebuilt from the DB each send).
  //
  // IMPORTANT: the bubble's `content` may contain "[Attached image: …]" /
  // "[Attached file: …]" markers that the UI injected for display purposes
  // only. Re-sending those markers would let the model misinterpret them as
  // fresh attachments and try to process nonexistent files. Strip them so
  // the regenerated turn mirrors what the BACKEND actually persisted.
  // Re-run the last user message to get a fresh assistant response. This is
  // branch-aware (roadmap #9): it retires the current tail first, so the model
  // doesn't keep seeing the stale answer being regenerated.
  regenerate: async (sessionIdOverride) => {
    const activeChatSessionId = sessionIdOverride ?? get().activeChatSessionId;
    const list =
      activeChatSessionId === get().splitChatSessionId && activeChatSessionId !== get().activeChatSessionId
        ? get().splitMessages
        : get().messages;
    // Don't regenerate mid-stream — per-session check (the legacy scalar can
    // name a different concurrently-streaming chat, which used to block
    // regenerate in an idle chat or allow it mid-stream in this one).
    if (activeChatSessionId && activeChatSessionId in get().streaming) return;
    const active = list.filter((m) => !m.supersededBy);
    const lastUser = [...active].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const clean = lastUser.content.replace(/\n\n\[Attached (?:image|file):[^\n]*\]/g, "");
    try {
      await supersedeChatTail(lastUser.id);
      if (activeChatSessionId) await get().reloadFor(activeChatSessionId);
      // No override → call without the extra args (keeps the plain
      // active-session send path byte-identical for tests and logging).
      if (sessionIdOverride) await get().sendMessage(clean, undefined, undefined, sessionIdOverride);
      else await get().sendMessage(clean);
    } catch (err) {
      toastError("Regenerate failed", err);
    }
  },

  // Edit-to-fork (roadmap #9): retire the branch at `messageId`, reload the
  // active message list, then send the edited text as a fresh turn. The old
  // branch stays in the timeline (dimmed) but no longer feeds the model.
  editMessage: async (messageId, newContent, sessionIdOverride) => {
    const activeChatSessionId = sessionIdOverride ?? get().activeChatSessionId;
    // Per-session streaming guard (same reasoning as regenerate above).
    if (!activeChatSessionId || activeChatSessionId in get().streaming) return;
    try {
      await supersedeChatTail(messageId);
      if (activeChatSessionId) await get().reloadFor(activeChatSessionId);
      // Send the edited text as a new turn (override only when present —
      // keeps the plain active-session call shape for the branch tests).
      if (sessionIdOverride) await get().sendMessage(newContent, undefined, undefined, sessionIdOverride);
      else await get().sendMessage(newContent);
    } catch (err) {
      toastError("Failed to edit message", err);
    }
  },

  // Delete a single chat message by id. Optimistically removes the bubble
  // from the active session's message list, then asks the backend to
  // confirm. Persisted artifacts attributed to the message are detached
  // server-side (not deleted) so a user wiping a turn doesn't lose their
  // generated files — the artifact library still lists them.
  deleteMessage: async (messageId, sessionIdOverride) => {
    const activeChatSessionId = sessionIdOverride ?? get().activeChatSessionId;
    const inSplit =
      activeChatSessionId === get().splitChatSessionId && activeChatSessionId !== get().activeChatSessionId;
    set((s) => {
      // Drop the bubble from the list that shows it. Negative ids are
      // optimistic just-sent bubbles that never round-tripped to the DB, so
      // a missing match here is fine — the local filter simply doesn't
      // remove anything.
      const drop = (list: ChatMessageRecord[]) => list.filter((m) => m.id !== messageId);
      if (inSplit) {
        const nextSplit = drop(s.splitMessages);
        if (nextSplit.length !== s.splitMessages.length) {
          const nextByMessage = { ...s.artifactsByMessage };
          delete nextByMessage[messageId];
          return { splitMessages: nextSplit, artifactsByMessage: nextByMessage };
        }
        return {};
      }
      const nextMessages = drop(s.messages);
      // If the deleted message had attributed artifacts, clear the local
      // attribution map. The artifact rows/files stay (the backend detaches
      // them, not deletes) but the per-message chip row is gone.
      if (nextMessages.length !== s.messages.length) {
        const nextByMessage = { ...s.artifactsByMessage };
        delete nextByMessage[messageId];
        return { messages: nextMessages, artifactsByMessage: nextByMessage };
      }
      return {};
    });
    try {
      await deleteChatMessage(messageId);
    } catch (err) {
      // Rollback: the backend rejected the delete (e.g. DB error, or the row
      // was already gone via another path). Re-fetch so the local list
      // matches persisted state instead of staying out of sync.
      toastError("Couldn't delete the message", err);
      if (activeChatSessionId) {
        try {
          // Same 200-row page cap as loadMessages (M10 / audit B-23) — the
          // rollback refetch must not pull the full history.
          const msgs = await getChatMessages(activeChatSessionId, undefined, 200);
          if (inSplit)
            set({
              splitMessages: msgs ?? [],
              splitMessagesSessionId: activeChatSessionId,
              splitHasMoreHistory: (msgs?.length ?? 0) >= 200,
            });
          else
            set({
              messages: msgs ?? [],
              messagesSessionId: activeChatSessionId,
              hasMoreHistory: (msgs?.length ?? 0) >= 200,
            });
        } catch {
          /* best-effort rollback */
        }
      }
    }
  },

  setPreviewArtifact: (artifact) => {
    // Every artifact preview opens as its own named tab in the tool panel
    // (the Canvas tab is gone). openArtifactTab dedupes by path and expands
    // the panel; null is a no-op kept for call-site compatibility.
    if (!artifact) return;
    useUiStore.getState().openArtifactTab({
      path: artifact.path,
      filename: artifact.filename,
      inline: artifact.inline,
    });
  },

  addArtifactProposal: (chatSessionId, proposal) =>
    set((s) => ({
      artifactProposals: {
        ...s.artifactProposals,
        [chatSessionId]: [
          ...(s.artifactProposals[chatSessionId] ?? []),
          { id: proposal.id, proposal, state: "generating" as const },
        ],
      },
    })),

  updateArtifactProposal: (chatSessionId, proposalId, updates) => {
      // If the proposal was replaced, update the wrapper ID to match
      // so subsequent handlers find the correct entry by the same ID.
      // This stabilizes the ID across regenerations and prevents
      // "handler finds nothing" bugs when backend returns a new proposal.id.
      return set((s) => {
        const proposals = s.artifactProposals[chatSessionId] ?? [];
        let idx = proposals.findIndex((p) => p.id === proposalId);
        // If not found by wrapper ID, try finding by proposal.id (backend ID)
        const replacementProposal = updates.proposal;
        if (idx < 0 && replacementProposal) {
          idx = proposals.findIndex((p) => p.proposal.id === replacementProposal.id);
        }
        if (idx < 0) return s;
        const oldEntry = proposals[idx];
        let updated: typeof oldEntry;
        if (updates.proposal) {
          // Proposal was replaced — keep the old wrapper.id stable (it is the card's action key),
          // only swap the proposal.payload. This ensures the card's `proposalId` prop still
          // matches the wrapper ID, and all handlers work correctly.
          updated = {
            id: oldEntry.id, // stable wrapper ID (card's action key)
            proposal: updates.proposal,
            state: updates.state ?? oldEntry.state,
          };
        } else {
          updated = { ...oldEntry, ...updates };
        }
        return {
          artifactProposals: {
            ...s.artifactProposals,
            [chatSessionId]: [
              ...proposals.slice(0, idx),
              updated,
              ...proposals.slice(idx + 1),
            ],
          },
        };
      });
    },

  removeArtifactProposal: (chatSessionId, proposalId) =>
    set((s) => {
      const proposals = s.artifactProposals[chatSessionId] ?? [];
      const filtered = proposals.filter((p) => p.id !== proposalId);
      if (filtered.length === proposals.length) return s;
      return {
        artifactProposals: {
          ...s.artifactProposals,
          [chatSessionId]: filtered,
        },
      };
    }),

  getArtifactProposals: (chatSessionId) => {
    return get().artifactProposals[chatSessionId] ?? [];
  },

  editArtifactProposal: (chatSessionId, proposalId, proposal) => {
    const { artifactType, spec } = proposal;
    const ui = useUiStore.getState();
    // Set the pending form data that SkillsLibrary/AutomationsView will read on mount.
    // Carry the session/proposal IDs so the editor can reset the card's `editing`
    // state back to `ready` after consuming the data — otherwise the card stays
    // stuck on "Opening in editor…" when the user navigates back to chat.
    ui.setPendingArtifactFormData({ artifactType, spec, chatSessionId, proposalId });
    // Update proposal state
    set((s) => ({
      artifactProposals: {
        ...s.artifactProposals,
        [chatSessionId]: (s.artifactProposals[chatSessionId] ?? []).map((p) =>
          p.id === proposalId ? { ...p, state: "editing" as const } : p
        ),
      },
    }));
    // Navigate to the appropriate editor
    switch (artifactType) {
      case "skill":
      case "loop":
        ui.setActiveView("skills");
        break;
      case "prompt_template":
        ui.setActiveView("skills");
        break;
      case "automation":
        ui.setActiveView("automations");
        break;
    }
  },

  setSessionWatchMode: async (chatSessionId, mode) => {
    await updateChatSessionWatchMode(chatSessionId, mode);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, watchMode: mode } : sess,
      ),
    }));
  },

  setSessionPolicies: async (chatSessionId, sandbox, approval) => {
    // Switching INTO full_access approval opens a one-time confirmation modal
    // first (per session — `fullAccessConfirmed` suppresses re-prompting within
    // the same app run). All other transitions apply immediately.
    if (approval === "full_access" && !fullAccessConfirmed.has(chatSessionId)) {
      set({ fullAccessConfirmingFor: chatSessionId });
      return false;
    }
    await updateChatSessionPolicies(chatSessionId, sandbox, approval);
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId
          ? {
              ...sess,
              sandboxPolicy: sandbox,
              approvalPolicy: approval,
              // Legacy field kept in sync for components still reading it.
              permissionMode: policiesToPermissionMode(sandbox, approval),
            }
          : sess,
      ),
      fullAccessConfirmingFor: null,
    }));
    return true;
  },

  confirmFullAccess: async (chatSessionId) => {
    markFullAccessConfirmed(chatSessionId);
    await updateChatSessionPolicies(chatSessionId, "workspace_write", "full_access");
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId
          ? {
              ...sess,
              sandboxPolicy: "workspace_write",
              approvalPolicy: "full_access",
              permissionMode: "full_auto",
            }
          : sess,
      ),
      fullAccessConfirmingFor: null,
    }));
  },

  cancelFullAccessConfirm: () => set({ fullAccessConfirmingFor: null }),

  resolveApproval: async (chatSessionId, approved) => {
    const pending = get().pendingApprovals[chatSessionId];
    if (!pending) return;
    // Optimistically remove the card; the backend's `chat:approval-resolved`
    // would also clear it, but this avoids a flicker if the event is slow.
    set((s) => {
      const next = { ...s.pendingApprovals };
      delete next[chatSessionId];
      return { pendingApprovals: next };
    });
    try {
      await resolveToolAction(pending.pendingId, approved);
    } catch (err) {
      // The backend tool loop is still paused waiting for a resolution — if
      // this IPC call failed the turn would hang forever with no card to
      // retry. Put the card back and surface the failure (audit M3).
      set((s) => ({
        pendingApprovals: { ...s.pendingApprovals, [chatSessionId]: pending },
      }));
      toastError("Couldn't deliver the approval decision", err);
    }
  },

  setOwnerSessionId: (chatSessionId, ownerSessionId) =>
    set((s) => ({
      ownerSessionByChatId: { ...s.ownerSessionByChatId, [chatSessionId]: ownerSessionId },
    })),

  getOwnerSessionId: (chatSessionId) => get().ownerSessionByChatId[chatSessionId],

  cancelStream: async (sessionIdOverride) => {
    // Cancel the session the calling view is showing (the active one by
    // default, the split pane's session via the override). The legacy scalar
    // names whichever session last emitted a token — with concurrent streams
    // it could point at a background chat, cancelling the wrong turn (or
    // no-op when it's null before the first token lands).
    const activeChatSessionId = sessionIdOverride ?? get().activeChatSessionId;
    if (activeChatSessionId && activeChatSessionId in get().streaming) {
      const streamingChatSessionId = activeChatSessionId;
      const session = get().sessions.find((s) => s.id === streamingChatSessionId);
      // Persist the partial reply BEFORE cancelling: the backend's abort path
      // discards its accumulated buffer, and the streaming buffer here holds
      // exactly the text the user already saw. Best-effort — a cancel with no
      // streamed tokens writes nothing (the backend no-ops on empty).
      const partial = get().streaming[streamingChatSessionId] ?? "";
      if (partial.trim().length > 0) {
        try {
          await persistPartialChatMessage(streamingChatSessionId, partial);
        } catch {
          /* best-effort: the cancel itself still proceeds */
        }
      }
      if (isCliAgent(session?.agent)) {
        await cancelAgentChatMessage(streamingChatSessionId);
      } else {
        await cancelChatMessage(streamingChatSessionId);
      }
      // The backend's builtin-stream cancel is `handle.abort()` — the
      // chat:done / chat:error emits live INSIDE the aborted task, so no
      // terminal event ever arrives for this session. Clear the per-session
      // streaming state here (not just the scalar), or the sidebar "working"
      // dot sticks forever. (Harness cancels DO emit terminal events, but
      // clearing early is harmless: onDone tolerates a missing key.)
      // Also clear livePerf so the next turn starts its timer from 0, not
      // the cancelled turn's elapsed time (regression: stale timer).
      set((s) => {
        const nextStreaming = { ...s.streaming };
        delete nextStreaming[streamingChatSessionId];
        const nextStatus = { ...s.chatStatus };
        delete nextStatus[streamingChatSessionId];
        const nextLivePerf = { ...s.livePerf };
        delete nextLivePerf[streamingChatSessionId];
        // Remember WHAT the stopped turn had produced (matches the persisted
        // partial row's content) so that bubble keeps its process section
        // expanded instead of collapsing to an empty "Worked" row.
        const nextStopped = { ...s.stoppedPartial };
        if (partial.trim().length > 0) {
          nextStopped[streamingChatSessionId] = partial.trim();
        } else {
          delete nextStopped[streamingChatSessionId];
        }
        return {
          streamingChatSessionId: null,
          streaming: nextStreaming,
          chatStatus: nextStatus,
          livePerf: nextLivePerf,
          stoppedPartial: nextStopped,
        };
      });
      // A cancelled turn frees the queue too — send the next stacked message.
      get().drainQueue(streamingChatSessionId);
      // User hit Stop: disarm any active goal loop so it doesn't resume on the
      // next turn.
      const loop = get().loopState[streamingChatSessionId];
      if (loop && loop.active) {
        if (loop.backendId) void loopSessionFinish(loop.backendId, "stopped").catch(() => {});
        set((s) => ({
          loopState: {
            ...s.loopState,
            [streamingChatSessionId]: { ...loop, active: false },
          },
        }));
      }
      // The cancel path never emits a terminal event, so the session's open
      // artifact runs would stay open forever — close them as abandoned.
      void finishArtifactRuns(streamingChatSessionId, "abandoned").catch(() => {});
      // Refresh the message list so the persisted partial shows up inline.
      // mergeOptimistic keeps the just-drained queued message's bubble: the
      // refetch snapshot can predate that send's DB persist.
      try {
        // Same 200-row page cap as loadMessages (M10 / audit B-23): the
        // unbounded refetch deserialized the FULL history and desynced
        // hasMoreHistory. The guard above already scoped this write to the
        // active session, so the flag follows the buffer it feeds.
        const messages = await getChatMessages(streamingChatSessionId, undefined, 200);
        if (messages && get().activeChatSessionId === streamingChatSessionId) {
          set((s) => ({
            messages: mergeOptimistic(s.messages, messages),
            messagesSessionId: streamingChatSessionId,
            hasMoreHistory: messages.length >= 200,
          }));
        }
      } catch {
        /* best-effort refresh */
      }
    }
  },

  saveApiKey: async (provider, key, baseUrl, model) => {
    await setChatApiKey(provider, key, baseUrl, model);
    // Refresh config for the SPECIFIC provider that was just saved, so the
    // API Keys panel sees hasKey: true for the currently selected provider.
    const config = await getChatConfig(provider);
    set({ config });
  },

  clearApiKey: async (provider) => {
    await deleteChatApiKey(provider);
    const config = await getChatConfig(provider);
    set({ config });
  },

  // ---- Event handlers (called by useChatEvents) ----

  // Backend-initiated turn lifecycle (automation runs). These mirror the
  // pre-create/cleanup sendMessage does around its own turns so the same
  // streaming machinery — and onToken's straggler guard — applies unchanged.
  beginRemoteTurn: (chatSessionId) => {
    set((s) => {
      // Never clobber a live entry: a user-initiated send to this session
      // (or a previous run-started event) owns the existing buffer.
      if (chatSessionId in s.streaming) return s;
      return {
        streaming: { ...s.streaming, [chatSessionId]: "" },
        streamingChatSessionId: chatSessionId,
      };
    });
  },

  endRemoteTurn: async (chatSessionId) => {
    // The harness path's chat:done may have cleaned up already; only act
    // when a streaming entry survived (provider one-shots emit no terminal
    // chat event, and failure paths can die before emitting one).
    if (!(chatSessionId in get().streaming)) return;
    set((s) => {
      const nextStreaming = { ...s.streaming };
      delete nextStreaming[chatSessionId];
      const nextStatus = { ...s.chatStatus };
      delete nextStatus[chatSessionId];
      return {
        streaming: nextStreaming,
        chatStatus: nextStatus,
        streamingChatSessionId:
          s.streamingChatSessionId === chatSessionId ? null : s.streamingChatSessionId,
      };
    });
    // Surface the persisted reply: an active viewer refetches the page;
    // everyone else gets the unread mark (same posture as onDone).
    if (get().activeChatSessionId !== chatSessionId) {
      void setChatSessionUnread(chatSessionId, true).catch(() => {});
      return;
    }
    try {
      const messages = await getChatMessages(chatSessionId, undefined, 200);
      if (get().activeChatSessionId === chatSessionId && !(chatSessionId in get().streaming)) {
        set({
          messages: mergeOptimistic(get().messages, messages ?? []),
          messagesSessionId: chatSessionId,
        });
      }
    } catch {
      /* best-effort: the sidebar relist picks it up on the next interaction */
    }
  },

  onToken: (chatSessionId, token) => {
    // Ignore stragglers (same guard as onPerf): a token emitted just before
    // an abort can cross IPC AFTER done/cancel/error cleared the entry, and
    // the write below would resurrect the key — a stuck "working" dot until
    // the next terminal event. Safe to early-out because onToken never
    // CREATES the turn's entry: sendMessage and broadcastToSessions
    // pre-create it (as "") before the first token can arrive.
    if (!(chatSessionId in get().streaming)) return;
    set((s) => {
      const nextStatus = { ...s.chatStatus };
      delete nextStatus[chatSessionId];
      const prev = s.streaming[chatSessionId] ?? "";
      // Cap the streaming buffer to 200KB per session to avoid OOM on
      // extremely long streaming turns (hundreds of thousands of tokens).
      // The tail is what matters for rendering; anything beyond ~50K chars
      // is scrolled out of view already. Code-point-safe: a raw slice can
      // split an emoji surrogate pair at the cap boundary.
      const next = tailCodePoints(prev + token, 200_000);
      return {
        streaming: {
          ...s.streaming,
          [chatSessionId]: next,
        },
        // First token arrived — drop any pre-token status notice (e.g. the
        // "local model loading" line) since the wait is over.
        chatStatus: nextStatus,
        // The session is actively streaming — the sidebar's "working" dot is
        // driven by this flag. Don't change it if the streaming session is
        // the one the user is currently viewing; switching away keeps it set
        // so the sidebar shows the streaming session is still in progress.
        streamingChatSessionId: chatSessionId,
      };
    });
  },

  onStatus: (chatSessionId, reason, message) => {
    set((s) => {
      // An empty reason is the backend's "clear this notice" signal — used
      // when compaction was a no-op or errored so the "Compacting earlier
      // context…" spinner doesn't linger past the chat:done.
      if (!reason) {
        const next = { ...s.chatStatus };
        delete next[chatSessionId];
        return { chatStatus: next };
      }
      // A compaction that actually shortened the history triggers an
      // immediate re-poll of the context meter so the ring ticks down
      // right away. We bump `compactionRevision` only for the active
      // session — other sessions' compactions shouldn't churn this.
      const compactionBump =
        reason === "context_compacted" && s.activeChatSessionId === chatSessionId
          ? { compactionRevision: s.compactionRevision + 1 }
          : {};
      return {
        chatStatus: { ...s.chatStatus, [chatSessionId]: { reason, message } },
        ...compactionBump,
      };
    });
  },

  onDone: async (chatSessionId, inputTokens, outputTokens, costUsd, llmTimeMs, toolTimeMs, ttftMs, tokensPerSecond, cacheHitRate) => {
    // A reply that lands while the user is viewing a different chat marks the
    // finished one unread, so it surfaces in the sidebar. Best-effort: this
    // handler must ALWAYS reach the streaming-state cleanup below — an
    // awaited IPC rejection here would wedge the session in "working" state.
    if (get().activeChatSessionId !== chatSessionId) {
      void setChatSessionUnread(chatSessionId, true).catch(() => {});
    }
    // Capture the finished turn's final metrics for the composer's idle row
    // BEFORE the live snapshot is cleared below — the idle row shows the last
    // turn's numbers (matching the "Worked for Xs" just watched) instead of
    // the session aggregate, which sums every turn and is empty for providers
    // that don't write cost events.
    const finalLive = get().livePerf[chatSessionId];
    const lastTurn: LastTurnMetrics = {
      llmTimeMs: llmTimeMs ?? finalLive?.llmTimeMs ?? 0,
      toolTimeMs: toolTimeMs ?? finalLive?.toolTimeMs ?? 0,
      ttftMs: ttftMs ?? finalLive?.ttftMs ?? null,
      tokensPerSecond: tokensPerSecond ?? finalLive?.tokensPerSecond ?? null,
      outputTokens: outputTokens ?? finalLive?.outputTokens ?? 0,
      inputTokens: inputTokens ?? null,
      cacheHitRate: cacheHitRate ?? null,
      elapsedMs: finalLive?.elapsedMs ?? null,
    };

    // Clear streaming + live-perf state for this session.
    set((s) => {
      const nextStreaming = { ...s.streaming };
      delete nextStreaming[chatSessionId];
      const nextStatus = { ...s.chatStatus };
      delete nextStatus[chatSessionId];
      const livePerf = { ...s.livePerf };
      delete livePerf[chatSessionId];
      // A turn can only complete after its question was answered, but a
      // CANCELLED turn drops the pending on the backend without a resolved
      // event — clear any stale card here so cancel never leaves one stuck.
      const pendingQuestions = { ...s.pendingQuestions };
      delete pendingQuestions[chatSessionId];
      return {
        streaming: nextStreaming,
        chatStatus: nextStatus,
        livePerf,
        pendingQuestions,
        lastTurnPerf: { ...s.lastTurnPerf, [chatSessionId]: lastTurn },
        streamingChatSessionId:
          s.streamingChatSessionId === chatSessionId ? null : s.streamingChatSessionId,
      };
    });

    // Refetch messages from the backend to get the final persisted
    // ChatMessageRecord with usage data. Best-effort: a transient IPC/DB
    // failure must not skip the title refresh + relist below. Same 200-row
    // page cap as loadMessages (M10): replacing the capped page with the
    // FULL history on every completed turn re-rendered huge sessions and
    // defeated pagination. The title logic only needs the young-session
    // turn counts (1 or 3), which always fit inside the latest page.
    let messages: ChatMessageRecord[] | null = null;
    try {
      messages = await getChatMessages(chatSessionId, undefined, 200);
    } catch {
      /* keep null; downstream guards handle it */
    }

    // Auto-summarize the chat title after the 1st completed turn (a quick
    // first guess) and refine it after the 3rd, unless the user renamed it.
    const assistantTurns = (messages ?? []).filter((m) => m.role === "assistant").length;
    if (
      !manuallyRenamed.has(chatSessionId) &&
      (assistantTurns === 1 || assistantTurns === 3)
    ) {
      void generateChatTitle(chatSessionId)
        .then((title) => {
          if (!title) return;
          set((s) => ({
            sessions: sortSessions(
              s.sessions.map((sess) =>
                sess.id === chatSessionId ? { ...sess, title } : sess,
              ),
            ),
          }));
        })
        .catch(() => {
          /* best-effort: keep the existing title on failure */
        });
    }

    if (messages) {
      set((s) => {
        // Attribute the artifacts produced during this turn to the assistant
        // message that just completed (the last assistant record). This must
        // run even when the user is viewing a DIFFERENT chat: artifactsByMessage
        // is keyed by the persisted message id (globally unique), so the chips
        // will be there when the user opens that session — previously they were
        // silently discarded while the pending buffer was cleared regardless.
        // Only the flat `messages` buffer (the active session's list) stays
        // gated on the active session so two sessions finishing simultaneously
        // don't cross-contaminate.
        const isActiveSession = s.activeChatSessionId === chatSessionId;
        const isSplitTarget = s.splitChatSessionId === chatSessionId && !isActiveSession;
        const pending = s.pendingArtifacts[chatSessionId] ?? [];
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        const artifactsByMessage =
          pending.length > 0 && lastAssistant
            ? { ...s.artifactsByMessage, [lastAssistant.id]: pending }
            : s.artifactsByMessage;
        const nextPending = { ...s.pendingArtifacts };
        delete nextPending[chatSessionId];
        return {
          messages: isActiveSession ? mergeOptimistic(s.messages, messages) : s.messages,
          messagesSessionId: isActiveSession ? chatSessionId : s.messagesSessionId,
          hasMoreHistory: isActiveSession
            ? messages.length >= 200
            : s.hasMoreHistory,
          // The split pane gets the same final-rows write-back for its own
          // session so its history updates in place — no reload needed.
          splitMessages: isSplitTarget ? mergeOptimistic(s.splitMessages, messages) : s.splitMessages,
          splitMessagesSessionId: isSplitTarget ? chatSessionId : s.splitMessagesSessionId,
          splitHasMoreHistory: isSplitTarget ? messages.length >= 200 : s.splitHasMoreHistory,
          artifactsByMessage,
          pendingArtifacts: nextPending,
        };
      });
    }

    // Refresh the session list (title may have been updated by the backend).
    // Also re-seed sessionProjects from the refreshed sessions so any
    // project-bound chats stay nested under their project after onDone.
    // Best-effort: a rejection here must not abort onDone before the queue
    // drain + goal-loop advance below (that stranded queued messages until
    // the user manually sent).
    try {
      const sessions = await listChatSessions();
      if (sessions) {
        const clean = withoutDeleted(sessions);
        const nextProjects = { ...get().sessionProjects };
        for (const s of clean) {
          if (s.projectId) nextProjects[s.id] = s.projectId;
        }
        set({ sessions: clean, sessionProjects: nextProjects });
      }
    } catch {
      /* best-effort relist */
    }
    // Turn finished — send the next queued message, if any (FIFO).
    get().drainQueue(chatSessionId);
    // Artifact telemetry (SELF_IMPROVING_ARTIFACTS.md §5): the turn ended
    // cleanly, so any skill/template runs opened for this session count as
    // applied. No-op when the turn used no tracked artifact.
    void finishArtifactRuns(chatSessionId, "applied").catch(() => {});
    // Goal-loop (/goal / /loop): if the loop is armed for this session and
    // drainQueue didn't already start a new turn (no queued user messages),
    // inspect the just-finished assistant reply and, on `continue`, auto-issue
    // the next iteration. Pauses if the user switched away (active-session
    // guard), and never fires while THIS session already has another turn
    // running (per-session check — a background chat streaming elsewhere
    // must not stall the loop).
    if (get().activeChatSessionId === chatSessionId && !(chatSessionId in get().streaming)) {
      const loop = get().loopState[chatSessionId];
      if (loop && loop.active) {
        const lastReply = [...(get().messages ?? [])]
          .reverse()
          .find((m) => m.role === "assistant")?.content ?? "";
        const decision = get().advanceLoop(chatSessionId, lastReply);
        if (decision === "continue") {
          const next = loop.iteration + 1; // advanceLoop already ticked it
          const body =
            `[loop iteration ${next}/${loop.max}] Continue working toward the goal ` +
            `"${loop.goal}". Do exactly the next work that remains (per your previous ` +
            `STATUS line), then end with a single LOOP_STATUS: line as instructed.`;
          // Defer one tick so any synchronous onDone cleanup (set calls above)
          // commits before sendMessage re-enters the streaming path.
          void Promise.resolve().then(() => get().sendMessage(body));
        }
      }
    }
    // Refresh the session's aggregate metrics (turn added to the totals).
    void get().loadSessionMetrics(chatSessionId);
  },

  onArtifact: ({ chatSessionId, path, filename }) => {
    const artifact = { path, filename };
    const ext = filename.split(".").pop()?.toLowerCase();
    // Track the artifact regardless of where it opens.
    set((s) => {
      const existing = s.artifacts[chatSessionId] ?? [];
      const alreadyTracked = existing.some((a) => a.path === path);
      const pending = s.pendingArtifacts[chatSessionId] ?? [];
      const pendingTracked = pending.some((a) => a.path === path);
      return {
        artifacts: alreadyTracked
          ? s.artifacts
          : { ...s.artifacts, [chatSessionId]: [...existing, artifact] },
        pendingArtifacts: pendingTracked
          ? s.pendingArtifacts
          : { ...s.pendingArtifacts, [chatSessionId]: [...pending, artifact] },
      };
    });
    void useArtifactsStore.getState().load();

    // SVG renders inline in the chat bubble — no pane, no browser.
    if (ext === "svg") return;

    // Only viewable deliverables (images/pdf/office/csv) open as their own
    // top-level tab in the right-side tool panel. Source-code writes
    // (html/tsx/jsx/…) stay in the Artifacts gallery; the agent opens them
    // deliberately via `open_file` when the user actually needs to see one.
    if (!AUTO_OPEN_ARTIFACT_EXTS.has(ext ?? "")) return;

    // Images, pdf, csv, office docs render in ArtifactPreviewPane, with the
    // filename as the tab label.
    const ui = useUiStore.getState();
    ui.openArtifactTab({ path, filename });
    ui.setToolPanelCollapsed(false);
  },

  onCheckpointCreated: (payload) => {
    // Baselines / safety snapshots (messageId null) have no bubble to hang a
    // chip on — they sit in the backend timeline until a restore needs them.
    const mid = payload.messageId;
    if (mid == null) return;
    set((s) => {
      const existing = s.checkpointsByMessage[mid] ?? [];
      if (existing.some((c) => c.id === payload.id)) return {};
      return {
        checkpointsByMessage: { ...s.checkpointsByMessage, [mid]: [...existing, payload] },
      };
    });
  },

  onApprovalRequest: ({ chatSessionId, pendingId, tool, summary, args }) => {
    // Surface the per-action approval card for this session. Only one card is
    // shown at a time (the tool loop pauses on it); a new request replaces any
    // stale one (the prior would already have been resolved or cancelled).
    set((s) => ({
      pendingApprovals: {
        ...s.pendingApprovals,
        [chatSessionId]: { pendingId, tool, summary, args },
      },
    }));
  },

  onApprovalResolved: ({ chatSessionId }) => {
    // The backend resumed the paused tool loop — dismiss the card.
    set((s) => {
      const next = { ...s.pendingApprovals };
      delete next[chatSessionId];
      return { pendingApprovals: next };
    });
  },

  onQuestionRequest: ({ chatSessionId, pendingId, questions }) => {
    // Surface the question card. Only one at a time (the harness blocks on
    // it); a new request replaces any stale one.
    const parsed = Array.isArray(questions) ? questions : [];
    set((s) => ({
      pendingQuestions: {
        ...s.pendingQuestions,
        [chatSessionId]: { pendingId, questions: parsed },
      },
    }));
  },

  resolveQuestion: async (chatSessionId, answers, response) => {
    const pending = get().pendingQuestions[chatSessionId];
    if (!pending) return;
    // Optimistically remove the card (mirrors resolveApproval).
    set((s) => {
      const next = { ...s.pendingQuestions };
      delete next[chatSessionId];
      return { pendingQuestions: next };
    });
    try {
      await resolveAgentQuestion(chatSessionId, pending.pendingId, answers, response);
    } catch (err) {
      // The harness is still blocked on stdin — put the card back and
      // surface the failure so the turn can't hang silently.
      set((s) => ({
        pendingQuestions: { ...s.pendingQuestions, [chatSessionId]: pending },
      }));
      toastError("Couldn't deliver the answer", err);
    }
  },

  onError: (chatSessionId, message, code) => {
    // Persist the streamed partial the same way the cancel path does (audit
    // B-19): the backend's error path discards its buffer WITHOUT persisting,
    // so this is the only chance to keep the text the user already watched.
    // Gated on the streaming entry still existing — the cleanup below deletes
    // the key synchronously, so a duplicate chat:error for one turn cannot
    // double-persist (the backend never persists on error, so there is no
    // other dedupe to race with).
    const partial = get().streaming[chatSessionId] ?? "";
    const hadPartial = chatSessionId in get().streaming && partial.trim().length > 0;
    // Clear streaming state and surface the error for the active session.
    // Also drop this session's live-perf chip and pending-artifact buffer —
    // onDone clears both, and an errored turn must not leave them stuck
    // (audit H3).
    set((s) => {
      const nextStreaming = { ...s.streaming };
      delete nextStreaming[chatSessionId];
      const nextStatus = { ...s.chatStatus };
      delete nextStatus[chatSessionId];
      const nextLivePerf = { ...s.livePerf };
      delete nextLivePerf[chatSessionId];
      const nextPendingArtifacts = { ...s.pendingArtifacts };
      delete nextPendingArtifacts[chatSessionId];
      // An errored/cancelled turn must not leave a question card stuck
      // (the backend already dropped its pending).
      const nextPendingQuestions = { ...s.pendingQuestions };
      delete nextPendingQuestions[chatSessionId];
      // Remember what the errored turn had produced (matches the persisted
      // partial row) — same as the cancel path, so the partial bubble keeps
      // its process section expanded and reads "Stopped" instead of
      // collapsing to an empty "Worked" row.
      const nextStopped = { ...s.stoppedPartial };
      if (hadPartial) {
        nextStopped[chatSessionId] = partial.trim();
      } else {
        delete nextStopped[chatSessionId];
      }
      return {
        streaming: nextStreaming,
        chatStatus: nextStatus,
        livePerf: nextLivePerf,
        pendingArtifacts: nextPendingArtifacts,
        pendingQuestions: nextPendingQuestions,
        stoppedPartial: nextStopped,
        streamingChatSessionId:
          s.streamingChatSessionId === chatSessionId ? null : s.streamingChatSessionId,
        error:
          s.activeChatSessionId === chatSessionId ? message : s.error,
        errorCode:
          s.activeChatSessionId === chatSessionId ? (code ?? null) : s.errorCode,
      };
    });
    // Artifact telemetry (SELF_IMPROVING_ARTIFACTS.md §5.2): the turn errored,
    // so open runs count as failed with the classified error code.
    void finishArtifactRuns(chatSessionId, "failed", code ?? undefined).catch(() => {});
    // Keep the partial VISIBLE (not just persisted): without a refetch the
    // live bubble vanishes with the streaming entry and the persisted row
    // only surfaces on the NEXT turn's history reload — the watched work
    // "disappears, then reappears later" (60s network-timeout regression).
    // Same refresh + merge as cancelStream.
    if (hadPartial) {
      void (async () => {
        try {
          // Persist first, THEN read history — the refetch must land after
          // the partial row is written or it won't include it.
          await persistPartialChatMessage(chatSessionId, partial).catch(() => {});
          const messages = await getChatMessages(chatSessionId, undefined, 200);
          if (messages && get().activeChatSessionId === chatSessionId) {
            set((s) => ({
              messages: mergeOptimistic(s.messages, messages),
              messagesSessionId: chatSessionId,
              hasMoreHistory: messages.length >= 200,
            }));
          }
        } catch {
          /* best-effort: the partial still shows on the next turn */
        }
      })();
    }
    // Turn ended (in error) — keep the queue moving rather than stranding it.
    get().drainQueue(chatSessionId);
    // Disarm any active goal loop on this session so an errored iteration
    // can never keep firing continuation turns.
    const loop = get().loopState[chatSessionId];
    if (loop && loop.active) {
      set((s) => ({
        loopState: { ...s.loopState, [chatSessionId]: { ...loop, active: false } },
      }));
    }
  },

  onPerf: (payload) => {
    // Ignore stragglers: a perf event emitted just before an abort can cross
    // IPC AFTER cancelStream/onDone cleared the entry. Re-creating it here
    // would seed the NEXT turn's live timer with the OLD turn's elapsed
    // (elapsedMs resets to 0 on the new turn, and the display's monotonic
    // guard then froze the stale value on screen). Only a session that is
    // actually streaming may hold a live perf snapshot.
    if (!(payload.chatSessionId in get().streaming)) return;
    set((s) => ({
      livePerf: { ...s.livePerf, [payload.chatSessionId]: payload },
    }));
  },

  onCitationReport: (payload) => {
    set((s) => ({
      citationReports: { ...s.citationReports, [payload.chatSessionId]: payload },
    }));
  },

  /** Drop the session's citation verdict — the "Fix citations" action calls
   *  this when it dispatches the repair turn, so the strip disappears while
   *  the fix runs. If the repaired turn produces a report of its own, the
   *  fresh verdict replaces this (and the strip re-renders accordingly). */
  clearCitationReport: (chatSessionId) => {
    set((s) => {
      if (!(chatSessionId in s.citationReports)) return {};
      const next = { ...s.citationReports };
      delete next[chatSessionId];
      return { citationReports: next };
    });
  },

  onTaskProgress: ({ chatSessionId, taskId, kind, state, message, downloaded, total, speedBps, destPath }) => {
    set((s) => {
      const sessionTasks = { ...(s.tasks[chatSessionId] ?? {}) };
      sessionTasks[taskId] = { taskId, kind, state, message, downloaded, total, speedBps, destPath };
      return { tasks: { ...s.tasks, [chatSessionId]: sessionTasks } };
    });
  },

  setPlanSteps: (chatSessionId, steps) => {
    set((s) => ({
      planSteps: { ...s.planSteps, [chatSessionId]: steps },
    }));
  },

  onPlanStepProgress: (chatSessionId, stepId, status, detail, toolCall) => {
    set((s) => {
      const sessionSteps = s.planSteps[chatSessionId];
      if (!sessionSteps) return {};
      const updated = sessionSteps.map((st) => {
        if (st.stepId !== stepId) return st;
        return {
          ...st,
          status,
          completedAt: status === "completed" ? Date.now() : st.completedAt,
          failedReason: status === "failed" ? (detail ?? st.failedReason) : st.failedReason,
          matchedToolCall: toolCall ?? st.matchedToolCall,
        };
      });
      // Set the first pending step as in_progress when the active one completes
      const hasActive = updated.some((st) => st.status === "in_progress");
      if (!hasActive && status === "completed") {
        const nextPendingIdx = updated.findIndex((st) => st.status === "pending");
        if (nextPendingIdx !== -1) {
          const next = updated[nextPendingIdx];
          updated[nextPendingIdx] = { ...next, status: "in_progress" };
        }
      }
      return { planSteps: { ...s.planSteps, [chatSessionId]: updated } };
    });
  },

  setSessionPermissionMode: async (chatSessionId, mode) => {
    // Optimistic label; the harness spawn reads the persisted row per turn.
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId ? { ...sess, permissionMode: mode } : sess,
      ),
    }));
    try {
      await setChatSessionPermissionMode(chatSessionId, mode);
    } catch (err) {
      toastError("Couldn't switch the harness mode", err);
    }
  },

  onPlanUpdated: (payload) => {
    const { chatSessionId, todos } = payload;
    set((s) => {
      // The todo list is authoritative when present — mirror it into planSteps
      // (replacing any todo_write-sourced steps, keeping prose-parsed ones) so
      // the Git sidebar Progress section renders the same state.
      const parsed = (s.planSteps[chatSessionId] ?? []).filter((st) => st.source !== "todo_write");
      const mirrored: PlanStep[] = todos.map((t, i) => ({
        stepId: `todo-${chatSessionId}-${i}`,
        label: t.content,
        status: t.status,
        source: "todo_write",
        planIndex: 0,
        stepIndex: i,
        completedAt: t.status === "completed" ? Date.now() : undefined,
      }));
      return {
        sessionTodos: { ...s.sessionTodos, [chatSessionId]: todos },
        planSteps: { ...s.planSteps, [chatSessionId]: [...parsed, ...mirrored] },
      };
    });
  },

  onPlanMode: (payload) => {
    set((s) => ({
      planMode: { ...s.planMode, [payload.chatSessionId]: payload.active },
      // Mirror the persisted label onto the session record so the composer's
      // mode selector (which reads session.permissionMode) shows "plan" while
      // active and the restored posture after exit — including when the flip
      // was model-initiated (enter_plan_mode) or came from an approval.
      sessions: s.sessions.map((sess) =>
        sess.id === payload.chatSessionId && payload.label
          ? { ...sess, permissionMode: payload.label }
          : sess,
      ),
    }));
  },

  setSessionPlanMode: async (chatSessionId, active) => {
    const prev = get().planMode[chatSessionId] ?? false;
    if (prev === active) return;
    // Optimistic: flip the flag; on entry the label becomes "plan" (on exit
    // the event carries the restored posture label — local IPC, so the gap
    // is imperceptible).
    set((s) => ({
      planMode: { ...s.planMode, [chatSessionId]: active },
      sessions: s.sessions.map((sess) =>
        sess.id === chatSessionId && active
          ? { ...sess, permissionMode: "plan" }
          : sess,
      ),
    }));
    try {
      await setChatSessionPlanMode(chatSessionId, active);
    } catch (err) {
      set((s) => ({
        planMode: { ...s.planMode, [chatSessionId]: prev },
      }));
      toastError("Couldn't switch plan mode", err);
    }
  },

  onPlanProposal: (payload) => {
    set((s) => ({
      pendingPlanProposals: {
        ...s.pendingPlanProposals,
        [payload.chatSessionId]: {
          pendingId: payload.pendingId,
          title: payload.title,
          plan: payload.plan,
        },
      },
    }));
  },

  onPlanAccepted: (payload) => {
    set((s) => ({
      sessionPlans: {
        ...s.sessionPlans,
        [payload.chatSessionId]: [
          payload.plan,
          ...(s.sessionPlans[payload.chatSessionId] ?? []),
        ],
      },
    }));
  },

  onPlanProposalResolved: (chatSessionId) => {
    set((s) => {
      const next = { ...s.pendingPlanProposals };
      delete next[chatSessionId];
      return { pendingPlanProposals: next };
    });
  },

  resolvePlanProposal: async (chatSessionId, approved, feedback) => {
    const pending = get().pendingPlanProposals[chatSessionId];
    if (!pending) return;
    // Optimistically remove the card (same contract as resolveApproval — the
    // backend also dismisses via events, but no flicker if the event is slow).
    get().onPlanProposalResolved(chatSessionId);
    try {
      await resolvePlanProposal(pending.pendingId, approved, feedback);
    } catch (err) {
      // The turn is still paused on the proposal — restore the card so the
      // user can retry instead of hanging the turn (mirrors audit M3).
      set((s) => ({
        pendingPlanProposals: { ...s.pendingPlanProposals, [chatSessionId]: pending },
      }));
      toastError("Couldn't deliver the plan decision", err);
    }
  },

  onSubagentSpawn: (payload) => {
    set((s) => {
      const sessionSubagents = { ...(s.subagents[payload.chatSessionId] ?? {}) };
      sessionSubagents[payload.id] = {
        id: payload.id,
        role: payload.role,
        task: payload.task,
        prompt: payload.prompt,
        output: "",
        status: "running",
      };
      return { subagents: { ...s.subagents, [payload.chatSessionId]: sessionSubagents } };
    });
  },

  onSubagentTokens: (payload) => {
    set((s) => {
      const sessionSubagents = s.subagents[payload.chatSessionId];
      const sub = sessionSubagents?.[payload.subagentId];
      if (!sessionSubagents || !sub) return {};
      // Same 200k code-point cap as the main token stream (onToken) — an
      // uncapped subagent output grows memory without bound (audit H3).
      const output = tailCodePoints(sub.output + payload.chunk, 200_000);
      const updated = { ...sessionSubagents, [payload.subagentId]: { ...sub, output } };
      return { subagents: { ...s.subagents, [payload.chatSessionId]: updated } };
    });
  },

  onSubagentDone: (payload) => {
    set((s) => {
      const sessionSubagents = s.subagents[payload.chatSessionId];
      if (!sessionSubagents) return {};
      const existing = sessionSubagents[payload.id];
      if (!existing) return {};
      const status: SubagentInfo["status"] = payload.error ? "error" : "completed";
      const updated = {
        ...sessionSubagents,
        [payload.id]: {
          ...existing,
          output: payload.output || existing.output,
          status,
          error: payload.error ?? existing.error,
        },
      };
      return { subagents: { ...s.subagents, [payload.chatSessionId]: updated } };
    });
  },
}));

// NOTE: browsing a project (selectProject) must NEVER rebind the active
// chat to it. A chat's project binding (sessionProjects) is explicit — set
// only by "New chat for project", newChat's bind param, unbindProject, or
// the legacy send-time bind in newChat. selectSession pushes the chat's
// binding back into the global selection (binding → selection), so opening
// a chat highlights its project; the reverse direction (selection → binding)
// is intentionally absent so that clicking around the sidebar to browse
// projects does not move the chat you're viewing into them.
