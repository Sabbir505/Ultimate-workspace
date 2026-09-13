// Chat store domain types + the flat ChatState interface.
// Split out of the former 3,739-line src/state/chat.ts (architecture audit
// 2026-09-13 §1); the store is assembled in ./index.ts from ./slices/*.
import type { LastSelection } from "../../lib/lastSelection";
import type {
  ArtifactProposal,
  ChatApprovalRequestPayload,
  ChatApprovalResolvedPayload,
  ChatArtifactPayload,
  ChatCheckpoint,
  ChatCitationReportPayload,
  ChatConfigPayload,
  ChatMessageRecord,
  ChatPerfPayload,
  ChatPlanAcceptedPayload,
  ChatPlanModePayload,
  ChatPlanProposalPayload,
  ChatPlanRecord,
  ChatPlanUpdatedPayload,
  ChatQuestionInput,
  ChatQuestionRequestPayload,
  ChatSession,
  ChatSessionMetricsPayload,
  ChatTaskProgressPayload,
  PlanTodo,
  SessionMailPayload,
  SessionSpawnPayload,
  SubagentDonePayload,
  SubagentInfo,
  SubagentSpawnPayload,
  SubagentTokenPayload,
} from "../../lib/ipc";

/** Watch-mode pacing for browser actions. "on" | "off". */
export type WatchMode = "on" | "off";

/** Per-session sandbox scope. "read_only" hides all mutating tools. */
export type SandboxPolicy = "read_only" | "workspace_write";

/** Per-session approval posture. "on_request" gates every mutating tool; "auto_edit"
 *  auto-runs writes/edits but gates deletes/moves/copies; "full_access" bypasses
 *  prompts entirely. */
export type ApprovalPolicy = "on_request" | "auto_edit" | "full_access";

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

import type { ChatAttachmentInput } from "../../lib/ipc";

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
  /** Wall-clock arm time (Date.now()) — drives the sidebar goal card's
   *  elapsed timer. In-memory only; loops never survive a restart. */
  startedAt: number;
  /** Backend loop-session id (SELF_IMPROVING_ARTIFACTS.md P0) — set once the
   *  fire-and-forget `loop_session_start` resolves. Telemetry only; the
   *  frontend state machine stays authoritative for loop control. */
  backendId?: string;
}

/** What `advanceLoop` decided after one reply. */
export type LoopDecision = "continue" | "complete" | "blocked" | "stop";

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
   *  token / done / error. Reconnect notices ("reconnecting" /
   *  "reconnect_restart") use it too, rendered as an attempt-counted line
   *  under the assistant bubble rather than in the pre-token slot. */
  chatStatus: Record<string, { reason: string; message: string }>;
  /** Text that WAS streaming when a reconnect restarted the answer, kept
   *  per session so a ladder that never lands can still persist it: onError
   *  prefers the live buffer but falls back here when the restarted attempt
   *  produced nothing (see the `reconnect_restart` branch in onStatus). */
  supersededPartial: Record<string, string>;
  config: ChatConfigPayload | null;
  /** Last committed composer pick (every selection kind — builtin, harness,
   *  ACP, local). Loaded with the config; new chats seed from it so reopening
   *  the app lands ready-to-send on what the user last used. Null until the
   *  first pick (or when the stored blob is corrupt). */
  lastSelection: LastSelection | null;
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
  /** Session Mesh (SESSION_MESH_DESIGN_ARCHITECTURE.md): cross-session mail
   *  keyed by mail id, plus per-session ordered id lists covering BOTH
   *  directions (from/to) — the Git-sidebar Mesh section renders either side
   *  from the same record. Latest transition per mail wins. */
  meshMail: Record<string, SessionMailPayload>;
  meshMailBySession: Record<string, string[]>;
  /** Sessions this session spawned (chat:session-spawn), parent id → children
   *  in spawn order. The rows click through to the child chat. */
  meshChildren: Record<string, { childId: string; title: string; agent: string }[]>;
  onSessionMail: (payload: SessionMailPayload) => void;
  onSessionSpawn: (payload: SessionSpawnPayload) => void;
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
  /** Unsent composer text, per chat session. Each conversation keeps its own
   *  half-written prompt — switching sessions must not smear the draft across
   *  every other chat. In-memory only. */
  composerDrafts: Record<string, string>;
  /** Set one session's draft. `value` may be an updater (same shape as the
   *  React setState the composer used to own). Null session = no-op (nothing
   *  to key the draft on yet; the composer falls back to local state). */
  setComposerDraft: (sessionId: string | null, value: string | ((prev: string) => string)) => void;
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
  /** Record a committed composer pick as the last selection (state + the
   *  persisted `chat.last_selection` blob). Fire-and-forget persist: the
   *  in-memory value still seeds this run's new chats if the write fails. */
  rememberSelection: (sel: LastSelection) => void;
  loadSessionMetrics: (chatSessionId: string) => Promise<void>;
  /** Open a chat. Records the switch in the ui store's nav timeline unless
   *  `recordNav: false` (nav Back/Forward restores use that). */
  selectSession: (chatSessionId: string, opts?: { recordNav?: boolean }) => Promise<void>;
  /** Start a new chat. When `projectId` is omitted, the new chat inherits
   *  the previously active chat's project binding (independent when that
   *  chat has none); an explicit projectId (project-row "+") wins. `agent`
   *  (from the persisted last selection) is applied after create so fresh
   *  chats open on a harness/ACP/local agent without a second pick. */
  newChat: (
    provider: string,
    model: string,
    projectId?: string | null,
    agent?: string | null,
  ) => Promise<ChatSession | null>;
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
  /** Flip the session between Auto model routing and a pinned pick. `true`
   *  resets provider/model to "auto" placeholders (resolved per send by the
   *  backend); `false` clears the flag ahead of a manual pick. */
  setSessionAuto: (chatSessionId: string, auto: boolean) => Promise<void>;
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
    // The implementation is async (it persists the final row and clears the
    // streaming state). Typed as a Promise so callers that must run AFTER the
    // turn is merged can chain off it — the `chat:done` listener uses this to
    // read the finished answer aloud.
  ) => Promise<void>;
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
  /** Persist a harness chat's reasoning-effort tier (picker's harness
   *  slider). "" = "Default" — no spawn flag. */
  setSessionEffort: (chatSessionId: string, effort: string) => Promise<void>;
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

/** The `set` signature zustand hands the slice factories (store is assembled
 *  in ./index.ts). Matches `StoreApi<ChatState>["setState"]`. */
export type ChatStoreSet = (
  partial: ChatState | Partial<ChatState> | ((state: ChatState) => ChatState | Partial<ChatState>),
  replace?: boolean,
) => void;

/** The `get` signature zustand hands the slice factories. */
export type ChatStoreGet = () => ChatState;
