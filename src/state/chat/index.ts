// Chat store: sessions, messages, live streaming state, config, and all actions.
// Mirrors the style of src/state/projects.ts and src/state/settings.ts.
//
// IMPORTANT: all streaming updates are keyed by chatSessionId, NOT by
// "active session", so streams complete correctly even if the user switches
// to a different chat in the sidebar.
//
// Architecture (audit 2026-09-13 §1): this was a 3,739-line god file. The
// store is now assembled from domain slices in ./slices/* — one flat
// ChatState object (unchanged shape, so every selector and render behaves
// exactly as before), with shared module-level caches/helpers in
// ./moduleState and the domain types in ./types. All previously exported
// names are re-exported below, so `state/chat` import paths are unchanged.
import { create } from "zustand";

import { createApprovalsSlice } from "./slices/approvalsSlice";
import { createArtifactsSlice } from "./slices/artifactsSlice";
import { createBuffersSlice } from "./slices/buffersSlice";
import { createComposerSlice } from "./slices/composerSlice";
import { createConfigSlice } from "./slices/configSlice";
import { createLoopsSlice } from "./slices/loopsSlice";
import { createMeshSlice } from "./slices/meshSlice";
import { createPanesSlice } from "./slices/panesSlice";
import { createPerfSlice } from "./slices/perfSlice";
import { createPlansSlice } from "./slices/plansSlice";
import { createSessionsSlice } from "./slices/sessionsSlice";
import { createStreamingSlice } from "./slices/streamingSlice";
import type { ChatState } from "./types";

export type { ArtifactProposal, PlanTodo } from "../../lib/ipc";
export type {
  ApprovalPolicy,
  ChatArtifact,
  ChatState,
  ChatTaskProgress,
  HarnessModeOption,
  LastTurnMetrics,
  LoopDecision,
  LoopState,
  PendingApproval,
  PendingPlanProposal,
  PendingQuestion,
  PermissionMode,
  PlanStep,
  QueuedChatMessage,
  SandboxPolicy,
  WatchMode,
} from "./types";
export {
  GOAL_LOOP_MAX,
  HARNESS_PERMISSION_MODES,
  clearStreamState,
  liveAttachmentsForMessage,
  mergeOptimistic,
  parseLoopStatus,
  permissionModeToPolicies,
  policiesToPermissionMode,
  rememberLiveAttachments,
  selectContextSessionId,
} from "./moduleState";

export const useChatStore = create<ChatState>((set, get) => ({
  loaded: false,
  sessions: [],
  activeChatSessionId: null,
  messages: [],
  messagesSessionId: null,
  hasMoreHistory: false,
  focusedChatSessionId: null,
  chatPaneTree: null,
  paneBuffers: {},
  rememberedChatPaneState: null,
  focusedPaneId: null,
  streaming: {},
  streamingChatSessionId: null,
  chatStatus: {},
  supersededPartial: {},
  config: null,
  lastSelection: null,
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
  meshMail: {},
  meshMailBySession: {},
  meshChildren: {},
  ownerSessionByChatId: {},
  cwdOverrides: {},
  sessionProjects: {},
  messageQueue: {},
  composerDrafts: {},

  livePerf: {},
  lastTurnPerf: {},
  sessionMetrics: {},
  loopState: {},
  stoppedPartial: {},
  citationReports: {},

  ...createSessionsSlice(set, get),
  ...createBuffersSlice(set, get),
  ...createPanesSlice(set, get),
  ...createComposerSlice(set, get),
  ...createLoopsSlice(set, get),
  ...createStreamingSlice(set, get),
  ...createArtifactsSlice(set, get),
  ...createApprovalsSlice(set, get),
  ...createPlansSlice(set, get),
  ...createPerfSlice(set, get),
  ...createConfigSlice(set, get),
  ...createMeshSlice(set, get),
}));

// NOTE: browsing a project (selectProject) must NEVER rebind the active
// chat to it. A chat's project binding (sessionProjects) is explicit — set
// only by "New chat for project", newChat's bind param, unbindProject, or
// the legacy send-time bind in newChat. selectSession pushes the chat's
// binding back into the global selection (binding → selection), so opening
// a chat highlights its project; the reverse direction (selection → binding)
// is intentionally absent so that clicking around the sidebar to browse
// projects does not move the chat you're viewing into them.
