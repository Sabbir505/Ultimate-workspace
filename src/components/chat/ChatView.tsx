// ChatView: full main-area chat interface shown when activeView === "chat".
// Flex column layout: scrollable message list + bottom composer.
// Shows an empty state when no chat session is selected.
// Live streaming: accumulates tokens into an assistant bubble that updates
// as they arrive, then swaps to the final persisted message on chat:done.
//
// BUNDLE: MessageBubble is the heaviest chat component (react-markdown +
// katex + remark-gfm + remark-math + rehype-katex). The empty welcome screen
// doesn't render any bubbles at all, so MessageBubble is lazy-loaded — the
// initial chat page only fetches the bubble code when the first message
// arrives. TypingIndicator stays eager (it's a 3-line spinner).
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useChatStore } from "../../state/chat";
import { useProjectsStore } from "../../state/projects";
import { useSettingsStore } from "../../state/settings";
import { useUiStore } from "../../state/ui";
import { ChatComposer, type ChatAttachment } from "./ChatComposer";
import { ApprovalCard, FullAutoConfirmModal } from "./ApprovalFlow";
import { QuestionCard } from "./QuestionCard";
import { PlanProposalCard } from "./PlanProposalCard";
import type { PermissionMode } from "../../state/chat";
import { HARNESS_PERMISSION_MODES, permissionModeToPolicies } from "../../state/chat";
import type { ChatPerfPayload } from "../../lib/ipc";
// TypingIndicator is tiny and eager — imported from its own module so the
// entry chunk doesn't statically pull in MessageBubble (react-markdown).
import { TypingIndicator } from "./TypingIndicator";
import { CitationReportStrip } from "./CitationReportStrip";
import { ChatWelcome } from "./ChatWelcome";
const MessageBubble = lazy(() => import("./MessageBubble").then((m) => ({ default: m.MessageBubble })));
// Heavy chat features (artifact previews with syntax-highlighting + markdown,
// inline mermaid diagrams, file diff cards) are split into separate chunks so
// the initial chat page only downloads the message + composer code. The
// previews download lazily the first time an artifact is previewed; the
// mermaid diagram chunk downloads lazily on first diagram render (via its own
// internal `import('mermaid')`); the diff card chunk downloads on first
// edit-tool call. None of these appear on the empty welcome screen.
const TaskProgressCard = lazy(() => import("./TaskProgressCard").then((m) => ({ default: m.TaskProgressCard })));
const ArtifactProposalCard = lazy(() => import("./ArtifactProposalCard").then((m) => ({ default: m.ArtifactProposalCard })));
import { listHarnessModels, stopLocalModel, localModelStatus, deleteEmptyChatSessions, setLocalModelOverrides, type ChatMessage, type GgufModel, type HarnessModelConfig, type LlamaOverrides, regenerateArtifact, createArtifact, type ArtifactProposal, type ArtifactSpec, type ArtifactProvenance, getAgentActualModel, getResearchCitationReport, PROVIDER_INPUT_INCLUDES_CACHE } from "../../lib/ipc";
import { harnessModelCatalog } from "../../lib/harnessModels";
import { setChatSelectionPrefill } from "../../lib/chatSelection";
import { useTranscriptScroll } from "./useTranscriptScroll";
import { useLocalModelSidecar } from "./useLocalModelSidecar";
import type { AgentModelSelection } from "./AgentModelPicker";
import { seedSelectionFrom } from "../../lib/lastSelection";
import { TurnNavigator } from "./TurnNavigator";
import { useContextMeter } from "../../hooks/useContextMeter";
import { GitToolsSidebar } from "./GitToolsSidebar";

/** Downward chevron-arrow for the jump-to-latest pill. */
function ArrowDownIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

/** Format a backend error message for display. Strips raw JSON blobs,
 *  extracts the human-readable message, and keeps it to one line. */
function formatChatError(raw: string): string {
  // If the error looks like JSON, try to extract a readable message.
  if (raw.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const msg =
        parsed.message ||
        (parsed.error as { message?: string })?.message ||
        parsed.error ||
        parsed.detail ||
        parsed.msg ||
        parsed.error_message;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
    } catch {
      /* not valid JSON — fall through */
    }
  }
  // Strip verbose provider error prefixes.
  return raw
    .replace(/^Error:\s*/i, "")
    .replace(/^HTTP \d+:\s*/, "")
    .replace(/\{[^}]*\}/g, "") // remove any inline JSON objects
    .trim();
}

export function ChatView({ popoutSessionId, splitSessionId }: { popoutSessionId?: string; splitSessionId?: string } = {}) {
  // Split view: `splitSessionId` pins this instance to ONE session regardless
  // of the global selection — the pane beside the main chat. Everything below
  // keys off the local `activeChatSessionId`, so per-session maps (streaming,
  // status, artifacts, tasks, plans, subagents) resolve for the right session
  // in both modes; only the message buffer needs an explicit split-aware
  // selector (the store keeps two lists).
  const storeActiveId = useChatStore((s) => s.activeChatSessionId);
  const isSplitView = splitSessionId != null;
  const activeChatSessionId = splitSessionId ?? storeActiveId;
  // Split-view focus pin: which half the shared git rail belongs to (null =
  // the main half). See the GitToolsSidebar render condition below.
  const focusedPin = useChatStore((s) => s.focusedChatSessionId);
  const messages = useChatStore((s) => (isSplitView ? s.splitMessages : s.messages));
  const streaming = useChatStore((s) => s.streaming);
  const livePerf = useChatStore((s) => s.livePerf);
  const chatStatus = useChatStore((s) => s.chatStatus);
  const error = useChatStore((s) => s.error);
  const loaded = useChatStore((s) => s.loaded);
  const lastSelection = useChatStore((s) => s.lastSelection);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const regenerate = useChatStore((s) => s.regenerate);
  const editMessage = useChatStore((s) => s.editMessage);
  const cancelStream = useChatStore((s) => s.cancelStream);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const setPreviewArtifact = useChatStore((s) => s.setPreviewArtifact);
  const startLoop = useChatStore((s) => s.startLoop);
  const sessions = useChatStore((s) => s.sessions);
  const setSessionModel = useChatStore((s) => s.setSessionModel);
  const setSessionProvider = useChatStore((s) => s.setSessionProvider);
  const setSessionAgent = useChatStore((s) => s.setSessionAgent);
  const setSessionAuto = useChatStore((s) => s.setSessionAuto);
  const effort = useChatStore((s) => s.effort);
  const setEffort = useChatStore((s) => s.setEffort);
  // Auto routing bias (Quality/Balanced/Economy) — settings store, persisted
  // as chat.auto.bias and read by the backend resolver.
  const autoBias = useSettingsStore((s) => s.autoBias);
  const setAutoBias = useSettingsStore((s) => s.setAutoBias);
  const localCtx = useChatStore((s) => s.localCtx);
  const setLocalCtx = useChatStore((s) => s.setLocalCtx);
  const thinking = useChatStore((s) => s.thinking);
  const setThinking = useChatStore((s) => s.setThinking);
  const config = useChatStore((s) => s.config);
  const loadConfig = useChatStore((s) => s.loadConfig);
  const newChat = useChatStore((s) => s.newChat);
  const pushToast = useUiStore((s) => s.pushToast);
  const artifacts = useChatStore((s) =>
    activeChatSessionId ? s.artifacts[activeChatSessionId] : undefined,
  );
  const artifactsByMessage = useChatStore((s) => s.artifactsByMessage);
  const artifactProposalsBySession = useChatStore((s) => s.artifactProposals);
  const addArtifactProposal = useChatStore((s) => s.addArtifactProposal);
  const updateArtifactProposal = useChatStore((s) => s.updateArtifactProposal);
  const removeArtifactProposal = useChatStore((s) => s.removeArtifactProposal);
  const getArtifactProposals = useChatStore((s) => s.getArtifactProposals);
  const editArtifactProposal = useChatStore((s) => s.editArtifactProposal);
  const sessionTaskMap = useChatStore((s) =>
    activeChatSessionId ? (s.tasks[activeChatSessionId] ?? {}) : null,
  );
  const sessionTasks = /*@__PURE__*/ useMemo(
    () => (sessionTaskMap ? Object.values(sessionTaskMap) : []),
    [sessionTaskMap],
  );

  const activeSession = sessions.find((s) => s.id === activeChatSessionId) ?? null;
  const isLocal = activeSession?.provider === "local_gguf";
  // CLI agent selected for this session ("harness:<id>") — the model chip is
  // populated from the CLI's OWN config files (settings.json / config.toml /
  // opencode.json via listHarnessModels), merged with the static catalog as a
  // fallback. Sends for these sessions route to the headless CLI process
  // (agent_sessions.rs), not the built-in provider path.
  const harnessAgent = activeSession?.agent?.startsWith("harness:")
    ? activeSession.agent.slice("harness:".length)
    : null;
  // ACP agent selected ("acp:<id>", roadmap #20) — Zed/Devin-ecosystem CLIs
  // speaking Agent Client Protocol over stdio. No model picker (the agent
  // decides), no approval channel, and sends route to the same headless path.
  const acpAgent = activeSession?.agent?.startsWith("acp:")
    ? activeSession.agent.slice("acp:".length)
    : null;
  const [harnessCfg, setHarnessCfg] = useState<HarnessModelConfig | null>(null);
  const [harnessLoading, setHarnessLoading] = useState(false);

  // Discover the CLI's configured models/endpoint whenever the agent changes.
  // The agent chip shows a spinner while this runs (live CLI queries like
  // `opencode models` can take a second or two).
  useEffect(() => {
    if (!harnessAgent) {
      setHarnessCfg(null);
      setHarnessLoading(false);
      return;
    }
    let cancelled = false;
    setHarnessLoading(true);
    void listHarnessModels(harnessAgent)
      .then((cfg) => {
        if (!cancelled) setHarnessCfg(cfg);
      })
      .finally(() => {
        if (!cancelled) setHarnessLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [harnessAgent]);

  // Config-discovered models first, then static-catalog entries the config
  // didn't mention (e.g. built-in aliases a stock setup still accepts).
  const harnessModels = useMemo(() => {
    if (!harnessAgent) return [];
    const fromCfg = harnessCfg?.models ?? [];
    const cfgIds = new Set(fromCfg.map((m) => m.id));
    const extra = harnessModelCatalog(harnessAgent).filter((m) => !cfgIds.has(m.id));
    return [...fromCfg, ...extra];
  }, [harnessAgent, harnessCfg]);

  // id → label map for the composer's agent chip. MEMOIZED: a fresh object
  // per render would defeat the ChatComposer memo and re-render the whole
  // composer (and its children) on every streaming flush.
  const modelLabels = useMemo(
    () =>
      harnessAgent
        ? Object.fromEntries(harnessModels.map((m) => [m.id, m.label]))
        : undefined,
    [harnessAgent, harnessModels],
  );

  // A fresh harness chat with no model yet adopts the CLI's configured
  // default (settings.json `model` / config.toml `default_model` / …).
  useEffect(() => {
    if (harnessAgent && harnessCfg?.defaultModel && activeSession && !activeSession.model) {
      handleModelChange(harnessCfg.defaultModel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessAgent, harnessCfg, activeSession?.id]);
  // Extended thinking is exposed by:
  //  - Anthropic (and anthropic_compatible proxies that forward the field),
  //  - Local GGUF models whose template honors chat_template_kwargs (Qwen3,
  //    DeepSeek-R1 family; older templates ignore it silently),
  //  - OpenAI reasoning models — but those read `reasoning_effort` (the
  //    `effort` selector), so the explicit thinking flag is redundant. We
  //    only show the brain button for providers where the flag actually
  //    changes the request body.
  const thinkingSupported =
    activeSession?.provider === "anthropic" ||
    activeSession?.provider === "anthropic_compatible" ||
    activeSession?.provider === "local_gguf";
  // Local GGUF discovery + sidecar lifecycle (scan, live sidecar id,
  // persisted overrides, spawn/swap with prompt warmup) — carved to
  // useLocalModelSidecar.ts. The pick handlers below consume it and own the
  // session-mutation ordering.
  const {
    localModels,
    localLoading,
    activeLocalModelId,
    setActiveLocalModelId,
    localOverridesMap,
    setLocalOverridesMap,
    localOverridesMapRef,
    localOverridesByName,
    refreshLocalOverrides,
    spawnLocalModel,
  } = useLocalModelSidecar({
    activeChatSessionId,
    isLocal,
    activeSessionModel: activeSession?.model,
  });

  // The model id shown as "selected" in the picker. The session may store a
  // local model under its registry id-slug (persisted by start_local_model),
  // but the picker lists local models by `name || filename`. Resolve the
  // stored value to that same form so the right row gets the ✓ instead of no
  // row matching (or a stale slug row appearing alongside the real one).
  const resolvedModel = (() => {
    const stored = activeSession?.model;
    if (!stored) return stored;
    if (isLocal) {
      const match = localModels.find(
        (m) =>
          (m.id && m.id === stored) ||
          (m.filename && m.filename === stored) ||
          (m.name && m.name === stored),
      );
      if (match) return match.name || match.filename;
    }
    return stored;
  })();

  // Context meter "used" figure, last-assistant-turn half: the input_tokens
  // of the most recent assistant turn is the one provider-counted number
  // Relay has. It's combined with the live polled estimate below (see the
  // usedTokens comment).
  const lastInputTokens = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.inputTokens != null && m.inputTokens > 0) {
        return m.inputTokens;
      }
    }
    return null;
  }, [messages]);

  // The model the harness LAST actually ran (claude message.model / opencode
  // info.modelID, persisted per turn). A custom/remapped harness setup makes
  // the session's stored catalog id ("claude-opus-4-8", …) a lie — the meter
  // shows the real model. Refetched whenever a turn lands (lastInputTokens
  // flips) so the label tracks the harness's own reports.
  const [actualHarnessModel, setActualHarnessModel] = useState<string | null>(null);
  useEffect(() => {
    if (!harnessAgent || !activeChatSessionId) {
      setActualHarnessModel(null);
      return;
    }
    let cancelled = false;
    void getAgentActualModel(activeChatSessionId)
      .then((m) => {
        if (!cancelled) setActualHarnessModel(m ?? null);
      })
      .catch(() => {
        if (!cancelled) setActualHarnessModel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [harnessAgent, activeChatSessionId, lastInputTokens]);
  const meterModel = harnessAgent ? (actualHarnessModel ?? resolvedModel) : resolvedModel;

  // Per-session streaming flag from the `streaming` map (the source of
  // truth). The legacy streamingChatSessionId scalar flips between
  // concurrently-streaming sessions and can't be trusted for display.
  const isStreamingForMeter =
    activeChatSessionId != null && activeChatSessionId in streaming;
  // `compactionRevision` is bumped by onStatus whenever a `context_compacted`
  // event lands for the active session — drives an immediate re-poll so the
  // meter ticks down right after compaction instead of waiting up to 2s for
  // the next interval.
  const compactionRevision = useChatStore((s) => s.compactionRevision);
  // Classified chat:error code for the active session — keys the overflow
  // banner's actionable copy (see the chat-error block below).
  const errorCode = useChatStore((s) => s.errorCode);
  const liveUsage = useContextMeter({
    chatSessionId: activeChatSessionId,
    isLocal,
    isStreaming: isStreamingForMeter,
    messagesRevision: messages.length,
    compactionRevision,
  });
  // The meter's total counts UNCACHED prompt tokens only (what the provider
  // freshly billed — the cached share shows on the HUD's cache chip). The
  // live poll's figure is a FULL prompt count, so the session's last cache
  // report (`cachedTokens`, backend-derived from the last assistant row) is
  // stripped from it. The provider-counted lastInputTokens half gets the
  // same treatment on inclusive providers (OpenAI-style input embeds the
  // cache read); Anthropic-style input is reported uncached already.
  // Live count wins for local sessions (exact /tokenize). For cloud and
  // harness sessions the polled backend estimate is live (it includes the
  // just-sent user message and reflects compaction immediately) while the
  // last assistant turn's input_tokens is provider-counted — take the
  // larger of the two so neither a stale figure nor an underestimate can
  // hide a filling window. Either way, the meter's percentage is a real
  // number, never fabricated.
  const cachedTokens = liveUsage.cachedTokens ?? 0;
  const providerIncludesCache = PROVIDER_INPUT_INCLUDES_CACHE.has(
    activeSession?.provider ?? "",
  );
  const pollUncached =
    liveUsage.usedTokens != null
      ? Math.max(0, liveUsage.usedTokens - cachedTokens)
      : null;
  const lastUncached =
    lastInputTokens != null && providerIncludesCache
      ? Math.max(0, lastInputTokens - cachedTokens)
      : lastInputTokens;
  const usedTokens = isLocal
    ? (pollUncached ?? lastUncached)
    : Math.max(pollUncached ?? 0, lastUncached ?? 0) || lastUncached;


  const handleModelChange = useCallback(
    async (model: string) => {
      if (!activeChatSessionId) return;
      if (localLoading) return;
      const localMatch = localModels.find((m) => (m.name || m.filename) === model);
      if (localMatch) {
        // Local model picked (in ANY session): spawn/swap the sidecar first
        // (start_local_model stops any existing one), then point the session
        // at the local provider so subsequent sends hit its endpoint. On
        // failure the model is left untouched and the error is surfaced via
        // the store's `error` field (the same `chat-error` banner provider
        // errors use; formatChatError scrubs the noisy llama.cpp logs).
        const startErr = await spawnLocalModel(localMatch);
        if (startErr) {
          useChatStore.setState({ error: startErr });
          return;
        }
        // start_local_model persists chat.local_gguf.model + chat.active_provider
        // in settings. We DON'T call loadConfig("local_gguf") here because that
        // would overwrite `config.provider` with "local_gguf" and break the
        // cloud-model list (see cloudProvider below) — once the active provider
        // is local, the selector would only show local models because the
        // cloud fetch returns [] and the local fetch is the only source of
        // models. The cloud provider's config (the user's API key + base URL
        // + model) is independent of which sidecar is running and must be
        // preserved so the user can switch back without re-entering keys.
        // The next "New Chat" reads chat.local_gguf.model directly (not via
        // chatConfig), so this is also safe for the auto-start path.
        if (!isLocal) await setSessionProvider(activeChatSessionId, "local_gguf");
      } else if (isLocal) {
        // Cloud model picked in a local session: switch the session back to
        // the configured cloud provider before setting the model.
        const target =
          config?.provider && config.provider !== "local_gguf"
            ? config.provider
            : "openai_compatible";
        await setSessionProvider(activeChatSessionId, target);
      }
      void setSessionModel(activeChatSessionId, model);
    },
    [activeChatSessionId, setSessionModel, setSessionProvider, isLocal, localModels, spawnLocalModel, config?.provider, localLoading],
  );

  // "Load model" from the picker's per-model gear panel: persist the drafted
  // tweaks for that model, spawn the sidecar with them, then point the
  // session at it. Works for ANY scanned local model (not just the active
  // one) — loading a different model swaps the sidecar, same as picking it.
  const handleLoadLocalModel = useCallback(
    async (model: string, overrides: LlamaOverrides) => {
      if (!activeChatSessionId) return;
      if (localLoading) return;
      const match = localModels.find((m) => (m.name || m.filename) === model);
      if (!match) return;
      const session = sessions.find((s) => s.id === activeChatSessionId);
      // The gear flow loads a local model directly — make the session a
      // "local" agent session FIRST (same as picking the model from the
      // rail), or the chip keeps the old agent and never shows the Local
      // label/spinner/model name.
      if ((session?.agent ?? null) !== "local") {
        await setSessionAgent(activeChatSessionId, "local");
      }
      // Persist first so the tweaks survive app restarts (and a later plain
      // pick of this model reuses them via the persisted blob).
      try {
        const next = { ...localOverridesMapRef.current, [match.id]: overrides };
        await setLocalModelOverrides(JSON.stringify(next));
        localOverridesMapRef.current = next;
        setLocalOverridesMap(next);
      } catch (err) {
        console.warn("persist local overrides failed", err);
      }
      const startErr = await spawnLocalModel(match, overrides);
      if (startErr) {
        useChatStore.setState({ error: startErr });
        return;
      }
      const status = await localModelStatus().catch(() => null);
      if (status?.modelId) setActiveLocalModelId(status.modelId);
      if (session?.provider !== "local_gguf") {
        await setSessionProvider(activeChatSessionId, "local_gguf");
      }
      if (session?.model !== model) {
        await setSessionModel(activeChatSessionId, model);
      }
      // The gear flow is a committed pick like any other — remember it.
      useChatStore
        .getState()
        .rememberSelection({ agent: "local", provider: "local_gguf", model });
    },
    [activeChatSessionId, sessions, localModels, spawnLocalModel, setSessionAgent, setSessionProvider, setSessionModel, localLoading],
  );

  // Eject the running local-model sidecar. Stops the llama-server process
  // (releasing its VRAM), clears the model on the active session so the chat
  // is no longer pinned to a dead sidecar, and shows a brief confirmation.
  // Provider stays "local_gguf" — the user can pick a different local model
  // or switch the agent, no need to flip the whole session back to cloud.
  const ejectLocalModel = useCallback(async () => {
    const id = activeLocalModelId;
    if (!id || !activeChatSessionId) return;
    // Optimistic UI: clear the ⏏ button and the active model immediately so
    // the pill rolls back to "Select a model to start" before the IPC round
    // trip. The status effect below reconciles once the kill lands.
    setActiveLocalModelId(null);
    try {
      await stopLocalModel(id);
    } catch (err) {
      console.warn("eject local model failed", err);
    }
    try {
      await setSessionModel(activeChatSessionId, "");
    } catch (err) {
      console.warn("clear session model after eject failed", err);
    }
  }, [activeLocalModelId, activeChatSessionId, setSessionModel]);

  // Commit a selection from the composer's combined agent/model picker. The
  // agent, provider, and model land TOGETHER so a session can never end up
  // with one agent and another agent's model attached. Order matters:
  //  1. agent first — leaving a harness/ACP session must kill its CLI
  //     process (setSessionAgent does that);
  //  2. local picks spawn/swap the llama-server sidecar before the session
  //     is pointed at it (a failed spawn leaves the session untouched);
  //  3. cloud/harness picks flip the provider when it changed, then the
  //     model (a harness model change respawns the CLI via setSessionModel).
  const handleAgentModelPick = useCallback(
    async (sel: AgentModelSelection) => {
      if (!activeChatSessionId) return;
      // Guard against concurrent loads — avoid double-spawning if the user
      // picks a local model from the agent/model picker while another spawn
      // is already in flight.
      if (sel.provider === "local_gguf" && localLoading) return;
      const session = sessions.find((s) => s.id === activeChatSessionId);
      // Auto routing: the session runs on whatever cloud provider the
      // backend's resolver picks per send (local/CLI models are never auto
      // candidates). Agent-wise it's a builtin chat — leaving a harness/
      // ACP session for Auto kills the CLI via setSessionAgent above.
      if (sel.provider === "auto") {
        // Auto is a builtin-cloud mode: leaving a harness/ACP session for it
        // kills the CLI via setSessionAgent.
        if ((session?.agent ?? null) !== "builtin") {
          await setSessionAgent(activeChatSessionId, "builtin");
        }
        await setSessionAuto(activeChatSessionId, true);
        useChatStore
          .getState()
          .rememberSelection({ agent: "builtin", provider: "auto", model: "auto" });
        return;
      }
      // A manual pick takes the session out of Auto mode first, so the flag
      // can't survive pointing at a provider the pick just replaced.
      if (session?.autoModel) {
        await setSessionAuto(activeChatSessionId, false);
      }
      if ((session?.agent ?? null) !== sel.agent) {
        await setSessionAgent(activeChatSessionId, sel.agent);
      }
      // Remember the committed pick (any kind) so every future new chat —
      // this launch and after restarts — seeds ready-to-send on it. ACP
      // agents decide their own model, so their pick is fully committed here.
      useChatStore
        .getState()
        .rememberSelection({ agent: sel.agent, provider: sel.provider, model: sel.model });
      if (sel.agent.startsWith("acp:")) return;
      if (sel.provider === "local_gguf") {
        const match = localModels.find((m) => (m.name || m.filename) === sel.model);
        if (match) {
          const startErr = await spawnLocalModel(match);
          if (startErr) {
            useChatStore.setState({ error: startErr });
            return;
          }
        }
        if (session?.provider !== "local_gguf") {
          await setSessionProvider(activeChatSessionId, "local_gguf");
        }
      } else if (sel.provider && session?.provider !== sel.provider) {
        await setSessionProvider(activeChatSessionId, sel.provider);
      }
      if (sel.model !== session?.model) {
        await setSessionModel(activeChatSessionId, sel.model);
      }
    },
    [
      activeChatSessionId,
      sessions,
      localModels,
      spawnLocalModel,
      setSessionAgent,
      setSessionProvider,
      setSessionModel,
      setSessionAuto,
      localLoading,
    ],
  );

  // Permission posture: the approval card above the composer resolves the
  // session's pending tool approval (built-in loop + Claude Code harness
  // can_use_tool share the same card); the mode menu in the composer footer
  // persists per session. Switching into full_auto goes through the one-time
  // confirmation modal.
  const pendingApprovals = useChatStore((s) => s.pendingApprovals);
  const fullAccessConfirmingFor = useChatStore((s) => s.fullAccessConfirmingFor);
  const resolveApproval = useChatStore((s) => s.resolveApproval);
  // Harness questions (AskUserQuestion) — same composer slot as approvals.
  const pendingQuestions = useChatStore((s) => s.pendingQuestions);
  const resolveQuestionAction = useChatStore((s) => s.resolveQuestion);
  // Plan mode + proposal cards (present_plan) + the authoritative todo list.
  const pendingPlanProposals = useChatStore((s) => s.pendingPlanProposals);
  // This session's pending present_plan proposal, if the model is paused on
  // one — rendered as the transcript's last row (see the items memo below).
  // Declared here (not next to the memo) because the scroll effects below
  // key their anchors on it.
  const pendingPlan = activeChatSessionId ? pendingPlanProposals[activeChatSessionId] : undefined;
  const resolvePlanProposalAction = useChatStore((s) => s.resolvePlanProposal);
  const planModeMap = useChatStore((s) => s.planMode);
  const toolsEnabled = useChatStore((s) => s.toolsEnabled);
  const confirmFullAccess = useChatStore((s) => s.confirmFullAccess);
  const cancelFullAccessConfirm = useChatStore((s) => s.cancelFullAccessConfirm);
  const setSessionPolicies = useChatStore((s) => s.setSessionPolicies);
  // Plan mode applies to built-in/local sessions with tools on (harness/ACP
  // sessions track plans through their own harness todo mechanisms instead).
  const planModeSupported = !harnessAgent && !acpAgent && toolsEnabled;
  const setSessionPlanMode = useChatStore((s) => s.setSessionPlanMode);
  const setSessionPermissionMode = useChatStore((s) => s.setSessionPermissionMode);
  const setSessionEffort = useChatStore((s) => s.setSessionEffort);
  // Harness effort slider: persist the tier; the spawn applies it per harness
  // (claude --effort, omp/pi --thinking, kimi env) on the next send.
  const handleHarnessEffortChange = useCallback(
    (tier: string) => {
      if (!activeChatSessionId) return;
      void setSessionEffort(activeChatSessionId, tier);
    },
    [activeChatSessionId, setSessionEffort],
  );
  // CLI-harness sessions get the HARNESS'S OWN postures in the mode menu
  // (OpenCode build/plan, Claude Code default/acceptEdits/plan/bypass) —
  // no mapping to our dual policies; the pick rides to the CLI verbatim.
  const harnessModeOptions = harnessAgent
    ? HARNESS_PERMISSION_MODES[harnessAgent]
    : undefined;
  const handlePermissionModeChange = useCallback(
    (mode: string) => {
      if (!activeChatSessionId) return;
      // Harness session: persist the native mode verbatim; the spawn maps it
      // to the CLI's own flags (claude --permission-mode, opencode --mode).
      if (harnessModeOptions) {
        void setSessionPermissionMode(activeChatSessionId, mode);
        return;
      }
      // "Plan" is a posture of its own: it flips the persisted label + live
      // gate and PRESERVES the session's dual policies, so approval resumes
      // exactly the posture that was active before planning.
      if (mode === "plan") {
        if (planModeSupported) void setSessionPlanMode(activeChatSessionId, true);
        return;
      }
      // Selecting a real posture while in plan mode also exits plan mode.
      if (planModeMap[activeChatSessionId]) {
        void setSessionPlanMode(activeChatSessionId, false);
      }
      const { sandbox, approval } = permissionModeToPolicies(
        mode as Exclude<PermissionMode, "plan">,
      );
      void setSessionPolicies(activeChatSessionId, sandbox, approval);
    },
    [activeChatSessionId, harnessModeOptions, planModeSupported, planModeMap, setSessionPermissionMode, setSessionPlanMode, setSessionPolicies],
  );

  const loadOlderMessages = useChatStore((s) => s.loadOlderMessages);
  const loadOlderSplitMessages = useChatStore((s) => s.loadOlderSplitMessages);
  const hasMoreHistory = useChatStore((s) => (isSplitView ? s.splitHasMoreHistory : s.hasMoreHistory));
  // Pending approval/question card ids — their mount/unmount shrinks the
  // scroll viewport, so the transcript scroll engine re-anchors across it.
  const approvalKey = activeChatSessionId
    ? pendingApprovals[activeChatSessionId]?.pendingId ?? null
    : null;
  const questionKey = activeChatSessionId
    ? pendingQuestions[activeChatSessionId]?.pendingId ?? null
    : null;
  // The transcript scroll engine (stick-to-bottom latch, measured live-edge
  // pinning over the virtualized list, history prepends, jump-to-latest
  // glide, dock wheel chaining) — carved to useTranscriptScroll.ts.
  const {
    messagesEndRef,
    messagesContainerRef,
    composerDockRef,
    composerDockHeight,
    liveTotal,
    stickToBottomRef,
    itemsRef,
    virtualizerRef,
    virtualizerImplRef,
    rowElsRef,
    rowHeightsRef,
    awayFromLive,
    handleScroll,
    jumpToLiveEdge,
  } = useTranscriptScroll({
    activeChatSessionId,
    isSplitView,
    hasMoreHistory,
    loadOlderMessages,
    loadOlderSplitMessages,
    messages,
    streaming,
    approvalKey,
    questionKey,
  });

  // Draft handed to the composer: bumping `nonce` re-prefills the textarea
  // (used by the per-message "Edit" action to load a message for resend, and
  // by the welcome prompts when no model is configured).
  const [draft, setDraft] = useState<{ text: string; nonce: number }>({
    text: "",
    nonce: 0,
  });
  // Quoted selections from the selection toolbar's "Ask": each click stacks a
  // removable chip ABOVE the composer (queue-row visual language) instead of
  // overwriting whatever draft the user already had. The whole stack is
  // prepended to the next sent message and cleared with it.
  const [quotedSelections, setQuotedSelections] = useState<Array<{ id: number; text: string }>>([]);
  const nextQuoteIdRef = useRef(1);
  useEffect(() => {
    // Keyed by THIS view's session: in split view both views register, and
    // dispatch resolves the focused one. Cleanup removes only this session's
    // entry — the old unconditional null used to kill the other view's
    // registration when either view unmounted.
    setChatSelectionPrefill(activeChatSessionId, (text) =>
      setQuotedSelections((qs) => [...qs, { id: nextQuoteIdRef.current++, text }]),
    );
    return () => setChatSelectionPrefill(activeChatSessionId, null);
  }, [activeChatSessionId]);
  const removeQuotedSelection = useCallback((id: number) => {
    setQuotedSelections((qs) => qs.filter((q) => q.id !== id));
  }, []);
  const clearQuotedSelections = useCallback(() => {
    setQuotedSelections([]);
  }, []);

  // Load sessions on mount if not already loaded.
  useEffect(() => {
    if (!loaded) {
      void loadSessions();
    }
  }, [loaded, loadSessions]);

  // Pop-out window (roadmap #17): select the requested session once the
  // session list has loaded, so the standalone window shows that chat.
  const selectSession = useChatStore((s) => s.selectSession);
  useEffect(() => {
    if (!popoutSessionId || !loaded) return;
    if (useChatStore.getState().activeChatSessionId === popoutSessionId) return;
    const exists = useChatStore.getState().sessions.some((s) => s.id === popoutSessionId);
    if (exists) void selectSession(popoutSessionId).catch(() => {
      /* best-effort popout binding — the main view still works */
    });
  }, [popoutSessionId, loaded, selectSession]);

  // Load the saved provider config (used for auto-starting a session).
  useEffect(() => {
    if (!config) void loadConfig();
  }, [config, loadConfig]);

  // Entering chat with no session selected always starts a FRESH chat so the
  // user can type immediately. First sweep any empty "Untitled" rows — chats
  // opened but never typed into (including the auto-started one from the
  // previous launch) — so they never accumulate in the sidebar. NEVER in the
  // split pane: it always renders an existing session, and auto-creating (or
  // sweeping) from there would hijack the main view's session list.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!loaded || !config || isSplitView || activeChatSessionId || autoStarted.current) return;
    autoStarted.current = true;
    void deleteEmptyChatSessions()
      .then((deleted) => {
        if (deleted) void loadSessions();
      })
      .catch(() => {
        /* the empty-session sweep is best-effort */
      });
    // Seed from the last committed composer pick (any kind — harness/ACP/
    // local included) so the fresh chat is ready to send on what the user was
    // last using; falls back to the per-provider config defaults. Local seeds
    // are safe across restarts: a dead sidecar is respawned automatically on
    // the first send (send_chat_message's auto-warm path).
    const seed = seedSelectionFrom(lastSelection, config);
    void newChat(seed.provider, seed.model, undefined, seed.agent);
  }, [loaded, isSplitView, activeChatSessionId, config, lastSelection, newChat, loadSessions]);

  // Split pane: load (or re-target) the pinned session's history whenever the
  // pane opens on a different session.
  useEffect(() => {
    if (!isSplitView || !splitSessionId || !loaded) return;
    void useChatStore.getState().loadSplitMessages(splitSessionId);
  }, [isSplitView, splitSessionId, loaded]);


  // Build the list of items to render: persisted messages, plus a live
  // streaming bubble for the active session if tokens are arriving.
  const activeStream = activeChatSessionId ? (streaming[activeChatSessionId] ?? "") : "";
  const activeIsStreaming =
    activeChatSessionId != null && activeChatSessionId in streaming;
  const isStreaming = activeIsStreaming && activeStream.length > 0;
  // The request is in flight but no content has streamed yet: show the
  // Claude-style "thinking" animation so the user knows something is happening.
  const waitingForFirstToken = activeIsStreaming && activeStream.length === 0;
  // A pre-token status notice (chat:status) explains *why* it's waiting — e.g.
  // a local model is cold-starting after an app restart. When present, render
  // its message next to a spinner instead of the generic thinking dots.
  const statusNotice = activeChatSessionId ? chatStatus[activeChatSessionId] : undefined;
  // Reconnect notice (backend "reconnecting" / "reconnect_restart"): the
  // connection dropped and is being re-dialed, with the attempt counter
  // pre-formatted into the message ("Reconnecting… (3/10)"). It renders on
  // the assistant bubble when the turn already has text on screen — that is
  // what the user is watching, and the answer restarts from zero under it.
  // With nothing streamed yet there is no bubble to hang it on, so the
  // pre-token notice slot below carries the same line instead.
  const reconnectNotice =
    statusNotice &&
    (statusNotice.reason === "reconnecting" || statusNotice.reason === "reconnect_restart")
      ? statusNotice.message
      : undefined;

  const handleSend = useCallback(
    (content: string, attachments: ChatAttachment[], forceResearch?: boolean) => {
      // Sending always pins to the bottom so the reply is visible.
      stickToBottomRef.current = true;
      // Goald-loop start: a /goal or /loop prefix arms the autonomous loop for
      // this session. We keep the slash token in the sent message (so the
      // backend's skill injection still matches /goal or /loop and teaches the
      // model the sentinel protocol) but hand the goal text to the loop tracker.
      const m = /^\/(goal|loop)\s+(.+)$/s.exec(content);
      if (m) {
        const [, , goal] = m;
        startLoop(goal, activeChatSessionId ?? undefined);
      }
      // Explicit session id: identical to the active session in the main
      // view; the split pane's pinned session in split view.
      void sendMessage(content, attachments, forceResearch, activeChatSessionId ?? undefined);
    },
    [sendMessage, startLoop, activeChatSessionId],
  );

  // "Fix citations" on the citation-report strip: dismiss the strip (the
  // verdict it described is being addressed), then pull the stored lint
  // detail and send a RARR-style repair instruction — the model re-cites or
  // drops flagged claims from the ledger and regenerates the report
  // artifact. The repair turn runs with research scaffolding forced so the
  // ledger tools are available; if it produces a fresh verdict of its own,
  // the strip re-renders with the new numbers.
  const handleFixCitations = useCallback(
    async (sid: string) => {
      useChatStore.getState().clearCitationReport(sid);
      const detail = await getResearchCitationReport(sid).catch(() => null);
      const instruction = detail
        ? `The citation-integrity check on your last research report flagged problems. Lint detail (JSON):\n${detail}\n\nRepair the report working ONLY from the source ledger: for every orphan citation, re-cite the correct ledger entry or delete the claim; for every weak attribution, re-read the flagged source (or a better one), record a supporting excerpt with add_source_note, then re-cite. Drop claims that don't trace to a stored excerpt. Then regenerate the artifact with generate_file (same filename, corrected) and give a one-line summary of the fixes.`
        : "Re-verify every citation in your last research report against get_source_ledger; fix any claim that doesn't trace to a stored excerpt, then regenerate the artifact with generate_file.";
      handleSend(instruction, [], true);
    },
    [handleSend],
  );

  // Edit-to-fork submit (roadmap #9): retire this message's tail, then re-send
  // the edited text as a new turn. Wired per item so the bubble's Save handler
  // carries the message id.
  const handleSubmitEdit = useCallback(
    (messageId: number | undefined, newContent: string) => {
      if (messageId == null) return;
      void editMessage(messageId, newContent, activeChatSessionId ?? undefined);
    },
    [editMessage, activeChatSessionId],
  );

  const handleStop = useCallback(() => {
    void cancelStream(activeChatSessionId ?? undefined);
  }, [cancelStream, activeChatSessionId]);

  const handleRepeat = useCallback(() => {
    stickToBottomRef.current = true;
    void regenerate(activeChatSessionId ?? undefined);
  }, [regenerate, activeChatSessionId]);

  // --- Conversational Artifact Creation (Phase 1) ---
  // Handlers below use the card's `proposalId` (the wrapper ID in the store).
  // The store's `updateArtifactProposal` keeps this ID stable across proposal
  // replacements, so all handlers find the correct entry.

  const handleRegenerateProposal = useCallback(async (proposalId: string, instruction?: string) => {
    if (!activeChatSessionId) return;
    const proposals = getArtifactProposals(activeChatSessionId);
    const entry = proposals.find((p) => p.id === proposalId);
    if (!entry) return;
    updateArtifactProposal(activeChatSessionId, proposalId, { state: "generating" });
    try {
      // Prefer the original user instruction so the backend can re-classify it.
      // Fall back to the proposal spec name for backwards compatibility.
      const originalInstruction = entry.proposal.originalInstruction ?? "";
      const userMessage = originalInstruction || (
        entry.proposal.spec.type === "skill"
          ? entry.proposal.spec.name ?? ""
          : ""
      );
      const newProposal = await regenerateArtifact({
        chatSessionId: activeChatSessionId,
        userMessage,
        additionalInstruction: instruction ?? "",
        originalInstruction,
        artifactType: entry.proposal.artifactType,
      });
      // Keep the wrapper ID stable by passing the same proposalId;
      // updateArtifactProposal handles the ID sync internally.
      updateArtifactProposal(activeChatSessionId, proposalId, {
        proposal: { ...newProposal, originalInstruction },
        state: "ready",
      });
    } catch (err) {
      updateArtifactProposal(activeChatSessionId, proposalId, { state: "ready" });
      pushToast("error", `Failed to regenerate artifact: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeChatSessionId, updateArtifactProposal, getArtifactProposals, pushToast]);
  const handleEditProposal = useCallback((proposalId: string) => {
    if (!activeChatSessionId) return;
    const proposals = getArtifactProposals(activeChatSessionId);
    const entry = proposals.find((p) => p.id === proposalId);
    if (!entry) return;
    void updateArtifactProposal(activeChatSessionId, proposalId, { state: "editing" });
    // Navigate to the appropriate editor tab and pre-fill the form
    editArtifactProposal(activeChatSessionId, proposalId, entry.proposal);
  }, [activeChatSessionId, updateArtifactProposal, getArtifactProposals, editArtifactProposal]);
const handleCreateProposal = useCallback(async (proposalId: string) => {
    // The proposal card shows the "creating..." state. The card handler
    // moves the proposal to `state: "created"` — a toast confirms it was
    // created. The user's next turn (or /goal /loop) runs the artifact.
    if (!activeChatSessionId) return;
    const proposals = getArtifactProposals(activeChatSessionId);
    const entry = proposals.find((p) => p.id === proposalId);
    if (!entry) return;

    updateArtifactProposal(activeChatSessionId, proposalId, { state: "created" });

    try {
      // Build provenance from the conversation
      const provenance: ArtifactProvenance = {
        source: "chat",
        conversationId: activeChatSessionId,
        sourceMessageIds: undefined, // Phase 2: add message selection
        createdAt: Date.now(),
        schemaVersion: 1,
        generatorVersion: "artifact-generator-v1",
      };

      const result = await createArtifact({
        spec: entry.proposal.spec,
        provenance,
      });

      pushToast("success", `Artifact "${result.name}" created successfully`);
    } catch (err) {
      updateArtifactProposal(activeChatSessionId, proposalId, { state: "ready" });
      pushToast("error", `Failed to create artifact: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeChatSessionId, updateArtifactProposal, getArtifactProposals, pushToast]);
  const handleDismissProposal = useCallback((proposalId: string) => {
    if (!activeChatSessionId) return;
    void removeArtifactProposal(activeChatSessionId, proposalId);
  }, [activeChatSessionId, removeArtifactProposal]);

  /** Update a proposal's spec when the user picks a harness/model in the
   *  AutomationAgentPicker. The store updates, causing the card to re-render
   *  with the new selection so "Create" persists the user's choice. */
  const handleUpdateArtifactSpec = useCallback((proposalId: string, spec: ArtifactSpec) => {
    if (!activeChatSessionId) return;
    const proposals = getArtifactProposals(activeChatSessionId);
    const entry = proposals.find((p) => p.id === proposalId);
    if (!entry) return;
    updateArtifactProposal(activeChatSessionId, proposalId, {
      proposal: { ...entry.proposal, spec },
    });
  }, [activeChatSessionId, updateArtifactProposal, getArtifactProposals]);

  // Called by the card when the user fills missing fields (via MissingFieldsPrompt).
  // We re-run generation with the filled fields as additional instruction so the
  // backend produces a complete proposal.
  const handleSubmitMissingFields = useCallback(async (proposalId: string, filledFields: Record<string, unknown>) => {
    if (!activeChatSessionId) return;
    const proposals = getArtifactProposals(activeChatSessionId);
    const entry = proposals.find((p) => p.id === proposalId);
    if (!entry) return;
    updateArtifactProposal(activeChatSessionId, proposalId, { state: "generating" });
    try {
      const originalInstruction = entry.proposal.originalInstruction ?? (
        entry.proposal.spec.type === "skill"
          ? entry.proposal.spec.name ?? ""
          : ""
      );
      const additionalInstruction = JSON.stringify(filledFields, null, 2);
      const newProposal = await regenerateArtifact({
        chatSessionId: activeChatSessionId,
        userMessage: originalInstruction,
        additionalInstruction,
        originalInstruction,
        artifactType: entry.proposal.artifactType,
      });
      updateArtifactProposal(activeChatSessionId, proposalId, {
        proposal: { ...newProposal, originalInstruction },
        state: "ready",
      });
    } catch (err) {
      updateArtifactProposal(activeChatSessionId, proposalId, { state: "ready" });
      pushToast("error", `Failed to apply fields: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeChatSessionId, updateArtifactProposal, getArtifactProposals, pushToast]);

  // Delete a single message from the active chat. The store handles local
  // state and the backend round-trip; we just feed it the message id from
  // the rendered bubble. Skipped on the live streaming bubble (no id yet).
  const handleDelete = useCallback(
    (messageId?: number) => {
      if (messageId == null) return;
      void deleteMessage(messageId, activeChatSessionId ?? undefined);
    },
    [deleteMessage, activeChatSessionId],
  );

  // Convert persisted messages for the bubble component.
  // MessageBubble expects { role, content } (its own ChatMessage type), so we
  // map ChatMessageRecord to that shape.
  //
  // MEMOIZED: MessageBubble is wrapped in React.memo and re-parses markdown
  // on every render — rebuilding this array on each render (new object
  // identities) defeated that memo and re-rendered EVERY bubble on every
  // streaming token / composer keystroke. The per-item onDelete closure is
  // created inside the memo too, so it stays reference-stable between
  // renders and doesn't break the memo either.
  type ProposalEntry = {
    id: string;
    proposal: ArtifactProposal;
    state: "generating" | "ready" | "editing" | "created" | "rejected";
  };
  type TimelineItem = ChatMessage & {
    key: string;
    id?: number;
    live?: boolean;
    onDelete?: () => void;
    onEdit?: (newContent: string) => void;
    superseded?: boolean;
    segmentStart?: boolean;
    livePerf?: ChatPerfPayload | null;
    proposalEntry?: ProposalEntry;
    /** Pre-first-token "assistant is responding" row (TypingIndicator / statusNotice). */
    typing?: boolean;
    /** One-shot entrance animation flag (see enterKeysRef below). */
    enter?: boolean;
  };
  // Entrance-animation bookkeeping (PERF: the bubble CSS animation must not
  // replay on every virtualizer REMOUNT — rows unmount when scrolled out and
  // remount when scrolled back, and an animated remount reads as flicker).
  // `enter` is granted only to keys that appeared AFTER the session's first
  // build (a message you just sent, this turn's live row), revoked ~350ms
  // later (after the 0.2s animation finished) so later remounts mount without
  // the class, and reset wholesale on session switch (existing history never
  // animates on open).
  const enterKeysRef = useRef<Set<string>>(new Set());
  const revokedKeysRef = useRef<Set<string>>(new Set());
  const prevItemKeysRef = useRef<{ sid: string | null; keys: Set<string> }>({
    sid: null,
    keys: new Set(),
  });
  const enterTimerRef = useRef<number | null>(null);
  const [enterEpoch, bumpEnterEpoch] = useState(0);
  useEffect(() => {
    return () => {
      if (enterTimerRef.current != null) window.clearTimeout(enterTimerRef.current);
    };
  }, []);
  // PERF: the PERSISTED rows (messages + anchored proposal cards) are built
  // in a memo that does NOT depend on the streaming text. It used to share a
  // memo with the live row, so every token flush re-created every item object
  // (and its onDelete/onEdit closures) — churning the whole visible list's
  // identities on each of dozens of flushes per second. Live/typing rows are
  // appended in a second memo below; only THOSE rebuild per token.
  const persistedItems: TimelineItem[] = useMemo(() => {
    const proposals = activeChatSessionId
      ? artifactProposalsBySession[activeChatSessionId] ?? []
      : [];
    // Group proposal entries by their anchor message ONCE (O(proposals)) —
    // the per-message filter inside the loop below used to make this O(
    // messages × proposals) on every streaming flush.
    const proposalsBySource = new Map<number, ProposalEntry[]>();
    for (const entry of proposals) {
      const sid = entry.proposal.sourceMessageId;
      if (sid == null) continue;
      const bucket = proposalsBySource.get(sid);
      if (bucket) bucket.push(entry);
      else proposalsBySource.set(sid, [entry]);
    }
    const list: TimelineItem[] = [];
    messages.forEach((m, i) => {
      const messageItem: TimelineItem = {
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
        attachments: m.attachments,
        durationSec:
          m.startedAt != null && m.completedAt != null
            ? m.completedAt - m.startedAt
            : undefined,
        // Unix seconds from the DB (ms on the optimistic bubble) — the bubble
        // shows it as its end-of-turn timestamp.
        createdAt: m.createdAt,
        key: `msg-${m.id}`,
        id: m.id,
        superseded: !!m.supersededBy,
        segmentStart: !!m.supersededBy && !messages[i - 1]?.supersededBy,
        onDelete: () => handleDelete(m.id),
        onEdit: m.role === "user" ? (newContent) => handleSubmitEdit(m.id, newContent) : undefined,
      };
      list.push(messageItem);
      // Anchor each artifact proposal directly after the command message that
      // created it. This preserves normal chronological chat order instead of
      // stacking every card in a footer below later messages.
      for (const entry of proposalsBySource.get(m.id) ?? []) {
        list.push({
          role: "system",
          content: "",
          key: `proposal-${entry.id}`,
          proposalEntry: entry,
        });
      }
    });
    return list;
    // enterEpoch: the 350ms revoke timer below bumps it; the identity change
    // re-runs the grant/revoke pass in the combined memo (the `enter` flags
    // live there, over the full list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeChatSessionId, artifactProposalsBySession, enterEpoch, handleDelete, handleSubmitEdit]);
  // This session's pending present_plan proposal, if the model is paused on
  // one — rendered as the transcript's last row (see the items memo below).
  const items: TimelineItem[] = useMemo(() => {
    const list = persistedItems.slice();
    // If streaming, append the live assistant bubble (no action bar while live).
    // Rendered from TURN START — not from the first token — so the
    // "Working for Xs" header is visible during the pre-token wait (prompt
    // eval can take tens of seconds; the timer used to pop in at "1min"
    // only once the first token landed). The key embeds session + current
    // message count so each turn's live row is a NEW identity to the
    // virtualizer — reusing a constant "streaming" key made it inherit the
    // previous turn's cached row measurement, which painted the new reply at
    // a stale offset (over the artifact proposal card).
    if (activeIsStreaming) {
      list.push({
        role: "assistant",
        content: activeStream,
        key: `streaming-${activeChatSessionId ?? "none"}-${messages.length}`,
        live: true,
        // The live row receives the current perf snapshot at render time
        // below. Keeping it out of the persisted memo prevents a 500ms perf
        // heartbeat from rebuilding every persisted row (and invalidating
        // their diagram subtrees) while the turn streams.
        livePerf: null,
      });
    }
    // Pre-first-token indicator as a VIRTUALIZED ROW, not a flow sibling:
    // when a send doesn't change the visible range, react-virtual skips the
    // re-render that would refresh the sized container's inline height —
    // the div kept a stale (short) height, rows overflowed past it, and a
    // sibling indicator anchored to the div end rendered ~1400px ABOVE the
    // newest message. As a row it shares translateY(vi.start) coordinates
    // with the bubbles, so it always follows the newest one. The key embeds
    // session + message count so each turn's indicator is a fresh identity
    // to the measurement cache (same reasoning as the streaming key above).
    if (waitingForFirstToken) {
      list.push({
        role: "assistant",
        content: "",
        key: `typing-${activeChatSessionId ?? "none"}-${messages.length}`,
        typing: true,
      });
    }
    // Grant/revoke the one-shot entrance flag (comment on the refs above).
    if (prevItemKeysRef.current.sid !== activeChatSessionId) {
      prevItemKeysRef.current = {
        sid: activeChatSessionId,
        keys: new Set(list.map((it) => it.key)),
      };
      enterKeysRef.current = new Set();
      revokedKeysRef.current = new Set();
    } else {
      const prevKeys = prevItemKeysRef.current.keys;
      let granted = false;
      for (const it of list) {
        if (revokedKeysRef.current.has(it.key)) {
          it.enter = false;
        } else if (enterKeysRef.current.has(it.key)) {
          it.enter = true;
        } else if (prevKeys.has(it.key)) {
          it.enter = false;
        } else {
          enterKeysRef.current.add(it.key);
          it.enter = true;
          granted = true;
        }
      }
      prevItemKeysRef.current.keys = new Set(list.map((it) => it.key));
      if (enterKeysRef.current.size > 2000 || revokedKeysRef.current.size > 2000) {
        // Bound the key sets; a cleared grant can at worst replay one old
        // row's pop-in on a much later remount.
        enterKeysRef.current.clear();
        revokedKeysRef.current.clear();
      }
      if (granted && enterTimerRef.current == null) {
        enterTimerRef.current = window.setTimeout(() => {
          enterTimerRef.current = null;
          for (const k of enterKeysRef.current) revokedKeysRef.current.add(k);
          enterKeysRef.current.clear();
          bumpEnterEpoch((n) => n + 1);
        }, 350);
      }
    }
    return list;
    // Deps mirror the fields the appended live/typing rows read; the
    // persisted rows arrive via persistedItems (identity changes on
    // messages/session/proposal/epoch/callback changes, which re-runs the
    // grant/revoke pass above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedItems, activeChatSessionId, messages.length, activeIsStreaming, activeStream, waitingForFirstToken]);
  // PERF (PERFORMANCE_AUDIT.md F5): virtualize the message list — long
  // conversations used to mount EVERY MessageBubble (each re-parsing markdown
  // + katex), which made scroll janky and session-switch slow past a few
  // hundred messages. Rows self-measure (ResizeObserver inside the
  // virtualizer) so the growing live-stream bubble stays sized correctly.
  // getItemKey keeps the measurement cache stable across history prepends.
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => messagesContainerRef.current,
    estimateSize: () => 160,
    overscan: 5,
    getItemKey: (i) => items[i].key,
  });
  itemsRef.current = items;
  virtualizerRef.current = virtualizer;
  // The scroll hook's follow/pin pass reads the virtualizer through this ref
  // (assigned every render, so it is always populated before effects run) —
  // do not make this assignment conditional, stick-to-bottom depends on it.
  virtualizerImplRef.current = virtualizer;

  // Structural changes to the timeline (proposal cards mounting or flipping
  // generating→ready→created, the live-stream row attaching/detaching) swap
  // large content inside measured rows. The ResizeObserver correction can lag
  // a paint behind, leaving later rows translated to a stale offset.
  //
  // BUG FIX (message overlap): this used to call `virtualizer.measure()`,
  // which wipes the ENTIRE item-size cache. Mounted rows are not re-read
  // after the wipe (ResizeObserver only fires on real resizes; the ref
  // callbacks don't re-run for already-mounted nodes), so every visible row
  // fell back to the 160px estimate — any bubble taller than 160px then
  // painted over its neighbour. This fired after EVERY completed turn, since
  // the live row key (`streaming-sess-N`) swaps to the persisted key
  // (`msg-N`). Instead, synchronously re-measure ONLY the mounted rows via
  // measureElement(el): fresh offsetHeight per visible row, off-screen cached
  // sizes preserved.
  // Wrapped in a memo on [items]: the join() used to run inline on every
  // render — per streaming token — to produce a string that (unchanged) never
  // re-triggered the effect below anyway.
  const structureSig = useMemo(
    () =>
      items
        .map((i) => i.key + (i.proposalEntry ? `:${i.proposalEntry.state}` : ""))
        .join("|"),
    [items],
  );
  useEffect(() => {
    // Reconcile mounted rows whose real DOM height drifted from the
    // virtualizer's cached size. The dangerous case: a row that mounts ALREADY
    // at full height (the persisted row swapping in for the live-stream bubble)
    // while isScrolling blocks the ref-measure — it then keeps its 160px
    // estimate forever (ResizeObserver never fires without a later resize),
    // totalSize under-counts, and anything after the spacer (typing indicator)
    // paints over earlier messages. measureElement() short-circuits to the
    // cache when called programmatically, so drop the stale entry first to
    // force a fresh DOM read — only for rows that actually disagree.
    //
    // The pass runs one frame OUTSIDE the lifecycle: measureElement can make
    // the virtualizer synchronously adjust scroll and flushSync a re-render
    // (it does that whenever the list is pinned at the bottom), which inside
    // an effect warns "flushSync was called from inside a lifecycle method".
    const raf = requestAnimationFrame(() => {
      // Structural view over the virtualizer: itemSizeCache / getMeasurements
      // exist at runtime but are typed private in @tanstack/react-virtual 3.14.
      const v = virtualizer as unknown as {
        itemSizeCache?: Map<string, number>;
        getMeasurements?: () => Array<{ size: number }>;
        measureElement: (el: HTMLDivElement | null) => void;
      };
      const sizes = v.getMeasurements?.() ?? [];
      rowElsRef.current.forEach((el, key) => {
        if (!el.isConnected) return;
        // Remember the real height while the row is mounted: this is the value
        // we write back into the size cache when the row unmounts (a detached
        // node reports offsetHeight 0, so it can't be read at detach time).
        rowHeightsRef.current.set(key, el.offsetHeight);
        const idx = items.findIndex((i) => i.key === key);
        const m = idx >= 0 ? sizes[idx] : undefined;
        if (!m || Math.abs(m.size - el.offsetHeight) <= 1) return;
        v.itemSizeCache?.delete(key);
        v.measureElement(el);
        rowHeightsRef.current.set(key, el.offsetHeight);
      });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureSig, messages.length]);

  const hasItems = items.length > 0;
  const currentLivePerf = activeChatSessionId
    ? livePerf[activeChatSessionId] ?? null
    : null;
  // Regenerate applies to the most recent assistant message only.
  const lastAssistantKey = [...items]
    .reverse()
    .find((i) => i.role === "assistant" && !i.live && !i.typing)?.key;

  return (
    <div className="chat-view-wrap">
    <TurnNavigator />
    <div className={`chat-view${artifacts && artifacts.length > 0 ? " has-artifacts" : ""}`}>
      {/* The git rail is mounted by exactly ONE view: in split view only the
          FOCUSED half hosts it (the pin points at its session); without a
          split, the main view does. Otherwise both halves would render their
          own rail and toggling would open it on both. */}
      {(isSplitView
        ? focusedPin === splitSessionId
        : focusedPin == null) && <GitToolsSidebar />}
      {!activeChatSessionId || hasItems ? (
        <div
          className="chat-messages"
          ref={messagesContainerRef}
          onScroll={handleScroll}
        >
          <div
            style={{
              // Math.max(liveTotal): the virtualizer's getTotalSize() can be
              // STALE at render time (its cache updates without notifying
              // React — see patchTailAndPin); liveTotal is the truth kept by
              // the pin pass, so the wrapper never renders too short and
              // lets the positioned rows overflow the scroll extent.
              // flexShrink 0: WITHOUT this, flexbox squeezes this child to a
              // fraction of its height (measured 755px vs 3958px specified)
              // because its absolutely-positioned rows give it zero
              // min-content size — the overflowed rows then defined the
              // scroll extent themselves and pinned the last turn behind
              // the floating composer.
              height: Math.max(virtualizer.getTotalSize(), liveTotal),
              flexShrink: 0,
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const item = items[vi.index];
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={(el) => {
                    // Track mounted rows for the structural remeasure effect,
                    // then run the virtualizer's own measure/observe pass.
                    const rowKey = String(vi.key);
                    if (el) {
                      rowElsRef.current.set(rowKey, el);
                      if (el.offsetHeight > 0) {
                        rowHeightsRef.current.set(rowKey, el.offsetHeight);
                      }
                    } else {
                      rowElsRef.current.delete(rowKey);
                      // Preserve this row's last real height in the
                      // virtualizer's size cache. Without this, a row that
                      // unmounts while its cached size is still the 160px
                      // estimate (ref-measure skipped mid-scroll) poisons
                      // totalSize forever: every later row renders at a stale,
                      // too-small offset and the typing indicator / live edge
                      // lands ON TOP of earlier messages instead of below the
                      // newest one.
                      const h = rowHeightsRef.current.get(rowKey);
                      const v = virtualizer as unknown as {
                        itemSizeCache?: Map<string, number>;
                        itemSizeCacheVersion?: number;
                        notify?: (sync: boolean) => void;
                      };
                      if (h != null && h > 0 && v.itemSizeCache?.get(rowKey) !== h) {
                        v.itemSizeCache?.set(rowKey, h);
                        // Mirror resizeItem: bump the measurement-cache
                        // version (getMeasurements memoizes on it) and
                        // notify so totalSize recomputes.
                        if (v.itemSizeCacheVersion != null) v.itemSizeCacheVersion++;
                        v.notify?.(false);
                      }
                      rowHeightsRef.current.delete(rowKey);
                    }
                    virtualizer.measureElement(el);
                  }}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                    // Reproduce the .chat-messages flex `gap: 18px` between
                    // bubbles — virtual rows are siblings of a spacer, not of
                    // each other, so the gap must live on the row wrapper.
                    paddingBottom: 18,
                  }}
                >
                  <Suspense fallback={null}>
                    {item.proposalEntry ? (
                      <ArtifactProposalCard
                        proposalId={item.proposalEntry.id}
                        proposal={item.proposalEntry.proposal}
                        state={item.proposalEntry.state}
                        onRegenerate={handleRegenerateProposal}
                        onEdit={handleEditProposal}
                        onCreate={handleCreateProposal}
                        onDismiss={handleDismissProposal}
                        onSubmitMissingFields={handleSubmitMissingFields}
                        onUpdateSpec={handleUpdateArtifactSpec}
                      />
                    ) : item.typing ? (
                      // A reconnect line looks the same in both slots — bare,
                      // no pill — so the notice doesn't change appearance
                      // mid-sequence just because a restart cleared the
                      // buffer. Other pre-token notices keep their pill.
                      reconnectNotice ? (
                        <div className="chat-reconnect-notice" role="status">
                          <span className="local-spinner" aria-hidden="true" />
                          <span>{reconnectNotice}</span>
                        </div>
                      ) : statusNotice && statusNotice.message ? (
                        <div className="chat-status-notice" role="status">
                          <span className="local-spinner" aria-hidden="true" />
                          <span>{statusNotice.message}</span>
                        </div>
                      ) : (
                        <TypingIndicator />
                      )
                    ) : (
                      <>
                        <MessageBubble
                          message={item}
                          live={item.live}
                          enter={item.enter}
                          msgId={item.id}
                          chatSessionId={activeChatSessionId}
                          onEdit={item.role === "user" ? item.onEdit : undefined}
                          onRepeat={
                            item.role === "assistant" && item.key === lastAssistantKey
                              ? handleRepeat
                              : undefined
                          }
                          onDelete={!item.live ? item.onDelete : undefined}
                          artifacts={item.id != null ? artifactsByMessage[item.id] : undefined}
                          onPreviewArtifact={setPreviewArtifact}
                          superseded={item.superseded}
                          segmentStart={item.segmentStart}
                          livePerf={item.live ? currentLivePerf : item.livePerf}
                        />
                        {/* Reconnect line, in the slot the hover action bar
                            occupies once the turn ends. Only under a bubble
                            that has text: with an empty buffer the typing
                            row's notice already carries it (and a second copy
                            here would just double the line). */}
                        {item.live && item.content.length > 0 && reconnectNotice && (
                          <div className="chat-reconnect-notice" role="status">
                            <span className="local-spinner" aria-hidden="true" />
                            <span>{reconnectNotice}</span>
                          </div>
                        )}
                      </>
                    )}
                  </Suspense>
                </div>
              );
            })}
          </div>
          {sessionTasks.length > 0 && (
            <div className="chat-tasks">
              {sessionTasks.map((t) => (
                <Suspense key={t.taskId} fallback={null}>
                  <TaskProgressCard task={t} />
                </Suspense>
              ))}
            </div>
          )}
          {/* Plan STEPS live in the git sidebar's Progress section (plus the
              live per-step "Working on" line there) — no duplicate checklist
              under the chat stream. */}
          {activeChatSessionId && (artifactProposalsBySession[activeChatSessionId]?.some((entry) => entry.proposal.sourceMessageId == null) ?? false) && (
            <div className="artifact-proposals-container">
              {(artifactProposalsBySession[activeChatSessionId] ?? [])
                .filter((entry) => entry.proposal.sourceMessageId == null)
                .map((entry) => (
                  <Suspense key={entry.id} fallback={null}>
                    <ArtifactProposalCard
                      proposalId={entry.id}
                      proposal={entry.proposal}
                      state={entry.state as "generating" | "ready" | "editing" | "created" | "rejected"}
                      onRegenerate={handleRegenerateProposal}
                      onEdit={handleEditProposal}
                      onCreate={handleCreateProposal}
                      onDismiss={handleDismissProposal}
                      onSubmitMissingFields={handleSubmitMissingFields}
                    />
                  </Suspense>
                ))}
            </div>
          )}
          {error && (
            <div className="chat-error" data-code={errorCode ?? undefined}>
              <span className="chat-error-icon">⚠</span>
              <span className="chat-error-text">
                {errorCode === "context_overflow" ? (
                  <>
                    This conversation has outgrown the model&apos;s context window. Start a new
                    chat, or edit an earlier message to trim the history, then retry.
                  </>
                ) : (
                  formatChatError(error)
                )}
              </span>
            </div>
          )}
          <div ref={messagesEndRef} />
          {/* Scrollable-space reservation for the floating composer dock.
              MEASURED (pad-debug overlay, 2026-08-27): padding-bottom on this
              scroll container is NOT counted in its scrollHeight (flex
              scroll-container quirk — scrollH came up ~220px short of
              content+padding), so max scroll could never clear the last
              turn above the composer. An in-flow spacer is ordinary
              content and always scrolls. Height = the dock's real measured
              height + breathing room, floored at the original 220px. */}
          <div
            aria-hidden="true"
            style={{
              height:
                composerDockHeight > 0
                  ? Math.max(composerDockHeight + 32, 220)
                  : 220,
              // Same flex-shrink trap as the wrapper above: without this the
              // spacer gets squeezed (measured ~45px vs 220px) and stops
              // reserving anything.
              flexShrink: 0,
            }}
          />
        </div>
      ) : (
        <ChatWelcome
          sendPrompt={(text) => {
            stickToBottomRef.current = true;
            void sendMessage(text);
          }}
          prefill={(text) => setDraft({ text, nonce: Date.now() })}
          hasModel={!!(activeSession?.model || config?.model)}
        />
      )}

      {/* Plan preview ("Agree & proceed"): renders INLINE in the transcript,
          directly after the assistant message it describes — the old dock-
          adjacent mount sat in normal flow under the messages div and the
          absolutely-positioned composer dock overlaid it. */}

      {/* Composer dock: overlays the transcript (position:absolute) so
          messages scroll BEHIND the glass card — that's what makes the
          transparency read as glass. Queue chip + approval card ride on top
          of it inside the same overlay. */}
      <div className="chat-composer-dock" ref={composerDockRef}>
      {/* Goal-loop status lives in the GitToolsSidebar goal card (iteration +
          timer + stop), not here — the composer-side chip duplicated it. */}

      {activeChatSessionId && pendingApprovals[activeChatSessionId] && (
        <div className="composer-approval-wrap">
          <ApprovalCard
            approval={pendingApprovals[activeChatSessionId]}
            onResolve={(approved) =>
              void resolveApproval(activeChatSessionId, approved)
            }
          />
        </div>
      )}

      {/* Harness question (Claude Code AskUserQuestion) — the CLI is PAUSED
          on stdin until this is answered or skipped. Docked as a fused notch
          on the composer (same container as the plan proposal): flat bottom
          melts into the composer card's top border. */}
      {activeChatSessionId && pendingQuestions[activeChatSessionId] && (
        <div className="plan-preview">
          <QuestionCard
            question={pendingQuestions[activeChatSessionId]}
            onResolve={(answers, response, skipped) =>
              void resolveQuestionAction(
                activeChatSessionId,
                skipped ? {} : answers,
                skipped ? undefined : response,
              )
            }
          />
        </div>
      )}

      {/* End-of-turn citation-integrity verdict (research turns only): what
          the mechanical ledger lint verified about the report just delivered.
          Renders above the composer so it survives transcript scrolling. */}
      <CitationReportStrip chatSessionId={activeChatSessionId} onFix={(sid) => void handleFixCitations(sid)} />

      {/* present_plan proposal: renders INLINE in the transcript (as the last
          timeline row) instead of in this dock — the floating composer made a
          dock-mounted card overlay the very messages the plan responds to. */}

      {/* present_plan proposal — docked NOTCH on the composer: mounted inside
          the dock (so the floating composer can never overlay it) and styled
          as a fused notch — flat bottom onto the composer card's top border.
          The model is PAUSED until this is resolved; approving unlocks
          mutations, rejecting sends the feedback text back. Its height rides
          in composerDockHeight, so the transcript re-pins above it. */}
      {activeChatSessionId && pendingPlanProposals[activeChatSessionId] && (
        <div className="plan-preview">
          <PlanProposalCard
            proposal={pendingPlanProposals[activeChatSessionId]}
            onResolve={(approved, feedback) =>
              void resolvePlanProposalAction(activeChatSessionId, approved, feedback)
            }
          />
        </div>
      )}

      <ChatComposer
        sessionId={activeChatSessionId}
        draft={draft}
        quotedSelections={quotedSelections}
        onRemoveQuotedSelection={removeQuotedSelection}
        onClearQuotedSelections={clearQuotedSelections}
        onSend={handleSend}
        onStop={handleStop}
        streaming={activeIsStreaming}
        disabled={false}
        model={
          activeChatSessionId
            ? // A session's model is only COMMITTED once an agent is picked
              // (the picker commits agent+provider+model together; the chip
              // shows "⌘ Select agent" before that and Send is agentLocked).
              // New chats are pre-seeded with the provider's default model,
              // and passing that seed through made the meter tooltip name a
              // model the user never picked for this chat — reading as stale
              // data from the previous chat. Mirror the chip: "—" until an
              // agent is picked.
              activeSession?.agent != null
                ? (meterModel ?? "")
                : ""
            : undefined
        }
        modelLabels={modelLabels}
        agent={activeChatSessionId ? (activeSession?.agent ?? null) : undefined}
        onAgentModelPick={handleAgentModelPick}
        permissionMode={
          activeChatSessionId
            ? ((activeSession?.permissionMode as PermissionMode | undefined) ?? "manual")
            : undefined
        }
        onPermissionModeChange={handlePermissionModeChange}
        permissionModeSupported={
          // Kimi/ACP headless runs have no approval channel — no menu. The
          // menu shows for builtin/local chats, Claude Code sessions, and any
          // harness with a native mode catalog (OpenCode build/plan).
          (!harnessAgent && !acpAgent) || !!harnessModeOptions
        }
        planAvailable={planModeSupported}
        modes={harnessModeOptions}
        agentLoading={harnessAgent ? harnessLoading : false}
        effort={effort}
        onEffortChange={setEffort}
        harnessEffort={harnessAgent ? (activeSession?.effortLevel ?? "") : undefined}
        onHarnessEffortChange={handleHarnessEffortChange}
        provider={activeSession?.autoModel ? "auto" : activeSession?.provider}
        modelLoading={localLoading}
        localCtx={localCtx}
        autoBias={autoBias}
        onAutoBiasChange={(b) => setAutoBias(b as "quality" | "balanced" | "economy")}
        onEjectLocalModel={ejectLocalModel}
        localModelActive={isLocal && !!activeLocalModelId}
        localOverridesMap={localOverridesByName}
        onLoadLocalModel={handleLoadLocalModel}
        usedTokens={usedTokens}
        liveMaxTokens={isLocal ? liveUsage.maxTokens : 0}
        chatSessionId={activeChatSessionId}
        thinking={thinking}
        onThinkingChange={setThinking}
        thinkingSupported={thinkingSupported}
      />
      </div>
      {/* Jump-to-latest pill: floats over the transcript just above the
          composer dock whenever the user has scrolled far enough up that the
          live edge is out of view. One click re-pins to the newest turn. */}
      {hasItems && awayFromLive && (
        <button
          type="button"
          className="chat-jump-live"
          style={{ bottom: composerDockHeight > 0 ? composerDockHeight + 14 : 234 }}
          onClick={jumpToLiveEdge}
          title="Jump to latest"
          aria-label="Jump to latest message"
        >
          <ArrowDownIcon />
        </button>
      )}
      {fullAccessConfirmingFor && (
        <FullAutoConfirmModal
          onConfirm={() => void confirmFullAccess(fullAccessConfirmingFor!)}
          onCancel={cancelFullAccessConfirm}
        />
      )}

    </div>
    </div>
  );
}

