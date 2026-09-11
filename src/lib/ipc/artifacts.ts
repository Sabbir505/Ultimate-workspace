// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";
import { ChatMessageRecord, ChatSession } from "../ipc";

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
  /** Thinking tiers THIS model supports (omp's models dump), ordered weakest
   *  → strongest. Absent when the CLI reports no per-model tiers. */
  thinking?: string[];
}
export interface HarnessModelConfig {
  defaultModel: string | null;
  endpoint: string | null;
  /** Reasoning-effort level derived READ-ONLY from the harness's own config
   *  (Claude Code's settings env `CLAUDE_CODE_EFFORT_LEVEL`). Null = the CLI
   *  doesn't publish a level — the picker shows nothing rather than guessing. */
  effort: string | null;
  /** Effort tiers the CLI can be spawned with (the session's pick rides the
   *  spawn flags), weakest → strongest. Empty = no knob — the pane stays
   *  slider-free. */
  effortOptions: string[];
  models: HarnessModelInfo[];
}
export const listHarnessModels = (harnessId: string) =>
  safeInvoke<HarnessModelConfig | null>("list_harness_models", { harnessId });
