// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";
import { ChatApprovalRequestPayload, ChatApprovalResolvedPayload, ChatArtifactPayload, ChatCheckpoint, ChatCitationReportPayload, ChatDonePayload, ChatErrorPayload, ChatMessageRecord, ChatOpenBrowserPayload, ChatOpenPreviewPayload, ChatPerfPayload, ChatStatusPayload, ChatTaskProgressPayload, ChatTokenPayload } from "../ipc";

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
 *  non-local / no-sidecar). `usedTokens` is a FULL prompt count —
 *  `cachedTokens` (the session's most recent cache report) is the slice to
 *  strip for the uncached figure the context meter displays. */
export interface ContextUsage {
  usedTokens: number | null;
  maxTokens: number;
  cachedTokens: number;
}
export const countContextTokens = (chatSessionId: string) =>
  safeInvoke<ContextUsage | null>("count_context_tokens", { chatSessionId });

/** Providers whose reported input_tokens already INCLUDES the cached prompt
 *  tokens (`prompt_tokens` ⊇ cached) — their raw input must have the
 *  cache-read slice stripped to get the uncached figure. Anthropic-style
 *  providers and harnesses report uncached input directly. Mirrors the
 *  backend's `provider_input_includes_cache` (chat/commands.rs). */
export const PROVIDER_INPUT_INCLUDES_CACHE = new Set([
  "openai",
  "openai_compatible",
  "openrouter",
  "local_gguf",
]);

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
export const listenChatCitationReport = (handler: (payload: ChatCitationReportPayload) => void) =>
  safeListen<ChatCitationReportPayload>("chat:citation-report", handler);
/** Full JSON detail of a session's most recent citation-integrity verdict —
 *  the "Fix citations" repair action feeds it back to the model. */
export const getResearchCitationReport = (chatSessionId: string) =>
  safeInvoke<string | null>("research_citation_report", { chatSessionId });
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
