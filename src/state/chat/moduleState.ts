// Module-level constants, caches, and pure/shared helpers for the chat store.
// Split out of the former 3,739-line src/state/chat.ts (architecture audit
// 2026-09-13 §1).
//
// The mutable caches here (deletedSessions, manuallyRenamed, fullAccessConfirmed,
// liveAttachmentCache, NEXT_QUEUE_ID, artifactLoadTimer) deliberately live
// OUTSIDE the zustand store: liveAttachmentCache is read during React render
// (MessageBubble) and must not participate in store identity, and the rest are
// run-scoped tombstones/sets the store actions consult.
import type {
  ChatAttachmentInput,
  ChatMessageRecord,
  ChatSession,
} from "../../lib/ipc";
import {
  ensureChatSessionWorktree,
  getChatMessages,
  getSetting,
  toastError,
} from "../../lib/ipc";
import { useArtifactsStore } from "../artifacts";
import { useProjectsStore } from "../projects";
import type {
  ApprovalPolicy,
  ChatState,
  ChatStoreSet,
  HarnessModeOption,
  PermissionMode,
  PendingApproval,
  PendingPlanProposal,
  PendingQuestion,
  SandboxPolicy,
} from "./types";

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
export function isCliAgent(agent: string | null | undefined): agent is string {
  return !!agent && (agent.startsWith("harness:") || agent.startsWith("acp:"));
}

/** Extract the adapter/agent id from a "harness:<id>" / "acp:<id>" value. */
export function cliAgentId(agent: string): string {
  return agent.startsWith("acp:") ? agent.slice("acp:".length) : agent.slice("harness:".length);
}

/** Streaming-buffer tail cap (code points) with hysteresis (audit A5): the
 *  buffer grows to cap+margin (210K) and is then trimmed ONCE back to
 *  cap−margin (190K), instead of re-slicing the ~200K-char buffer on every
 *  token once the cap was reached. Worst case stays bounded at cap+margin. */
export const STREAM_TAIL_CAP = 200_000;
/** Per-session mail history cap in the Git-sidebar Mesh section (older
 *  transitions age out of the UI; the durable audit trail is the DB). */
export const MESH_MAIL_HISTORY_CAP = 30;
/** Total mail-record cap for the Mesh store's `meshMail` map (keyed by
 *  mailId — the per-session lists above cap separately). The durable audit
 *  trail is the DB; this is only the sidebar's in-memory cache. */
export const MESH_MAIL_RECORDS_CAP = 100;
export const STREAM_TAIL_MARGIN = 10_000;

/** Session list with tombstoned (deleted-this-run) sessions removed. */
export function withoutDeleted(sessions: ChatSession[]): ChatSession[] {
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
  // One-to-one matching: each fetched row consumes (explains) at most ONE
  // optimistic twin. A Set let the SECOND identical optimistic send (the same
  // text queued and drained twice) be "explained" by the first send's
  // persisted row, silently dropping one of the user's messages.
  const unfetched = new Map<string, number>();
  for (const f of fetched) {
    const k = key(f);
    unfetched.set(k, (unfetched.get(k) ?? 0) + 1);
  }
  const missing = optimistic.filter((o) => {
    const k = key(o);
    const left = unfetched.get(k) ?? 0;
    if (left > 0) {
      unfetched.set(k, left - 1);
      return false;
    }
    return true;
  });
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

export function markDeleted(sid: string) {
  deletedSessions.set(sid, Date.now());
  capMap(deletedSessions, SET_CAP);
}

/** Tombstone check: was this session deleted during the current app run? */
export function isDeletedSession(sid: string): boolean {
  return deletedSessions.has(sid);
}

export function markManuallyRenamed(sid: string) {
  manuallyRenamed.set(sid, Date.now());
  capMap(manuallyRenamed, SET_CAP);
}

export function hasManuallyRenamed(sid: string): boolean {
  return manuallyRenamed.has(sid);
}

export function clearManuallyRenamed(sid: string) {
  manuallyRenamed.delete(sid);
}

/** Sessions in which the user has already confirmed the full_access approval
 *  modal this app run — the one-time confirmation isn't re-shown per session.
 *  (The policy itself persists in the DB; this set only suppresses
 *  re-prompting.) */
const fullAccessConfirmed = new Set<string>();

export function markFullAccessConfirmed(sid: string) {
  fullAccessConfirmed.add(sid);
  if (fullAccessConfirmed.size > SET_CAP) {
    fullAccessConfirmed.delete(fullAccessConfirmed.values().next().value as string);
  }
}

export function hasFullAccessConfirmed(sid: string): boolean {
  return fullAccessConfirmed.has(sid);
}

/** Extensions that auto-open a tool-panel tab when the agent produces them.
 *  Deliberately ONLY finished, viewable deliverables (a diagram PNG, a PDF
 *  report, an office doc). Everything else — html/tsx/jsx/css/json/… source
 *  files the agent writes — lands in the Artifacts gallery WITHOUT popping a
 *  tab: coding sessions used to open a pane per file write, which was noisy.
 *  The agent shows those deliberately via the `open_file` tool, and svg
 *  renders inline in the bubble (handled separately in onArtifact). */
export const AUTO_OPEN_ARTIFACT_EXTS = new Set([
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

/** Monotonic id for queued messages — `Date.now()` collided when two
 *  messages stacked within the same millisecond, and steer/edit/delete act
 *  BY ID (the collision made steer remove both rows). In-memory only, so a
 *  plain counter is sufficient. */
export const queueIdCounter = { next: 1 };

/** Monotonic id for optimistic user bubbles (negative, counting down) — the
 *  old `-Date.now()` gave two sends in the same millisecond the same id,
 *  colliding React keys and confusing mergeOptimistic's row accounting.
 *  Same mechanism as queueIdCounter; in-memory only. */
export const optimisticMsgIdCounter = { next: -1 };

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
export function sortSessions(list: ChatSession[]): ChatSession[] {
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
export function clearSessionState(s: ChatState, chatSessionId: string): Partial<ChatState> {
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
  const artifactProposals = { ...s.artifactProposals };
  delete artifactProposals[chatSessionId];
  const lastTurnPerf = { ...s.lastTurnPerf };
  delete lastTurnPerf[chatSessionId];
  const stoppedPartial = { ...s.stoppedPartial };
  delete stoppedPartial[chatSessionId];
  const supersededPartial = { ...s.supersededPartial };
  delete supersededPartial[chatSessionId];
  const citationReports = { ...s.citationReports };
  delete citationReports[chatSessionId];
  const meshMailBySession = { ...s.meshMailBySession };
  delete meshMailBySession[chatSessionId];
  const meshChildren = { ...s.meshChildren };
  delete meshChildren[chatSessionId];
  // meshMail is keyed by mailId (not session id) — drop the records in which
  // the deleted session is either party.
  let meshMail = s.meshMail;
  for (const [mailId, mail] of Object.entries(s.meshMail)) {
    if (mail.fromSession === chatSessionId || mail.toSession === chatSessionId) {
      if (meshMail === s.meshMail) meshMail = { ...s.meshMail };
      delete meshMail[mailId];
    }
  }
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
    artifactProposals,
    lastTurnPerf,
    stoppedPartial,
    supersededPartial,
    citationReports,
    meshMail,
    meshMailBySession,
    meshChildren,
    artifactsByMessage,
    checkpointsByMessage,
    streamingChatSessionId:
      s.streamingChatSessionId === chatSessionId ? null : s.streamingChatSessionId,
    fullAccessConfirmingFor:
      s.fullAccessConfirmingFor === chatSessionId ? null : s.fullAccessConfirmingFor,
  };
}

/** The session whose context the shared UI should display: the split-pane
 *  focus pin when set, else the plain active session. Toolbar title, folder/
 *  git notches, and the git tools sidebar all select through this so their
 *  data follows whichever chat the user is working in. */
export const selectContextSessionId = (s: ChatState): string | null =>
  s.focusedChatSessionId ?? s.activeChatSessionId;

// P-3: per-session cap for the onArtifact tracking map (see onArtifact).
export const MAX_ARTIFACTS_PER_SESSION = 200;

// Debounced artifacts-library refresh (audit #19): a single turn can emit
// many `chat:artifact` events, and each one used to trigger a full
// list_artifacts reload. Coalesce the burst into one trailing reload.
let artifactLoadTimer: ReturnType<typeof setTimeout> | null = null;
export const scheduleArtifactLibraryLoad = () => {
  if (artifactLoadTimer !== null) clearTimeout(artifactLoadTimer);
  artifactLoadTimer = setTimeout(() => {
    artifactLoadTimer = null;
    void useArtifactsStore.getState().load().catch(() => {});
  }, 1500);
};

/** Shallow-copy a per-session map without `key` — the store idiom for
 *  optimistic removals (`const next = { ...map }; delete next[k]; return …`). */
export function omitKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

type PendingCardMaps = Pick<
  ChatState,
  "pendingApprovals" | "pendingQuestions" | "pendingPlanProposals"
>;
type PendingCard = PendingApproval | PendingQuestion | PendingPlanProposal;

/** Shared body of the resolve* actions: optimistically drop the session's
 *  pending card, run the resolver IPC, and on failure put the card back and
 *  toast — the turn is still paused on the card, so losing it would hang the
 *  turn with no way to retry (audit M3). */
export async function resolvePendingCard(
  get: () => ChatState,
  set: (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void,
  mapKey: keyof PendingCardMaps,
  chatSessionId: string,
  toastTitle: string,
  call: (pending: PendingCard) => Promise<void>,
): Promise<void> {
  const pending = get()[mapKey][chatSessionId] as PendingCard | undefined;
  if (!pending) return;
  set((s) =>
    ({ [mapKey]: omitKey(s[mapKey] as Record<string, PendingCard>, chatSessionId) } as Partial<ChatState>),
  );
  try {
    await call(pending);
  } catch (err) {
    set((s) =>
      ({
        [mapKey]: { ...(s[mapKey] as Record<string, PendingCard>), [chatSessionId]: pending },
      } as Partial<ChatState>),
    );
    toastError(toastTitle, err);
  }
}

/** Store-key bundles for the two chat buffers (main pane vs split pane):
 *  loadMessages/loadSplitMessages and the older-page loaders are the same
 *  algorithm over different keys, guarded by the pane's own target session. */
export const CHAT_BUFFER_KEYS = {
  main: {
    messages: "messages",
    sessionId: "messagesSessionId",
    hasMore: "hasMoreHistory",
    target: "activeChatSessionId",
  },
  split: {
    messages: "splitMessages",
    sessionId: "splitMessagesSessionId",
    hasMore: "splitHasMoreHistory",
    target: "splitChatSessionId",
  },
} as const;
export type ChatBuffer = keyof typeof CHAT_BUFFER_KEYS;

/** Shallow-patch one session row by id inside a sessions list — the store
 *  idiom `sessions.map((sess) => sess.id === id ? { ...sess, patch } : sess)`. */
export function patchSessions(
  sessions: ChatState["sessions"],
  id: string,
  patch: Partial<ChatState["sessions"][number]>,
): ChatState["sessions"] {
  return sessions.map((sess) => (sess.id === id ? { ...sess, ...patch } : sess));
}

/** Load the latest page of one buffer (M7: long sessions no longer
 *  deserialize their full history on open; older pages prepend via
 *  loadBufferOlder). */
export async function loadBufferPage(
  get: () => ChatState,
  set: ChatStoreSet,
  buf: ChatBuffer,
  chatSessionId: string,
): Promise<void> {
  const k = CHAT_BUFFER_KEYS[buf];
  const messages = await getChatMessages(chatSessionId, undefined, 200);
  set((s) => ({
    // mergeOptimistic: a session opened while its queued message is mid-
    // drain keeps the in-flight bubble instead of snapping back to the
    // pre-persist snapshot.
    [k.messages]:
      s[k.target] === chatSessionId
        ? mergeOptimistic(s[k.messages], messages ?? [])
        : s[k.messages],
    [k.sessionId]: s[k.target] === chatSessionId ? chatSessionId : s[k.sessionId],
    [k.hasMore]: s[k.target] === chatSessionId ? (messages?.length ?? 0) >= 200 : s[k.hasMore],
  }) as Partial<ChatState>);
}

/** Prepend one older page into a buffer, deduped by id. Returns the number
 *  of fresh rows (0 also when the pane's flag says history is exhausted —
 *  an unguarded flag write while the user switched panes would kill infinite
 *  scroll for the newly-viewed chat, audit L1). */
export async function loadBufferOlder(
  get: () => ChatState,
  set: ChatStoreSet,
  buf: ChatBuffer,
  chatSessionId: string,
): Promise<number> {
  const k = CHAT_BUFFER_KEYS[buf];
  const first = get()[k.messages][0];
  if (!first || first.id <= 0 || !get()[k.hasMore]) return 0;
  const older = await getChatMessages(chatSessionId, first.id, 200);
  if (!older || older.length === 0) {
    if (get()[k.target] === chatSessionId) {
      set({ [k.hasMore]: false } as Partial<ChatState>);
    }
    return 0;
  }
  set((s) => {
    if (s[k.target] !== chatSessionId) return s;
    // Dedupe by id (the page boundary row may overlap).
    const known = new Set(s[k.messages].map((m) => m.id));
    const fresh = older.filter((m) => !known.has(m.id));
    return {
      [k.messages]: [...fresh, ...s[k.messages]],
      [k.hasMore]: older.length >= 200,
    } as Partial<ChatState>;
  });
  return older.length;
}

/** Shared cleanup for terminal streaming events (cancel / done / error /
 *  remote-turn-end): drop the session's streaming buffer and status notice,
 *  and null streamingChatSessionId when it points at this session (all four
 *  terminal paths share the rule; callers spread their own extras — livePerf,
 *  stoppedPartial, pending maps — on top). */
export function clearStreamState(s: ChatState, id: string): Partial<ChatState> {
  return {
    streaming: omitKey(s.streaming, id),
    chatStatus: omitKey(s.chatStatus, id),
    // The turn is over: a superseded partial has either been persisted (error
    // path) or replaced by a completed answer (done path).
    supersededPartial: omitKey(s.supersededPartial, id),
    streamingChatSessionId: s.streamingChatSessionId === id ? null : s.streamingChatSessionId,
  };
}

/** Worktree-per-session default (roadmap P0 §3.1.1): give a fresh chat on a
 *  git project its own isolated worktree, and patch the session row when the
 *  path resolves. Fires-and-forgets by design — the send path falls back to
 *  the project root until (or unless) the worktree exists, so this must NEVER
 *  block session creation or a send. Skipped when the chat is unbound, already
 *  isolated, the project isn't a git repo, or the global default is off.
 *  Takes the store's `set` so it can live beside the slice actions that call
 *  it (the old version reached into `useChatStore.setState` from module scope). */
export async function maybeEnsureWorktree(
  session: ChatSession | null | undefined,
  set: ChatStoreSet,
): Promise<void> {
  if (!session?.id || !session.projectId || session.worktreePath) return;
  const enabled = (await getSetting("worktrees.defaultEnabled").catch(() => null)) !== "false";
  if (!enabled) return;
  const project = useProjectsStore.getState().projectById(session.projectId);
  if (!project?.isGitRepo) return;
  try {
    const path = await ensureChatSessionWorktree(session.id);
    if (path) {
      set((s) => ({
        sessions: patchSessions(s.sessions, session.id, { worktreePath: path }),
      }));
    }
  } catch {
    // Best-effort: the chat works in the project root instead.
  }
}
