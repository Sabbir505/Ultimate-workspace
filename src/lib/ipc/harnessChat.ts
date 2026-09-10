// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen, tauriRuntimeAvailable as tauriAvailable } from "../ipcCore";
import { ArtifactPreview, ChatPlanAcceptedPayload, ChatPlanModePayload, ChatPlanProposalPayload, ChatPlanUpdatedPayload, PlanStepProgressPayload, toastError } from "../ipc";

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
    .catch((err) => console.warn("[relay] emitMobileSessionChatEvent failed", err));
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

/** Resolve one plan-compiled document run (see DocDesignRunner): the produced
 *  file as base64, or an error, plus the JSON-encoded QA issue list from plan
 *  validation and compile-time invariants. */
export const docdesignComplete = (args: {
  requestId: string;
  base64?: string;
  error?: string;
  issuesJson?: string;
  payloadKind?: string;
}) => safeInvoke<null>("docdesign_complete", args);

/** Resolve one docdesign render-probe round (`docdesign://qa`): the QA issue
 *  list measured on the rendered PDF, plus its page count. */
export const docdesignQaComplete = (args: {
  requestId: string;
  issuesJson?: string;
  pageCount?: number;
}) => safeInvoke<null>("docdesign_qa_complete", args);

/** Design-QA verdict for a generated document (keyed by artifact path). */
export interface DocQaReportPayload {
  path: string;
  filename: string;
  passed: string[];
  warnings: string[];
  probes: string[];
  pageCount: number;
  critic: string;
  clean: boolean;
}
export const listenDocQa = (handler: (payload: DocQaReportPayload) => void) =>
  safeListen<DocQaReportPayload>("chat:doc-qa", handler);

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

/**
 * Open a generated artifact file with the OS default application.
 *
 * Runs through the backend's `open_artifact_external` (not the JS opener
 * plugin) so failures are visible: this toasts the reason instead of the old
 * silent `console.warn`, and the backend re-discovers a moved file by
 * basename before giving up. Never throws — call sites can just `void` it.
 */
export async function openArtifact(path: string): Promise<void> {
  try {
    await safeInvoke<string>("open_artifact_external", { path });
  } catch (err) {
    toastError("Could not open the file in its default app", err);
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
