import { useState, useEffect, useCallback } from 'react';
import { journalNotification } from '../lib/notificationJournal';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { b64UrlToBytes, computePairProof, deriveSessionKey, decryptFrame, encryptFrame } from '../lib/relayCrypto';

/** The desktop relay binds loopback ONLY (127.0.0.1) on a persisted-but-random
 *  port, so there is no universal default URL: physical devices connect via a
 *  USB bridge (`adb reverse tcp:<port> tcp:<port>` → ws://localhost:<port>) or
 *  over the tailnet (Tailscale serve → wss://<machine>.<tailnet>.ts.net).
 *
 *  The pairing token rides in the URL fragment: `ws://host:port/#<token>` or
 *  `wss://host/#<token>`. On connect the phone sends an HMAC proof of the
 *  token (never the raw token) as the first WS frame; both sides then derive
 *  an XChaCha20-Poly1305 session key from the token and every further frame
 *  is encrypted Binary (§3.2.11). There is NO legacy raw-token fallback: the
 *  desktop removed it (it rotates the token on every launch and accepts the
 *  proof exclusively), so a pairing rejection surfaces as an error with
 *  capped exponential reconnect backoff — never a plaintext downgrade. */
const RELAY_URL_STORAGE_KEY = 'relay.relayUrl';
// Pre-rebrand keys (conduit.*) written by older builds — read once so a
// paired phone keeps its URL/token across the rename, then re-homed under
// the new key. The token itself lives ONLY in the URL fragment (extracted on
// load) — a duplicate `relay.relayToken` key used to keep a second plaintext
// copy and is no longer written.
const LEGACY_URL_STORAGE_KEY = 'conduit.relayUrl';
const LEGACY_TOKEN_STORAGE_KEY = 'conduit.relayToken';

export interface ProviderInfo {
  id: string; display_name: string; models: string[];
  is_local: boolean; is_running: boolean; gguf_path?: string;
}
export interface ChatUsage { input_tokens: number; output_tokens: number; cost_usd: number; }
export interface ChatMessage { role: string; content: string; }
export interface SessionInfo {
  id: string; project_id: string; project_name: string; title: string;
  harness: string; status: string; last_active_at: number; is_live?: boolean;
  starred?: boolean; unread?: boolean; effort?: string | null;
}
export interface HarnessModelRow {
  id: string; label: string;
  /** "config" | "cli" | "builtin" — the desktop pane's badge. */
  source: string;
  /** Per-model thinking tiers (empty → harness-wide effortOptions). */
  thinking?: string[];
}
export interface HarnessInfo {
  id: string; display_name: string; installed: boolean;
  /** The CLI's own model catalog + endpoint + effort tiers (warm cache). */
  models?: HarnessModelRow[];
  default_model?: string | null;
  endpoint?: string | null;
  effort?: string | null;
  effort_options?: string[];
}
function toSession(s: SessionInfo): Session {
  return { id: s.id, projectId: s.project_id, projectName: s.project_name, title: s.title,
    status: s.is_live ? ((s.status as Session['status']) || 'working') : 'idle' as Session['status'],
    provider: s.harness, model: '', lastActivity: s.last_active_at * 1000, isLive: s.is_live ?? false,
    starred: s.starred ?? false, unread: s.unread ?? false, effort: s.effort ?? null };
}
type DesktopMessage =
  | { type: 'PairOk'; salt: string }
  | { type: 'AvailableProviders'; providers: ProviderInfo[]; harnesses?: HarnessInfo[]; default_provider?: string; default_model?: string }
  | { type: 'ArtifactLibrary'; artifacts: ArtifactLibraryEntry[] }
  | { type: 'CostRollups'; rollups: CostRollupsData }
  | {
      type: 'ArtifactPreviewMsg';
      path: string; filename: string; ext: string; kind: string;
      text?: string | null; data_uri?: string | null; truncated: boolean;
    }
  | { type: 'ProjectList'; projects: ProjectInfo[] }
  | { type: 'AcpAgentList'; agents: AcpAgentInfo[] }
  | { type: 'MemoryList'; records: MemoryInfo[] }
  | { type: 'MemoryUpdated'; memory_id: string }
  | { type: 'MemoryDeleted'; memory_id: string }
  | { type: 'MemoryPurged'; count: number }
  | { type: 'InstalledSkillList'; skills: InstalledSkillInfo[] }
  | { type: 'InstalledSkillContent'; slug: string; kind: string; content: string }
  | { type: 'InstalledSkillAck'; slug: string; mirrored: number }
  | { type: 'GitStatusMsg'; is_repo: boolean; branch?: string | null; dirty: boolean; ahead: number; behind: number; remote_url?: string | null; changed_files: { status: string; kind: string; path: string }[] }
  | { type: 'GitOutput'; output: string }
  | { type: 'GitBranchesMsg'; branches: Record<string, unknown>[] }
  | { type: 'GitLogMsg'; entries: Record<string, unknown>[] }
  | { type: 'BudgetList'; budgets: BudgetInfo[] }
  | { type: 'HiddenCostProjects'; project_ids: string[] }
  | { type: 'ProjectUpserted'; project: ProjectInfo }
  | { type: 'ProjectRemoved'; project_id: string }
  | { type: 'ConnectorList'; connectors: ConnectorInfo[] }
  | { type: 'SessionConnectors'; session_id: string; connector_ids: string[] }
  | { type: 'SessionConnectorsSet'; session_id: string; connector_ids: string[] }
  | { type: 'AutomationList'; automations: AutomationInfo[] }
  | { type: 'AutomationRuns'; automation_id: string; runs: AutomationRunInfo[] }
  | { type: 'AutomationUpdated'; automation_id: string }
  | { type: 'AutomationDeleted'; automation_id: string }
  | { type: 'AutomationRunStarted'; automation_id: string }
  | { type: 'AutomationRunStopped'; automation_id: string; stopped: boolean }
  | { type: 'ChatSkills'; skills: ChatSkillInfo[] }
  | {
      type: 'HarnessModels';
      harness_id: string;
      models: HarnessModelRow[];
      default_model?: string | null;
      endpoint?: string | null;
      effort?: string | null;
      effort_options?: string[];
    }
  | { type: 'SessionList'; sessions: SessionInfo[] }
  | { type: 'ChatToken'; chat_session_id: string; token: string }
  | { type: 'ChatDone'; chat_session_id: string; usage?: ChatUsage }
  | { type: 'ChatError'; chat_session_id: string; error: string }
  | { type: 'DesktopStatus'; connected: boolean }
  | { type: 'Transcript'; session_id: string; text: string; cols: number; rows: number; unchanged?: boolean }
  | { type: 'SessionCreated'; session: SessionInfo }
  | { type: 'CostSummary'; today: number; week: number }
  | { type: 'CostDetails'; daily: DailyCostEntry[]; per_project: ProjectCostEntry[]; local_models: LocalModelUsageEntry[] }
  | { type: 'LocalModelReady'; model: string; base_url: string }
  | { type: 'LocalModelError'; model: string; error: string }
  // Session-scoped chat events (Task 2). All keyed by `session_id` (the
  // mobile app's session id, NOT an ephemeral chat_session_id) so the
  // phone-side store can route them to the right conversation without
  // knowing about the desktop's internal chat_session_id mapping.
  | { type: 'SessionMessages'; session_id: string; messages: SessionMessageRecord[]; has_more: boolean }
  | { type: 'SessionChatToken'; session_id: string; token: string }
  | { type: 'SessionChatDone'; session_id: string; usage?: { input_tokens: number; output_tokens: number; cost_usd?: number } }
  | { type: 'SessionChatError'; session_id: string; error: string }
  | { type: 'SessionChatStatus'; session_id: string; reason: string; message: string }
  | { type: 'SessionApprovalRequest'; session_id: string; pending_id: string; tool: string; summary: string; args: unknown }
  // The approval was resolved on ANY surface — dismiss matching cards here.
  | { type: 'SessionApprovalResolved'; session_id: string; pending_id: string }
  | { type: 'SessionPlanProposal'; session_id: string; pending_id: string; title: string; plan: string }
  | { type: 'SessionModelSet'; session_id: string; provider_id: string; model: string; effort?: string | null }
  | { type: 'SessionDeleted'; session_id: string }
  | { type: 'SessionMeta'; session_id: string; provider: string; model: string; title?: string; effort?: string | null; permission_mode?: string | null; project_id?: string | null }
  | { type: 'PushAck'; ok: boolean; error?: string }
  | { type: 'SessionMessageDeleted'; session_id: string; message_id: number }
  | { type: 'ChatSearchResults'; query: string; results: ChatSearchHit[] }
  | { type: 'ChatCheckpoints'; session_id: string; checkpoints: ChatCheckpointInfo[] }
  | { type: 'SessionCheckpointRestored'; session_id: string; checkpoint_id: number; deleted_messages: number }
  | { type: 'SessionPermissionModeSet'; session_id: string; mode: string }
  | { type: 'SessionQuestionRequest'; session_id: string; pending_id: string; questions: AgentQuestion[] }
  | { type: 'SessionQuestionResolved'; pending_id: string }
  | { type: 'SessionCompacted'; session_id: string }
  | { type: 'SessionArtifacts'; session_id: string; artifacts: SessionArtifact[] }
  | { type: 'ArtifactContent'; session_id: string; path: string; filename: string; kind: string; text?: string; data_base64?: string; truncated?: boolean }
  | { type: 'Transcription'; text?: string; error?: string }
  | { type: 'SessionArtifact'; session_id: string; message_id?: number; artifact: { path: string; filename: string; kind?: string; inline?: { kind: 'jsx' | 'tsx'; code: string } } }
  // Broadcast (not session-scoped): an automation run finished on the desktop.
  // Shown as a local alert — fires only while the relay is connected.
  | { type: 'AutomationRunFinished'; automationId?: string | null; automation_id: string; name: string; status: string; summary: string }
  // Broadcast: a project's monthly spend crossed its budget threshold.
  | { type: 'BudgetAlert'; project_id: string; project_name: string; monthly_usd: number; spent_usd: number };
interface MobileChatTurn {
  type: 'ChatTurn'; provider_id: string; model: string;
  messages: ChatMessage[]; system?: string; effort?: string; gguf_path?: string;
}
// Session-scoped chat senders (Task 2). These run on the SAME persistent WS
// as everything else, but they key off the mobile app's session id
// (`session_id`) so the desktop's SessionChatManager can route them through
// the existing ChatManager pipeline + owner-map streaming.
type SessionChatMessage =
  | { type: 'GetSessionMessages'; session_id: string; before_id?: number; limit: number }
  | { type: 'SendChatMessage'; session_id: string; text: string; attachments: SessionChatAttachment[] }
  | { type: 'CancelSessionStream'; session_id: string }
  | { type: 'ResolveSessionApproval'; session_id: string; pending_id: string; decision: 'approve' | 'deny'; always_allow?: boolean }
  | { type: 'RenameSession'; session_id: string; title: string }
  | { type: 'SetSessionModel'; session_id: string; provider_id: string; model: string; effort?: string }
  | { type: 'DeleteChatSession'; session_id: string }
  | { type: 'GetSessionMeta'; session_id: string }
  | { type: 'RegisterPushToken'; token: string; platform: string }
  | { type: 'ListSessionArtifacts'; session_id: string }
  | { type: 'ReadArtifact'; session_id: string; path: string }
  | { type: 'TranscribeAudio'; data_base64: string; media_type?: string }
  | { type: 'ResolvePlanProposal'; session_id: string; pending_id: string; approved: boolean; feedback?: string };
type MobileMessagePlain =
  | { type: 'ListAvailableProviders' } | { type: 'ListSessions' }
  | { type: 'SetSessionStarred'; session_id: string; starred: boolean }
  | { type: 'ListArtifacts' }
  | { type: 'ListHarnessModels'; harness_id: string }
  | { type: 'ListChatSkills' }
  | { type: 'ListAutomations' }
  | { type: 'ListProjects' }
  | { type: 'ListAcpAgents' }
  | { type: 'ListMemoryRecords'; include_inactive?: boolean }
  | { type: 'UpdateMemoryRecord'; memory_id: string; content: string; importance?: number }
  | { type: 'DeleteMemoryRecord'; memory_id: string }
  | { type: 'PurgeMemories' }
  | { type: 'ListInstalledSkills'; kind: string }
  | { type: 'ReadInstalledSkill'; slug: string; kind: string }
  | { type: 'SaveInstalledSkill'; slug: string; kind: string; content: string }
  | { type: 'CreateInstalledSkill'; name: string; kind: string; content: string }
  | { type: 'DeleteInstalledSkill'; slug: string; kind: string }
  | { type: 'MakeInstalledSkillsGlobal'; kind: string }
  | { type: 'GitStatus'; project_id: string }
  | { type: 'GitDiff'; project_id: string; path?: string }
  | { type: 'GitCommit'; project_id: string; message: string }
  | { type: 'GitPush'; project_id: string }
  | { type: 'GitBranches'; project_id: string }
  | { type: 'GitLog'; project_id: string; limit?: number }
  | { type: 'ListBudgets' }
  | { type: 'SetBudget'; project_id: string; monthly_usd: number; threshold_pct?: number }
  | { type: 'RemoveBudget'; project_id: string }
  | { type: 'ListHiddenCostProjects' }
  | { type: 'HideCostProject'; project_id: string }
  | { type: 'UnhideCostProject'; project_id: string }
  | { type: 'AddProject'; path: string; name?: string }
  | { type: 'RenameProject'; project_id: string; name: string }
  | { type: 'RemoveProject'; project_id: string }
  | { type: 'ListConnectors' }
  | { type: 'ReadArtifactPreview'; path: string }
  | { type: 'SetSessionConnectors'; session_id: string; connector_ids: string[] }
  | { type: 'GetSessionConnectors'; session_id: string }
  | { type: 'CreateAutomation'; input: Record<string, unknown> }
  | { type: 'UpdateAutomation'; automation_id: string; input: Record<string, unknown> }
  | { type: 'DeleteAutomation'; automation_id: string }
  | { type: 'SetAutomationEnabled'; automation_id: string; enabled: boolean }
  | { type: 'RunAutomationNow'; automation_id: string }
  | { type: 'StopAutomationRun'; automation_id: string }
  | { type: 'ListAutomationRuns'; automation_id: string; limit?: number }
  | { type: 'DeleteChatMessage'; session_id: string; message_id: number }
  | { type: 'EditUserMessage'; session_id: string; message_id: number; text: string }
  | { type: 'RegenerateMessage'; session_id: string }
  | { type: 'ListChatCheckpoints'; session_id: string }
  | { type: 'RestoreChatCheckpoint'; session_id: string; checkpoint_id: number; rollback_messages?: boolean }
  | { type: 'SearchChatMessages'; query: string; limit?: number }
  | { type: 'SetSessionPermissionMode'; session_id: string; mode: string }
  | { type: 'ResolveSessionQuestion'; session_id: string; pending_id: string; answers: Record<string, string | string[]>; response?: string }
  | { type: 'CompactSession'; session_id: string }
  | { type: 'GetCostRollups'; days?: number }
  | MobileChatTurn | { type: 'CancelChatTurn'; chat_session_id: string }
  | { type: 'SendToSession'; session_id: string; text: string }
  | { type: 'GetTranscript'; session_id: string }
  | { type: 'CreateSession'; project_id: string; harness: string; provider?: string; model?: string; effort?: string; connectors?: string[] }
  | { type: 'SpawnSession'; session_id: string }
  | { type: 'GetCostSummary' }
  | { type: 'GetCostDetails' }
  | { type: 'StartLocalModel'; model: string; gguf_path: string }
  | SessionChatMessage;

export interface Session {
  id: string; projectId: string; projectName: string; title: string;
  status: 'working' | 'waiting' | 'diff_ready' | 'idle';
  provider: string; model: string; lastActivity: number; isLive: boolean;
  /** Desktop sidebar parity: pinned chats sort first; unread show a dot. */
  starred: boolean; unread: boolean;
  /** Reasoning effort stored on the chat row (null/'' = provider default). */
  effort?: string | null;
}
export interface CostSummary { today: number; week: number; }

export interface DailyCostEntry { day: string; cost_usd: number; }
export interface ProjectCostEntry {
  project_id: string; project_name: string; total_cost_usd: number;
  total_input_tokens: number; total_output_tokens: number;
}
export interface LocalModelUsageEntry {
  model: string; input_tokens: number; output_tokens: number;
  message_count: number; last_used: string;
}
export interface CostDetails {
  daily: DailyCostEntry[];
  per_project: ProjectCostEntry[];
  local_models: LocalModelUsageEntry[];
}

type Listener<T> = (data: T) => void;
/**
 * Per-session FIFO of the GetSessionMessages requests sent but not yet
 * answered, in send order: `true` = pagination reply wanted (a before_id was
 * sent), `false` = first page. The relay answers a connection's requests in
 * order, so shifting the front routes each reply to the fetch that produced
 * it. The old shared `paginating` set misrouted racing fetches: a first-page
 * reply (2.5s poll / sync-on-first-token) arriving while "load older" was in
 * flight PREPENDED the fresh page (duplicating the newest messages), and the
 * pagination reply then REPLACED the whole list with only older messages.
 */
const pendingMessageFetches = new Map<string, boolean[]>();
function queueMessageFetch(sessionId: string, older: boolean) {
  const q = pendingMessageFetches.get(sessionId);
  if (q) q.push(older);
  else pendingMessageFetches.set(sessionId, [older]);
}
function routeMessageReply(sessionId: string): boolean {
  const q = pendingMessageFetches.get(sessionId);
  if (!q || q.length === 0) return false; // unsolicited push: replace
  const older = q.shift();
  if (q.length === 0) pendingMessageFetches.delete(sessionId);
  return older ?? false;
}
/** In-flight fetch expectations die with the connection. */
function clearMessageFetches() {
  pendingMessageFetches.clear();
}

class EventBus<T> {
  private ls = new Set<Listener<T>>();
  on(fn: Listener<T>) { this.ls.add(fn); return () => { this.ls.delete(fn); }; }
  emit(data: T) { this.ls.forEach(fn => fn(data)); }
}
/**
 * `chat_session_id` values the relay uses to tag a non-chat error. Anything
 * else in ChatError is a real chat session id and belongs to onChatError.
 */
const RELAY_DOMAINS = new Set([
  'acp-agents', 'artifacts', 'budget', 'chat-skills', 'connectors', 'cost-rollups',
  'create', 'git', 'harness-models', 'memory', 'pair', 'preview', 'project',
  'projects', 'search', 'session-chat', 'session-connectors', 'sessions',
  'skills', 'unknown', 'warmup',
]);
export const onChatToken = new EventBus<{ chatSessionId: string; token: string }>();
export const onChatDone = new EventBus<{ chatSessionId: string; usage?: ChatUsage }>();
export const onChatError = new EventBus<{ chatSessionId: string; error: string }>();
export const onProviderList = new EventBus<ProviderInfo[]>();
export const onConnected = new EventBus<boolean>();
export const onSessionList = new EventBus<Session[]>();
export const onTranscript  = new EventBus<{ sessionId: string; text: string; cols: number; rows: number; unchanged?: boolean }>();
export const onSessionCreated = new EventBus<Session>();
export const onCostDetails = new EventBus<CostDetails>();
export const onLocalModelReady = new EventBus<{ model: string; baseUrl: string }>();
export const onLocalModelError = new EventBus<{ model: string; error: string }>();

// Session-scoped chat event buses (Task 6). Keyed by the mobile session id.
/**
 * `append` is true only for a PAGINATION reply (the caller sent a
 * before_id). A first-page reply must REPLACE the list: after a delete
 * the refreshed page is shorter, and inferring intent from ids made the
 * merge prepend it — the deleted message stayed on screen forever.
 */
export const onSessionMessages = new EventBus<{ sessionId: string; messages: SessionMessageRecord[]; hasMore: boolean; append: boolean }>();
export const onSessionChatToken = new EventBus<{ sessionId: string; token: string }>();
export const onSessionChatDone = new EventBus<{ sessionId: string; usage?: SessionChatUsage }>();
export const onSessionChatError = new EventBus<{ sessionId: string; error: string }>();
export const onSessionChatStatus = new EventBus<{ sessionId: string; reason: string; message: string }>();
export const onSessionApprovalRequest = new EventBus<{ sessionId: string; pendingId: string; tool: string; summary: string; args: unknown }>();
export const onSessionApprovalResolved = new EventBus<{ sessionId: string; pendingId: string }>();
export const onSessionPlanProposal = new EventBus<{ sessionId: string; pendingId: string; title: string; plan: string }>();
export const onSessionModelSet = new EventBus<{ sessionId: string; providerId: string; model: string; effort?: string | null }>();
export const onSessionDeleted = new EventBus<{ sessionId: string }>();
export const onSessionMeta = new EventBus<{ sessionId: string; provider: string; model: string; title?: string; effort?: string | null; permission_mode?: string | null; projectId?: string | null }>();
export const onSessionArtifact = new EventBus<{ sessionId: string; messageId?: number; artifact: SessionArtifact }>();
export const onSessionArtifacts = new EventBus<{ sessionId: string; artifacts: SessionArtifact[] }>();
export const onArtifactContent = new EventBus<{ sessionId: string; path: string; filename: string; kind: string; text?: string; dataBase64?: string; truncated?: boolean }>();
export const onTranscription = new EventBus<{ text?: string; error?: string }>();
export const onBudgetAlert = new EventBus<{ projectId: string; projectName: string; monthlyUsd: number; spentUsd: number }>();
export const onArtifactLibrary = new EventBus<{ artifacts: ArtifactLibraryEntry[] }>();
export const onCostRollups = new EventBus<{ rollups: CostRollupsData }>();
export type HarnessModelsPayload = {
  harnessId: string;
  models: HarnessModelRow[];
  defaultModel: string | null;
  endpoint: string | null;
  effort: string | null;
  effortOptions: string[];
};
export const onHarnessModels = new EventBus<HarnessModelsPayload>();
export interface ArtifactPreview {
  path: string; filename: string; ext: string;
  /** text | markdown | csv | json | html | diagram | code | image | pdf | office | binary */
  kind: string;
  text?: string | null;
  data_uri?: string | null;
  truncated: boolean;
}
export const onArtifactPreview = new EventBus<{ preview: ArtifactPreview }>();
export interface AgentQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export const onSessionQuestionRequest = new EventBus<{ sessionId: string; pendingId: string; questions: AgentQuestion[] }>();
export const onSessionQuestionResolved = new EventBus<{ pendingId: string }>();
export interface AcpAgentInfo { id: string; display_name: string; installed: boolean; }
export const onAcpAgentList = new EventBus<{ agents: AcpAgentInfo[] }>();
export interface MemoryInfo {
  id: string; kind: string; content: string; keywords: string[];
  importance: number; confidence: number; status: string; created_at: number; updated_at: number;
}
export const onMemoryList = new EventBus<{ records: MemoryInfo[] }>();
export const onMemoryMutated = new EventBus<{ memoryId: string; removed?: boolean; purged?: number }>();
export interface InstalledSkillInfo {
  slug: string; name: string; description: string; source: string; kind: string;
}
export const onInstalledSkillList = new EventBus<{ skills: InstalledSkillInfo[] }>();
export const onInstalledSkillContent = new EventBus<{ slug: string; kind: string; content: string }>();
export const onInstalledSkillAck = new EventBus<{ slug: string; mirrored: number }>();
export const onGitStatus = new EventBus<{ status: {
  is_repo: boolean; branch?: string | null; dirty: boolean; ahead: number; behind: number;
  remote_url?: string | null; changed_files: { status: string; kind: string; path: string }[];
} }>();
export const onGitOutput = new EventBus<{ output: string }>();
export const onGitBranches = new EventBus<{ branches: Record<string, unknown>[] }>();
export const onGitLog = new EventBus<{ entries: Record<string, unknown>[] }>();
export interface BudgetInfo {
  project_id: string; monthly_usd: number; threshold_pct: number;
}
export const onBudgetList = new EventBus<{ budgets: BudgetInfo[] }>();
export const onHiddenCostProjects = new EventBus<{ projectIds: string[] }>();
export interface ProjectInfo {
  id: string; path: string; name: string; is_git_repo: boolean;
  created_at: number; last_opened_at?: number | null;
}
export const onProjectList = new EventBus<{ projects: ProjectInfo[] }>();
export const onProjectUpserted = new EventBus<{ project: ProjectInfo }>();
export const onProjectRemoved = new EventBus<{ projectId: string }>();
export interface ConnectorInfo {
  id: string; display_name: string; icon: string; family: string; description: string;
  connected: boolean; account_display?: string | null;
}
export const onConnectorList = new EventBus<{ connectors: ConnectorInfo[] }>();
export const onSessionConnectors = new EventBus<{ sessionId: string; connectorIds: string[] }>();
export const onSessionConnectorsSet = new EventBus<{ sessionId: string; connectorIds: string[] }>();
export interface AutomationInfo {
  id: string; name: string; prompt: string; harness: string; model: string; cwd: string;
  schedule: string; enabled: boolean;
  last_run_at?: number | null; last_status?: string | null; chat_session_id?: string | null;
  created_at: number; origin: string;
  /** "cron" | "webhook" | "file" | "git" | "gmail" */
  trigger_type: string;
}
export interface AutomationRunInfo {
  id: string; automation_id: string; started_at: number; finished_at?: number | null;
  status: string; summary: string; chat_session_id?: string | null; source: string;
}
export const onAutomationList = new EventBus<{ automations: AutomationInfo[] }>();
export const onAutomationRunFinished = new EventBus<{ automationId: string | null; status: string; summary: string }>();
export const onAutomationRuns = new EventBus<{ automationId: string; runs: AutomationRunInfo[] }>();
export const onAutomationUpdated = new EventBus<{ automationId: string }>();
export const onAutomationDeleted = new EventBus<{ automationId: string }>();
export const onAutomationRunStarted = new EventBus<{ automationId: string }>();
export const onAutomationRunStopped = new EventBus<{ automationId: string; stopped: boolean }>();
export const onAutomationError = new EventBus<{ error: string }>();
/**
 * Errors from the non-chat relay domains (git, memory, skills, projects,
 * budgets, sessions, artifacts, preview). The desktop answers those arms
 * with ChatError carrying the domain name in `chat_session_id`; screens
 * subscribe here so a failed list shows a message instead of an empty page.
 */
export const onDomainError = new EventBus<{ domain: string; error: string }>();
export interface ChatSkillInfo {
  slug: string; name: string; description: string;
  /** "installed" | "builtin" */
  origin: string;
}
export const onChatSkills = new EventBus<{ skills: ChatSkillInfo[] }>();
export const onSearchResults = new EventBus<{ query: string; results: ChatSearchHit[] }>();
export const onCheckpoints = new EventBus<{ sessionId: string; checkpoints: ChatCheckpointInfo[] }>();
export const onCheckpointRestored = new EventBus<{ sessionId: string; checkpointId: number; deletedMessages: number }>();
export const onPermissionModeSet = new EventBus<{ sessionId: string; mode: string }>();
export const onSessionCompacted = new EventBus<{ sessionId: string }>();
export const onSessionMessageDeleted = new EventBus<{ sessionId: string; messageId: number }>();

export interface ArtifactLibraryEntry {
  chat_session_id?: string;
  filename: string;
  path: string;
  kind: string;
  created_at: number;
}

/** Desktop CostDashboard parity — the get_cost_rollups_v2 payload
 *  (camelCase, exactly as the desktop serializes it for its own UI). */
export interface CostRollupsData {
  totals: {
    rawTokenCostUsd: number; providerReportedUsd: number;
    estimatedUsd: number; unpricedUsd: number;
  };
  perProvider: { provider: string; costUsd: number; tokens: number; sharePct: number }[];
  daily: {
    day: string; costUsd: number;
    tokensByProvider: Record<string, number>;
    costByProvider: Record<string, number>;
  }[];
  byKind: {
    processedTokens: number; cachedInputTokens: number; uncachedInputTokens: number;
    outputTokens: number; reasoningTokens: number; sessions: number; responses: number;
  };
  perModel: { modelKey: string; displayName: string; costUsd: number; sharePct: number; tokens: number; provider?: string }[];
  costQuality: { providerReportedPct: number; modelPricedPct: number; unpricedPct: number; cacheSavingsUsd: number };
  perProject: { projectId: string; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number }[];
  rangeStart: string; rangeEnd: string; rangeDays: number;
}

export interface SessionMessageRecord {
  id: number; role: string; content: string; created_at: number;
  input_tokens?: number; output_tokens?: number; cost_usd?: number;
  tool_calls?: unknown; artifact_paths?: string[];
}
export interface SessionChatUsage { input_tokens: number; output_tokens: number; cost_usd?: number; }
export interface SessionArtifact { path: string; filename: string; kind?: string; inline?: { kind: 'jsx' | 'tsx'; code: string }; }
export interface ChatSearchHit {
  chat_session_id: string; session_title?: string | null; message_id?: number | null;
  snippet?: string | null; role?: string | null; created_at: number;
}
export interface CheckpointFileInfo { path: string; status: string; }
export interface ChatCheckpointInfo {
  id: number; message_id?: number | null; files: CheckpointFileInfo[]; created_at: number;
}
export interface SessionChatAttachment {
  name: string; kind: 'text' | 'image' | 'doc';
  text?: string; data?: string; media_type?: string; format?: string;
}

// Artifact-preview cache (library grid + sheet): path -> preview, filled as
// the relay streams them back. The preview sheet paints instantly from this
// cache instead of re-fetching the whole file, which is what made opening
// an artifact feel slow. Capped: entries carry full file text and base64
// image payloads, so an uncapped map accumulated every browsed artifact in
// JS memory for the app's lifetime. Eviction is insertion-oldest-first —
// an evicted entry just re-fetches on next open.
const PREVIEW_CACHE_MAX = 48;
const _previewCache = new Map<string, ArtifactPreview>();
const _previewInFlight = new Set<string>();

export function getCachedArtifactPreview(path: string): ArtifactPreview | undefined {
  return _previewCache.get(path);
}

function cacheArtifactPreview(path: string, preview: ArtifactPreview) {
  _previewCache.delete(path); // refresh insertion order on re-view
  _previewCache.set(path, preview);
  while (_previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = _previewCache.keys().next().value;
    if (oldest === undefined) break;
    _previewCache.delete(oldest);
  }
}

function requestArtifactPreviewFn(path: string) {
  if (_previewCache.has(path) || _previewInFlight.has(path)) return;
  _previewInFlight.add(path);
  _send({ type: 'ReadArtifactPreview', path });
}

let _ws: WebSocket | null = null;
let _url: string | null = null;
let _token: string | null = null;
// E2E session state (§3.2.11). `_e2eKey` is set the moment we decide to pair
// with a proof (before the Pair frame leaves) so every subsequent send is
// encrypted; the desktop enables its side when the proof verifies. Counters
// are per-direction and reset on every (re)connect.
let _e2eKey: Uint8Array | null = null;
let _outCounter = 0;
let _inCounter = 0;
// Pairing handshake: the key is derived only when the desktop's PairOk
// (carrying the per-connection salt) arrives; sends between Pair and PairOk
// are queued and flushed on keying. Audit C1 — the key must be unique per
// connection because both counters reset at reconnect.
let _pairingToken: string | null = null;
let _pendingFrames: string[] = [];
// Loaded once from AsyncStorage; connect() awaits this so a persisted URL
// wins over the loopback default on cold start. Pre-rebuild builds stored
// the token under its own key — when the legacy URL carries no fragment, the
// legacy token is spliced into the migrated URL's fragment (the fragment is
// the one copy; no separate duplicate key is written).
const _storedUrlReady: Promise<string | null> = AsyncStorage.getItem(RELAY_URL_STORAGE_KEY)
  .then(async (stored) => {
    if (stored) { _url = stored; _token = extractToken(stored); return stored; }
    const legacyUrl = await AsyncStorage.getItem(LEGACY_URL_STORAGE_KEY).catch(() => null);
    if (!legacyUrl) return null;
    const legacyToken = await AsyncStorage.getItem(LEGACY_TOKEN_STORAGE_KEY).catch(() => null);
    const migrated = extractToken(legacyUrl) || !legacyToken
      ? legacyUrl
      : `${legacyUrl.split('#')[0]}#${legacyToken}`;
    _url = migrated;
    _token = extractToken(migrated) ?? legacyToken;
    void AsyncStorage.setItem(RELAY_URL_STORAGE_KEY, migrated).catch(() => {});
    return migrated;
  })
  .catch(() => null);
let _connecting = false;
let _reconnectTimer: any = null;
// Capped exponential reconnect backoff. The fixed 3s retry used to spin
// forever against a desktop that is down or rejects pairing (its token
// rotates on every restart); the delay doubles per failed attempt and
// resets when a connection actually pairs (first cleanly decrypted E2E
// frame) or when the user points the app at a URL/token explicitly.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
let _reconnectDelay = RECONNECT_BASE_MS;
function resetReconnectBackoff() { _reconnectDelay = RECONNECT_BASE_MS; }
let _pollTimer: any = null;
// Providers change rarely (key added/removed, local model scanned), and each
// ListAvailableProviders triggers outbound /v1/models calls per provider on
// the desktop — so refresh on a slower 30s cadence, not the 5s session poll.
// Crucially this also covers the case where the WS stayed open across a
// desktop rebuild and `onopen` never re-fired: the provider list would
// otherwise never be (re)requested.
let _providerTimer: any = null;
const _cl = new Set<(v: boolean) => void>();
const _pl = new Set<(v: ProviderInfo[]) => void>();
const _sl = new Set<(v: Session[]) => void>();
const _csl = new Set<(v: CostSummary) => void>();
const _cdl = new Set<(v: CostDetails) => void>();
// Agent-harness families + the desktop's auto-route default model
// (AvailableProviders payload) — composer/agent-picker parity.
let _harnesses: HarnessInfo[] = [];
let _defaults: { provider: string; model: string } | null = null;
const _hl = new Set<(v: HarnessInfo[]) => void>();
const _dl = new Set<(v: { provider: string; model: string } | null) => void>();
function nh() { _hl.forEach(fn => fn(_harnesses)); }
function nd() { _dl.forEach(fn => fn(_defaults)); }

function nc(v: boolean) { onConnected.emit(v); _cl.forEach(fn => fn(v)); }
/** True while a connect attempt is in flight and NOT yet paired. Kept
 *  separate from `connected` so the UI can hold one stable view for the
 *  whole handshake instead of flipping between its offline and online
 *  layouts — see the cold-open flash fix. */
const _clConnecting = new Set<(v: boolean) => void>();
function nconnecting(v: boolean) { _clConnecting.forEach(fn => fn(v)); }
let _providers: ProviderInfo[] = [];
function np(v: ProviderInfo[]) { _providers = v; onProviderList.emit(v); _pl.forEach(fn => fn(v)); }
function ns(v: Session[]) { onSessionList.emit(v); _sl.forEach(fn => fn(v)); }
function ncs(v: CostSummary) { _csl.forEach(fn => fn(v)); }
function ncd(v: CostDetails) { onCostDetails.emit(v); _cdl.forEach(fn => fn(v)); }
/// Send a plaintext/encrypted frame on the relay socket. Returns false when
/// the socket is not OPEN — callers that gate UI state on a reply (e.g. the
/// session-chat send) MUST check it, or the message is silently dropped
/// while the UI waits forever for events that will never arrive.
function _send(msg: MobileMessagePlain): boolean {
  if (_ws?.readyState !== WebSocket.OPEN) return false;
  const json = JSON.stringify(msg);
  if (_e2eKey) {
    _ws.send(encryptFrame(_e2eKey, _outCounter++, new TextEncoder().encode(json)));
  } else if (_pairingToken) {
    // Paired-pending: the desktop rejects plaintext after a Pair frame, so
    // hold the message until PairOk delivers the connection salt.
    _pendingFrames.push(json);
  } else {
    _ws.send(json);
  }
  return true;
}

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(() => {
    if (_ws?.readyState === WebSocket.OPEN) {
      _send({ type: 'ListSessions' });
      _send({ type: 'GetCostSummary' });
      // NOTE: GetCostDetails is deliberately NOT polled — it runs three SQL
      // aggregations under the desktop's DB mutex (~15-30 ms of lock every
      // tick, ~6 KB payload) and changes at most once per completed turn.
      // It's fetched on connect (ws.onopen) and on demand via
      // refreshCostDetails() when the Settings/cost view opens or the user
      // pulls to refresh.
    }
  }, 5000);
  _providerTimer = setInterval(() => {
    if (_ws?.readyState === WebSocket.OPEN) _send({ type: 'ListAvailableProviders' });
  }, 30000);
}
function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_providerTimer) { clearInterval(_providerTimer); _providerTimer = null; }
}

/** Extract the pairing token from a URL's fragment (`ws://host:port/#token`
 *  or `wss://host/#token`). Returns null when no fragment is present (legacy
 *  unauthenticated connect — the relay will reject this, but we fall through
 *  so the error surfaces as a connection close rather than a silent skip). */
function extractToken(url: string): string | null {
  const hashIdx = url.indexOf('#');
  if (hashIdx === -1) return null;
  const frag = url.slice(hashIdx + 1);
  // Cut at the first `?` or `&` that appears in the fragment (whichever
  // comes first) — taking Math.min of both indexes breaks when only ONE
  // separator exists (min(-1, x) === -1 swallowed the whole fragment).
  const ends = [frag.indexOf('?'), frag.indexOf('&')].filter((i) => i !== -1);
  const token = ends.length ? frag.slice(0, Math.min(...ends)) : frag;
  return token || null;
}

function _doConnect(target: string) {
  // Skip when already OPEN *or* CONNECTING to the same target — tearing down
  // an in-flight CONNECTING socket to redo it reset the pairing handshake
  // every time a screen mounted and called connect() (e.g. HomeScreen).
  if (
    (_ws?.readyState === WebSocket.OPEN || _ws?.readyState === WebSocket.CONNECTING) &&
    target === _url
  ) return;
  // Cancel any pending reconnect first: a stale timer closing over the OLD
  // target would fire ~3s later and silently reconnect to the previous
  // desktop, overriding a URL the user just changed (audit M8).
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; }
  _url = target;
  _token = extractToken(target);
  _e2eKey = null; _outCounter = 0; _inCounter = 0;
  _pairingToken = null; _pendingFrames = [];
  _connecting = true;
  nconnecting(true);
  try {
    const ws = new WebSocket(target); _ws = ws;
    // Binary frames (E2E-encrypted payloads) arrive as ArrayBuffer; without
    // this React Native may hand us a Blob we'd have to read asynchronously.
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      // Deliberately NOT nc(true) here — the socket being open says nothing
      // about pairing. nc(true) fires on PairOk below.
      _connecting = false; startPolling();
      // The relay requires the FIRST frame to be a Pair message (token
      // check at relay.rs). E2E flow (§3.2.11): send an HMAC proof of the
      // token — never the raw token — and derive the session key up front so
      // every following send is already encrypted. Pairing is proof-
      // EXCLUSIVE: the desktop removed raw-token pairing (and rotates the
      // token per launch), so a generic pair rejection must never downgrade
      // this side into a plaintext retry loop — it could never succeed. No
      // token in the URL (legacy/dev) → skip Pair; the relay rejects and the
      // user sees the connect error state.
      if (_token) {
        _pairingToken = _token;
        ws.send(JSON.stringify({ type: 'Pair', proof: computePairProof(_token) }));
      }
      _send({ type: 'ListAvailableProviders' });
      _send({ type: 'ListSessions' });
      _send({ type: 'GetCostSummary' });
      _send({ type: 'GetCostDetails' });
    };
    ws.onmessage = (event) => {
      try {
        // Inbound: Text = plaintext (pre-pair frames, or a legacy
        // connection). Binary = E2E-encrypted payload — decrypt with the
        // inbound counter, which advances regardless of success so it stays
        // in lockstep with the desktop's send counter.
        let text: string;
        if (typeof event.data === 'string') {
          text = event.data;
        } else if (_e2eKey) {
          const frame = new Uint8Array(event.data as ArrayBuffer);
          const plain = decryptFrame(_e2eKey, _inCounter, frame);
          _inCounter++;
          if (!plain) { console.warn('[relay] E2E frame failed to decrypt'); return; }
          text = new TextDecoder().decode(plain);
          // A frame that decrypts clean proves the desktop verified our
          // proof (it only enables E2E after that) — pairing succeeded, so
          // the reconnect backoff resets to the base delay.
          resetReconnectBackoff();
        } else {
          // Binary frame with no E2E session — protocol violation; ignore.
          return;
        }
        const msg = JSON.parse(text) as DesktopMessage;
        switch (msg.type) {
          case 'PairOk': {
            // Per-connection key (audit C1): derive from the desktop's fresh
            // salt, then flush whatever queued between Pair and PairOk.
            if (_pairingToken) {
              _e2eKey = deriveSessionKey(_pairingToken, b64UrlToBytes(msg.salt));
              _pairingToken = null;
              const queued = _pendingFrames;
              _pendingFrames = [];
              const sock = _ws;
              for (const frame of queued) {
                sock?.send(encryptFrame(_e2eKey, _outCounter++, new TextEncoder().encode(frame)));
              }
              resetReconnectBackoff();
              // Pairing CONFIRMED — this, not ws.onopen, is when the app may
              // present itself as connected. ws.onopen used to fire nc(true)
              // immediately, so every reconnect attempt flashed the online
              // layout for a frame before the pair was accepted (or rejected)
              // and the offline layout came back: the cold-open flicker.
              nc(true);
              nconnecting(false);
              // Requests in flight on the OLD connection are gone with it;
              // keeping their routing entries would misroute the first
              // replies of the new connection.
              clearMessageFetches();
            }
            break;
          }
          case 'AvailableProviders': {
            _harnesses = msg.harnesses || [];
            _defaults = msg.default_provider && msg.default_model
              ? { provider: msg.default_provider, model: msg.default_model }
              : null;
            np(msg.providers || []);
            nh(); nd();
            break;
          }
          case 'SessionList': ns((msg.sessions || []).map(toSession)); break;
          case 'ChatToken': onChatToken.emit({ chatSessionId: msg.chat_session_id, token: msg.token }); break;
          case 'ChatDone': onChatDone.emit({ chatSessionId: msg.chat_session_id, usage: msg.usage }); break;
          case 'ChatError':
            if (msg.chat_session_id === 'automation') onAutomationError.emit({ error: msg.error });
            else if (msg.chat_session_id === 'compact') onSessionCompacted.emit({ sessionId: 'compact' });
            else if (RELAY_DOMAINS.has(msg.chat_session_id)) {
              onDomainError.emit({ domain: msg.chat_session_id, error: msg.error });
            } else onChatError.emit({ chatSessionId: msg.chat_session_id, error: msg.error });
            break;
          // The plaintext hello is sent before pairing; trusting it here
          // re-claimed `connected` during the handshake. Post-pair frames are
          // E2E frames, so gate on the key.
          case 'DesktopStatus': if (_e2eKey) nc(msg.connected); break;
          case 'Transcript': onTranscript.emit({ sessionId: msg.session_id, text: msg.text, cols: msg.cols ?? 0, rows: msg.rows ?? 0, unchanged: msg.unchanged }); break;
          case 'SessionCreated': onSessionCreated.emit(toSession(msg.session)); break;
          case 'CostSummary': ncs({ today: msg.today, week: msg.week }); break;
          case 'CostDetails': ncd({
            daily: msg.daily || [],
            per_project: msg.per_project || [],
            local_models: msg.local_models || [],
          }); break;
          case 'LocalModelReady': onLocalModelReady.emit({ model: msg.model, baseUrl: msg.base_url }); break;
          case 'LocalModelError': onLocalModelError.emit({ model: msg.model, error: msg.error }); break;
          // Session-scoped chat events (Task 6). Route to the new event buses.
          case 'SessionMessages': onSessionMessages.emit({ sessionId: msg.session_id, messages: msg.messages, hasMore: msg.has_more, append: routeMessageReply(msg.session_id) }); break;
          case 'SessionChatToken': onSessionChatToken.emit({ sessionId: msg.session_id, token: msg.token }); break;
          case 'SessionChatDone':
            onSessionChatDone.emit({ sessionId: msg.session_id, usage: msg.usage });
            journalNotification('turn_done', 'Turn complete', 'Your agent finished a reply.', msg.session_id);
            break;
          case 'SessionChatError':
            onSessionChatError.emit({ sessionId: msg.session_id, error: msg.error });
            journalNotification('turn_error', 'Turn failed', msg.error, msg.session_id);
            break;
          case 'SessionChatStatus': onSessionChatStatus.emit({ sessionId: msg.session_id, reason: msg.reason, message: msg.message }); break;
          case 'SessionApprovalRequest': onSessionApprovalRequest.emit({ sessionId: msg.session_id, pendingId: msg.pending_id, tool: msg.tool, summary: msg.summary, args: msg.args }); break;
          case 'SessionApprovalResolved': onSessionApprovalResolved.emit({ sessionId: msg.session_id, pendingId: msg.pending_id }); break;
          case 'SessionPlanProposal': onSessionPlanProposal.emit({ sessionId: msg.session_id, pendingId: msg.pending_id, title: msg.title, plan: msg.plan }); break;
          case 'SessionModelSet': onSessionModelSet.emit({ sessionId: msg.session_id, providerId: msg.provider_id, model: msg.model, effort: msg.effort }); break;
          case 'SessionDeleted': onSessionDeleted.emit({ sessionId: msg.session_id }); break;
          case 'SessionMeta': onSessionMeta.emit({ sessionId: msg.session_id, provider: msg.provider, model: msg.model, title: msg.title, effort: msg.effort, permission_mode: msg.permission_mode, projectId: msg.project_id }); break;
          case 'SessionArtifacts': onSessionArtifacts.emit({ sessionId: msg.session_id, artifacts: msg.artifacts || [] }); break;
          case 'ArtifactContent': onArtifactContent.emit({ sessionId: msg.session_id, path: msg.path, filename: msg.filename, kind: msg.kind, text: msg.text, dataBase64: msg.data_base64, truncated: msg.truncated }); break;
          case 'Transcription': onTranscription.emit({ text: msg.text, error: msg.error }); break;
          case 'SessionArtifact':
            onSessionArtifact.emit({ sessionId: msg.session_id, messageId: msg.message_id, artifact: msg.artifact });
            journalNotification('artifact', 'New artifact', msg.artifact.filename || msg.artifact.path, msg.session_id);
            break;
          case 'ArtifactLibrary': onArtifactLibrary.emit({ artifacts: msg.artifacts || [] }); break;
          case 'CostRollups': onCostRollups.emit({ rollups: msg.rollups }); break;
          case 'SessionMessageDeleted': onSessionMessageDeleted.emit({ sessionId: msg.session_id, messageId: msg.message_id }); break;
          case 'ChatSearchResults': onSearchResults.emit({ query: msg.query, results: msg.results || [] }); break;
          case 'ChatCheckpoints': onCheckpoints.emit({ sessionId: msg.session_id, checkpoints: msg.checkpoints || [] }); break;
          case 'SessionCheckpointRestored': onCheckpointRestored.emit({ sessionId: msg.session_id, checkpointId: msg.checkpoint_id, deletedMessages: msg.deleted_messages }); break;
          case 'SessionPermissionModeSet': onPermissionModeSet.emit({ sessionId: msg.session_id, mode: msg.mode }); break;
          case 'SessionQuestionRequest': onSessionQuestionRequest.emit({ sessionId: msg.session_id, pendingId: msg.pending_id, questions: (msg.questions as AgentQuestion[]) || [] }); break;
          case 'SessionQuestionResolved': onSessionQuestionResolved.emit({ pendingId: msg.pending_id }); break;
          case 'SessionCompacted': onSessionCompacted.emit({ sessionId: msg.session_id }); break;
          case 'ArtifactPreviewMsg': cacheArtifactPreview(msg.path, {
              path: msg.path, filename: msg.filename, ext: msg.ext, kind: msg.kind,
              text: msg.text ?? null, data_uri: msg.data_uri ?? null, truncated: msg.truncated,
            });
            _previewInFlight.delete(msg.path);
            onArtifactPreview.emit({ preview: {
              path: msg.path, filename: msg.filename, ext: msg.ext, kind: msg.kind,
              text: msg.text ?? null, data_uri: msg.data_uri ?? null, truncated: msg.truncated,
            }}); break;
          case 'ProjectList': onProjectList.emit({ projects: msg.projects || [] }); break;
          case 'AcpAgentList': onAcpAgentList.emit({ agents: msg.agents || [] }); break;
          case 'MemoryList': onMemoryList.emit({ records: msg.records || [] }); break;
          case 'MemoryUpdated': onMemoryMutated.emit({ memoryId: msg.memory_id }); break;
          case 'MemoryDeleted': onMemoryMutated.emit({ memoryId: msg.memory_id, removed: true }); break;
          case 'MemoryPurged': onMemoryMutated.emit({ memoryId: '', purged: msg.count }); break;
          case 'InstalledSkillList': onInstalledSkillList.emit({ skills: msg.skills || [] }); break;
          case 'InstalledSkillContent': onInstalledSkillContent.emit({ slug: msg.slug, kind: msg.kind, content: msg.content }); break;
          case 'InstalledSkillAck': onInstalledSkillAck.emit({ slug: msg.slug, mirrored: msg.mirrored }); break;
          case 'GitStatusMsg': onGitStatus.emit({ status: {
            is_repo: msg.is_repo, branch: msg.branch, dirty: msg.dirty, ahead: msg.ahead,
            behind: msg.behind, remote_url: msg.remote_url, changed_files: msg.changed_files || [],
          }}); break;
          case 'GitOutput': onGitOutput.emit({ output: msg.output }); break;
          case 'GitBranchesMsg': onGitBranches.emit({ branches: msg.branches || [] }); break;
          case 'GitLogMsg': onGitLog.emit({ entries: msg.entries || [] }); break;
          case 'BudgetList': onBudgetList.emit({ budgets: msg.budgets || [] }); break;
          case 'HiddenCostProjects': onHiddenCostProjects.emit({ projectIds: msg.project_ids || [] }); break;
          case 'ProjectUpserted': onProjectUpserted.emit({ project: msg.project }); break;
          case 'ProjectRemoved': onProjectRemoved.emit({ projectId: msg.project_id }); break;
          case 'ConnectorList': onConnectorList.emit({ connectors: msg.connectors || [] }); break;
          case 'SessionConnectors': onSessionConnectors.emit({ sessionId: msg.session_id, connectorIds: msg.connector_ids || [] }); break;
          case 'SessionConnectorsSet': onSessionConnectorsSet.emit({ sessionId: msg.session_id, connectorIds: msg.connector_ids || [] }); break;
          case 'AutomationList': onAutomationList.emit({ automations: msg.automations || [] }); break;
          case 'AutomationRuns': onAutomationRuns.emit({ automationId: msg.automation_id, runs: msg.runs || [] }); break;
          case 'AutomationUpdated': onAutomationUpdated.emit({ automationId: msg.automation_id }); break;
          case 'AutomationDeleted': onAutomationDeleted.emit({ automationId: msg.automation_id }); break;
          case 'AutomationRunStarted': onAutomationRunStarted.emit({ automationId: msg.automation_id }); break;
          case 'AutomationRunStopped': onAutomationRunStopped.emit({ automationId: msg.automation_id, stopped: msg.stopped }); break;
          case 'ChatSkills': onChatSkills.emit({ skills: msg.skills || [] }); break;
          case 'HarnessModels': onHarnessModels.emit({
              harnessId: msg.harness_id,
              models: msg.models || [],
              defaultModel: msg.default_model ?? null,
              endpoint: msg.endpoint ?? null,
              effort: msg.effort ?? null,
              effortOptions: msg.effort_options || [],
            }); break;
          case 'BudgetAlert': {
            onBudgetAlert.emit({ projectId: msg.project_id, projectName: msg.project_name, monthlyUsd: msg.monthly_usd, spentUsd: msg.spent_usd });
            journalNotification('budget', `Budget: ${msg.project_name}`, `Spent $${msg.spent_usd.toFixed(2)} of $${msg.monthly_usd.toFixed(2)}.`);
            Alert.alert(
              `Budget: ${msg.project_name}`,
              `Spent $${msg.spent_usd.toFixed(2)} of $${msg.monthly_usd.toFixed(2)} this month.`,
            );
            break;
          }
          case 'AutomationRunFinished': {
            onAutomationRunFinished.emit({ automationId: msg.automationId ?? null, status: msg.status, summary: msg.summary });
            journalNotification(
              'automation',
              msg.status === 'ok' ? `Automation: ${msg.name}` : `Automation failed: ${msg.name}`,
              msg.summary || '',
            );
            const ok = msg.status === 'ok';
            Alert.alert(
              ok ? `Automation finished: ${msg.name}` : `Automation failed: ${msg.name}`,
              msg.summary,
            );
            break;
          }
        }
      } catch (e) { console.error('parse error', e); }
    };
    // Reconnect with capped exponential backoff (reset on a successful pair
    // or an explicit URL/token change) — re-reading _url (not the captured
    // target) so a URL change between close and reconnect wins (audit M8).
    ws.onclose = () => {
      _connecting = false; stopPolling(); nc(false); nconnecting(false); _ws = null;
      if (_reconnectTimer === null) {
        const delay = _reconnectDelay;
        _reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
        _reconnectTimer = setTimeout(() => { _reconnectTimer = null; if (_url) _doConnect(_url); }, delay);
      }
    };
    ws.onerror = () => { _connecting = false; nc(false); nconnecting(false); };
  } catch (e) { _connecting = false; nc(false); nconnecting(false); }
}
function globalConnect(url?: string) {
  if (url) {
    // Explicit URL from the Settings field, a QR scan, or a deep link: use it
    // and persist it so the next cold start reconnects without re-entry. The
    // token rides in the URL fragment — that is the ONE stored copy (no
    // separate duplicate key). A fresh URL restarts the reconnect backoff.
    _url = url;
    _token = extractToken(url);
    resetReconnectBackoff();
    void AsyncStorage.setItem(RELAY_URL_STORAGE_KEY, url).catch(() => {});
    _doConnect(url);
    return;
  }
  // No explicit URL: use the persisted one once loaded. If none exists yet
  // (fresh install), stay disconnected — the Settings screen shows the URL
  // input whenever `connected` is false.
  void _storedUrlReady.then(() => { if (_url) _doConnect(_url); });
}
/** Pairing-token update from a token-only deep link (`relay://connect#<token>`).
 *  Such a link carries NO host, so it must never be fed to connect() as a
 *  URL — that overwrote the stored relay URL with the bare token string and
 *  un-paired the phone. Instead the token is spliced into the existing URL's
 *  fragment and the connection retried. */
function globalApplyPairingToken(token: string) {
  const base = _url ? _url.split('#')[0] : null;
  if (!base) {
    Alert.alert(
      'Pairing link',
      'This link only carries a token. Connect to the desktop once (Settings), then re-scan.',
    );
    return;
  }
  globalConnect(`${base}#${token}`);
}
/** The URL the relay is currently connected/connecting to (null before any
 *  successful or attempted connect). Used to prefill the Settings field. */
export function getRelayUrl(): string | null { return _url; }
/** The pairing token extracted from the current URL's fragment (null when no
 *  token is present — legacy/dev connect). Used by the Settings screen to
 *  show the token status. */
export function getRelayToken(): string | null { return _token; }
function globalDisconnect() { stopPolling(); resetReconnectBackoff(); if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; } if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; } _e2eKey = null; _outCounter = 0; _inCounter = 0; nc(false); nconnecting(false); }

// Stable sender identities (module-level) so screens can safely put them in
// useEffect dependency arrays — an inline arrow in the return object would
// change identity every render and re-fire effects on every state update.
function refreshProvidersSend() { _send({ type: 'ListAvailableProviders' }); }
function refreshCostSend() { _send({ type: 'GetCostSummary' }); }
function refreshCostDetailsSend() { _send({ type: 'GetCostDetails' }); }

export function useRelay() {
  const [connected, setConnected] = useState(_ws?.readyState === WebSocket.OPEN);
  const [connecting, setConnecting] = useState(_connecting);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [harnesses, setHarnessesState] = useState<HarnessInfo[]>(_harnesses);
  const [defaultModel, setDefaultModelState] = useState<{ provider: string; model: string } | null>(_defaults);
  const [costSummary, setCostSummary] = useState<CostSummary>({ today: 0, week: 0 });
  const [costDetails, setCostDetails] = useState<CostDetails>({ daily: [], per_project: [], local_models: [] });
  useEffect(() => {
    const c = (v: boolean) => setConnected(v);
    const cg = (v: boolean) => setConnecting(v);
    const p = (v: ProviderInfo[]) => setProviders(v);
    const s = (v: Session[]) => setSessions(v);
    const h = (v: HarnessInfo[]) => setHarnessesState(v);
    const d = (v: { provider: string; model: string } | null) => setDefaultModelState(v);
    const cs = (v: CostSummary) => setCostSummary(v);
    const cd = (v: CostDetails) => setCostDetails(v);
    _cl.add(c); _clConnecting.add(cg); _pl.add(p); _sl.add(s); _csl.add(cs); _cdl.add(cd);
    _hl.add(h); _dl.add(d);
    setConnected(_ws?.readyState === WebSocket.OPEN);
    setConnecting(_connecting);
    // Late-mounting screens (SessionChat's model sheet) must see the last
    // broadcast immediately — providers/harnesses only refresh every 30s,
    // so without this sync the sheet shows "no providers" for up to 30s.
    setProviders(_providers);
    setHarnessesState(_harnesses);
    setDefaultModelState(_defaults);
    return () => { _cl.delete(c); _clConnecting.delete(cg); _pl.delete(p); _sl.delete(s); _csl.delete(cs); _cdl.delete(cd); _hl.delete(h); _dl.delete(d); };
  }, []);
  const connect = useCallback((url?: string) => { globalConnect(url); }, []);
  const applyPairingToken = useCallback((token: string) => { globalApplyPairingToken(token); }, []);
  const disconnect = useCallback(() => { globalDisconnect(); }, []);
  const sendChatTurn = useCallback((pid: string, model: string, msgs: ChatMessage[], opts?: { system?: string; effort?: string; ggufPath?: string }) => {
    const p: MobileChatTurn = { type: 'ChatTurn', provider_id: pid, model, messages: msgs };
    if (opts?.system) p.system = opts.system;
    if (opts?.effort) p.effort = opts.effort;
    if (opts?.ggufPath) p.gguf_path = opts.ggufPath;
    _send(p);
  }, []);
  const sendToSession = useCallback((sid: string, text: string) => { _send({ type: 'SendToSession', session_id: sid, text }); }, []);
  const getTranscript = useCallback((sid: string) => { _send({ type: 'GetTranscript', session_id: sid }); }, []);
  useEffect(() => { if (!_ws && !_connecting) globalConnect(); }, []);

  // Session-scoped chat senders (Task 6). These go on the same WS connection
  // but route through SessionChatManager on the desktop, which manages the
  // owner map and persists messages on the chat_sessions table.
  const getSessionMessages = useCallback(
    (sessionId: string, beforeId?: number, limit = 50) => {
      queueMessageFetch(sessionId, beforeId !== undefined);
      _send({ type: 'GetSessionMessages', session_id: sessionId, before_id: beforeId, limit } as SessionChatMessage);
    },
    [],
  );
  const sendSessionChat = useCallback(
    (sessionId: string, text: string, attachments: SessionChatAttachment[] = []): boolean =>
      _send({ type: 'SendChatMessage', session_id: sessionId, text, attachments } as SessionChatMessage),
    [],
  );
  const cancelSessionStream = useCallback(
    (sessionId: string) => { _send({ type: 'CancelSessionStream', session_id: sessionId } as SessionChatMessage); },
    [],
  );
  const resolveSessionApproval = useCallback(
    (sessionId: string, pendingId: string, decision: 'approve' | 'deny', alwaysAllow = false) => {
      _send({ type: 'ResolveSessionApproval', session_id: sessionId, pending_id: pendingId, decision, always_allow: alwaysAllow } as SessionChatMessage);
    },
    [],
  );
  const setSessionModel = useCallback(
    (sessionId: string, providerId: string, model: string, effort?: string) => {
      _send({ type: 'SetSessionModel', session_id: sessionId, provider_id: providerId, model, effort } as SessionChatMessage);
    },
    [],
  );
  const deleteSession = useCallback(
    (sessionId: string) => {
      _send({ type: 'DeleteChatSession', session_id: sessionId } as SessionChatMessage);
    },
    [],
  );
  const getSessionMeta = useCallback(
    (sessionId: string) => {
      _send({ type: 'GetSessionMeta', session_id: sessionId } as SessionChatMessage);
    },
    [],
  );
  const registerPushToken = useCallback(
    (token: string, platform: string) => {
      _send({ type: 'RegisterPushToken', token, platform } as SessionChatMessage);
    },
    [],
  );
  const listSessionArtifacts = useCallback(
    (sessionId: string) => {
      _send({ type: 'ListSessionArtifacts', session_id: sessionId } as SessionChatMessage);
    },
    [],
  );
  const readArtifact = useCallback(
    (sessionId: string, path: string) => {
      _send({ type: 'ReadArtifact', session_id: sessionId, path } as SessionChatMessage);
    },
    [],
  );
  const transcribeAudio = useCallback(
    (dataBase64: string, mediaType?: string) => {
      _send({ type: 'TranscribeAudio', data_base64: dataBase64, media_type: mediaType } as SessionChatMessage);
    },
    [],
  );
  const resolvePlanProposal = useCallback(
    (sessionId: string, pendingId: string, approved: boolean, feedback?: string) => {
      _send({ type: 'ResolvePlanProposal', session_id: sessionId, pending_id: pendingId, approved, feedback } as SessionChatMessage);
    },
    [],
  );
  const renameSession = useCallback(
    (sessionId: string, title: string) => {
      _send({ type: 'RenameSession', session_id: sessionId, title } as SessionChatMessage);
    },
    [],
  );

// Stable sender identities — screens put these in effect dependency
// arrays, so a fresh arrow on every render turns any such effect into an
// infinite request loop (the Automations screen's flash was exactly this).
const _setSessionStarred = (sid: string, starred: boolean) => { _send({ type: 'SetSessionStarred', session_id: sid, starred }); };
const _listArtifacts = () => { _send({ type: 'ListArtifacts' }); };
const _requestHarnessModels = (harnessId: string) => { _send({ type: 'ListHarnessModels', harness_id: harnessId }); };
const _listChatSkills = () => { _send({ type: 'ListChatSkills' }); };
const _listAutomations = () => { _send({ type: 'ListAutomations' }); };
const _listProjects = () => { _send({ type: 'ListProjects' }); };
const _listAcpAgents = () => { _send({ type: 'ListAcpAgents' }); };
const _listMemoryRecords = (includeInactive?: boolean) => { _send({ type: 'ListMemoryRecords', include_inactive: includeInactive }); };
const _updateMemoryRecord = (memoryId: string, content: string, importance?: number) => { _send({ type: 'UpdateMemoryRecord', memory_id: memoryId, content, importance }); };
const _deleteMemoryRecord = (memoryId: string) => { _send({ type: 'DeleteMemoryRecord', memory_id: memoryId }); };
const _purgeMemories = () => { _send({ type: 'PurgeMemories' }); };
const _listInstalledSkills = (kind: string) => { _send({ type: 'ListInstalledSkills', kind }); };
const _readInstalledSkill = (slug: string, kind: string) => { _send({ type: 'ReadInstalledSkill', slug, kind }); };
const _saveInstalledSkill = (slug: string, kind: string, content: string) => { _send({ type: 'SaveInstalledSkill', slug, kind, content }); };
const _createInstalledSkill = (name: string, kind: string, content: string) => { _send({ type: 'CreateInstalledSkill', name, kind, content }); };
const _deleteInstalledSkill = (slug: string, kind: string) => { _send({ type: 'DeleteInstalledSkill', slug, kind }); };
const _makeInstalledSkillsGlobal = (kind: string) => { _send({ type: 'MakeInstalledSkillsGlobal', kind }); };
const _gitStatus = (projectId: string) => { _send({ type: 'GitStatus', project_id: projectId }); };
const _gitDiff = (projectId: string, path?: string) => { _send({ type: 'GitDiff', project_id: projectId, path }); };
const _gitCommit = (projectId: string, message: string) => { _send({ type: 'GitCommit', project_id: projectId, message }); };
const _gitPush = (projectId: string) => { _send({ type: 'GitPush', project_id: projectId }); };
const _gitBranches = (projectId: string) => { _send({ type: 'GitBranches', project_id: projectId }); };
const _gitLog = (projectId: string, limit?: number) => { _send({ type: 'GitLog', project_id: projectId, limit }); };
const _listBudgets = () => { _send({ type: 'ListBudgets' }); };
const _setBudget = (projectId: string, monthlyUsd: number, thresholdPct?: number) => { _send({ type: 'SetBudget', project_id: projectId, monthly_usd: monthlyUsd, threshold_pct: thresholdPct }); };
const _removeBudget = (projectId: string) => { _send({ type: 'RemoveBudget', project_id: projectId }); };
const _listHiddenCostProjects = () => { _send({ type: 'ListHiddenCostProjects' }); };
const _hideCostProject = (projectId: string) => { _send({ type: 'HideCostProject', project_id: projectId }); };
const _unhideCostProject = (projectId: string) => { _send({ type: 'UnhideCostProject', project_id: projectId }); };
const _addProject = (path: string, name?: string) => { _send({ type: 'AddProject', path, name }); };
const _renameProject = (projectId: string, name: string) => { _send({ type: 'RenameProject', project_id: projectId, name }); };
const _removeProject = (projectId: string) => { _send({ type: 'RemoveProject', project_id: projectId }); };
const _listConnectors = () => { _send({ type: 'ListConnectors' }); };
const _setSessionConnectors = (sessionId: string, connectorIds: string[]) => { _send({ type: 'SetSessionConnectors', session_id: sessionId, connector_ids: connectorIds }); };
const _getSessionConnectors = (sessionId: string) => { _send({ type: 'GetSessionConnectors', session_id: sessionId }); };
const _createAutomation = (input: Record<string, unknown>) => { _send({ type: 'CreateAutomation', input }); };
const _updateAutomation = (automationId: string, input: Record<string, unknown>) => { _send({ type: 'UpdateAutomation', automation_id: automationId, input }); };
const _deleteAutomation = (automationId: string) => { _send({ type: 'DeleteAutomation', automation_id: automationId }); };
const _setAutomationEnabled = (automationId: string, enabled: boolean) => { _send({ type: 'SetAutomationEnabled', automation_id: automationId, enabled }); };
const _runAutomationNow = (automationId: string) => { _send({ type: 'RunAutomationNow', automation_id: automationId }); };
const _stopAutomationRun = (automationId: string) => { _send({ type: 'StopAutomationRun', automation_id: automationId }); };
const _listAutomationRuns = (automationId: string, limit = 50) => { _send({ type: 'ListAutomationRuns', automation_id: automationId, limit }); };
const _getCostRollups = (days: number) => { _send({ type: 'GetCostRollups', days }); };
const _deleteChatMessage = (sessionId: string, messageId: number) => { _send({ type: 'DeleteChatMessage', session_id: sessionId, message_id: messageId }); };
const _editUserMessage = (sessionId: string, messageId: number, text: string) => { _send({ type: 'EditUserMessage', session_id: sessionId, message_id: messageId, text }); };
const _regenerateMessage = (sessionId: string) => { _send({ type: 'RegenerateMessage', session_id: sessionId }); };
const _listChatCheckpoints = (sessionId: string) => { _send({ type: 'ListChatCheckpoints', session_id: sessionId }); };
const _restoreChatCheckpoint = (sessionId: string, checkpointId: number, rollbackMessages = false) => { _send({ type: 'RestoreChatCheckpoint', session_id: sessionId, checkpoint_id: checkpointId, rollback_messages: rollbackMessages }); };
const _searchChatMessages = (query: string, limit = 50) => { _send({ type: 'SearchChatMessages', query, limit }); };
const _resolveSessionQuestion = (sessionId: string, pendingId: string, answers: Record<string, string | string[]>, response?: string) => { _send({ type: 'ResolveSessionQuestion', session_id: sessionId, pending_id: pendingId, answers, response }); };
const _setSessionPermissionMode = (sessionId: string, mode: string) => { _send({ type: 'SetSessionPermissionMode', session_id: sessionId, mode }); };
const _compactSession = (sessionId: string) => { _send({ type: 'CompactSession', session_id: sessionId }); };
const _cancelChatTurn = (id: string) => { _send({ type: 'CancelChatTurn', chat_session_id: id }); };
const _createSession = (pid: string, h: string, provider?: string, model?: string, effort?: string, connectors?: string[]) =>
  _send({ type: 'CreateSession', project_id: pid, harness: h, provider, model, effort, connectors });
const _spawnSession = (sid: string) => { _send({ type: 'SpawnSession', session_id: sid }); };
const _startLocalModel = (model: string, ggufPath: string) => { _send({ type: 'StartLocalModel', model, gguf_path: ggufPath }); };

  return { connected, desktopUnreachable: !connected, connecting, sessions, providers, harnesses, defaultModel, costSummary, costDetails, connect, applyPairingToken, disconnect, sendChatTurn, sendToSession, getTranscript,
    cancelChatTurn: _cancelChatTurn,
    setSessionStarred: _setSessionStarred,
    listArtifacts: _listArtifacts,
    requestHarnessModels: _requestHarnessModels,
    listChatSkills: _listChatSkills,
    listAutomations: _listAutomations,
    listProjects: _listProjects,
    listAcpAgents: _listAcpAgents,
    listMemoryRecords: _listMemoryRecords,
    updateMemoryRecord: _updateMemoryRecord,
    deleteMemoryRecord: _deleteMemoryRecord,
    purgeMemories: _purgeMemories,
    listInstalledSkills: _listInstalledSkills,
    readInstalledSkill: _readInstalledSkill,
    saveInstalledSkill: _saveInstalledSkill,
    createInstalledSkill: _createInstalledSkill,
    deleteInstalledSkill: _deleteInstalledSkill,
    makeInstalledSkillsGlobal: _makeInstalledSkillsGlobal,
    gitStatus: _gitStatus,
    gitDiff: _gitDiff,
    gitCommit: _gitCommit,
    gitPush: _gitPush,
    gitBranches: _gitBranches,
    gitLog: _gitLog,
    listBudgets: _listBudgets,
    setBudget: _setBudget,
    removeBudget: _removeBudget,
    listHiddenCostProjects: _listHiddenCostProjects,
    hideCostProject: _hideCostProject,
    unhideCostProject: _unhideCostProject,
    addProject: _addProject,
    renameProject: _renameProject,
    removeProject: _removeProject,
    listConnectors: _listConnectors,
    readArtifactPreview: requestArtifactPreviewFn,
    setSessionConnectors: _setSessionConnectors,
    getSessionConnectors: _getSessionConnectors,
    createAutomation: _createAutomation,
    updateAutomation: _updateAutomation,
    deleteAutomation: _deleteAutomation,
    setAutomationEnabled: _setAutomationEnabled,
    runAutomationNow: _runAutomationNow,
    stopAutomationRun: _stopAutomationRun,
    listAutomationRuns: _listAutomationRuns,
    getCostRollups: _getCostRollups,
    refreshProviders: refreshProvidersSend,
    refreshCost: refreshCostSend,
    refreshCostDetails: refreshCostDetailsSend,
    createSession: _createSession,
    spawnSession: _spawnSession,
    startLocalModel: _startLocalModel,
    // Session-scoped chat (Task 6).
    getSessionMessages,
    sendSessionChat,
    cancelSessionStream,
    resolveSessionApproval,
    renameSession,
    deleteChatMessage: _deleteChatMessage,
    editUserMessage: _editUserMessage,
    regenerateMessage: _regenerateMessage,
    listChatCheckpoints: _listChatCheckpoints,
    restoreChatCheckpoint: _restoreChatCheckpoint,
    searchChatMessages: _searchChatMessages,
    setSessionPermissionMode: _setSessionPermissionMode,
    resolveSessionQuestion: _resolveSessionQuestion,
    compactSession: _compactSession,
    setSessionModel,
    deleteSession,
    getSessionMeta,
    registerPushToken,
    listSessionArtifacts,
    readArtifact,
    transcribeAudio,
    resolvePlanProposal,
  };
}