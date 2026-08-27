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
import { useUiStore } from "../../state/ui";
import { ChatComposer, type ChatAttachment } from "./ChatComposer";
import { ApprovalCard, FullAutoConfirmModal } from "./ApprovalFlow";
import type { PermissionMode } from "../../state/chat";
import { permissionModeToPolicies } from "../../state/chat";
import type { ChatPerfPayload } from "../../lib/ipc";
// TypingIndicator is tiny and eager — imported from its own module so the
// entry chunk doesn't statically pull in MessageBubble (react-markdown).
import { TypingIndicator } from "./TypingIndicator";
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
import { listHarnessModels, scanLocalModels, startLocalModel, stopLocalModel, localModelStatus, deleteEmptyChatSessions, getLocalModelOverrides, setLocalModelOverrides, warmupLocalPrompt, type ChatMessage, type GgufModel, type HarnessModelConfig, type LlamaOverrides, regenerateArtifact, createArtifact, type ArtifactProposal, type ArtifactSpec, type ArtifactProvenance } from "../../lib/ipc";
import { harnessModelCatalog } from "../../lib/harnessModels";
import { setChatScrollToMessage } from "../../lib/chatScroll";
import type { AgentModelSelection } from "./AgentModelPicker";
import { TurnNavigator } from "./TurnNavigator";
import { useContextMeter } from "../../hooks/useContextMeter";
import { useElementHeight } from "../../hooks/useElementHeight";
import { GitToolsSidebar } from "./GitToolsSidebar";

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

// Starter prompts shown on the Claude-style welcome screen for a fresh,
// empty conversation. Clicking one sends it immediately.
const WELCOME_PROMPTS: Array<{ title: string; sub: string }> = [
  { title: "Write a document", sub: "Draft a brief, memo, or report" },
  { title: "Explain a concept", sub: "Get a clear breakdown of any topic" },
  { title: "Write code", sub: "Build a script, fix a bug, or refactor" },
  { title: "Research a topic", sub: "Gather and synthesize sources" },
];

export function ChatView({ popoutSessionId }: { popoutSessionId?: string } = {}) {
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const livePerf = useChatStore((s) => s.livePerf);
  const chatStatus = useChatStore((s) => s.chatStatus);
  const error = useChatStore((s) => s.error);
  const loaded = useChatStore((s) => s.loaded);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const regenerate = useChatStore((s) => s.regenerate);
  const editMessage = useChatStore((s) => s.editMessage);
  const cancelStream = useChatStore((s) => s.cancelStream);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const setPreviewArtifact = useChatStore((s) => s.setPreviewArtifact);
  const loopState = useChatStore((s) => s.loopState);
  const startLoop = useChatStore((s) => s.startLoop);
  const stopLoop = useChatStore((s) => s.stopLoop);
  const sessions = useChatStore((s) => s.sessions);
  const setSessionModel = useChatStore((s) => s.setSessionModel);
  const setSessionProvider = useChatStore((s) => s.setSessionProvider);
  const setSessionAgent = useChatStore((s) => s.setSessionAgent);
  const effort = useChatStore((s) => s.effort);
  const setEffort = useChatStore((s) => s.setEffort);
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
  // Scanned local GGUF records — resolve picks from the combined picker into
  // spawnable sidecars, and `resolvedModel` into name/filename form. The
  // picker itself fetches every agent's/model list (harness config, provider
  // /v1/models, local scan) directly.
  const [localModels, setLocalModels] = useState<GgufModel[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  // id of the running local-model sidecar, or null if none. Drives the ⏏
  // button on the model pill — the button is only shown when a sidecar is
  // actually live (verified via local_model_status, not just inferred from
  // the session's stored model, since the user may have killed the sidecar
  // manually between sessions).
  const [activeLocalModelId, setActiveLocalModelId] = useState<string | null>(null);
  // Persisted per-model runtime overrides (`localModels.overrides` blob) —
  // the single source of truth the backend also reads at spawn time. Loaded
  // on mount and refreshed after every Apply; a ref mirror keeps the spawn
  // handlers free of stale closures.
  const [localOverridesMap, setLocalOverridesMap] = useState<Record<string, LlamaOverrides>>({});
  const localOverridesMapRef = useRef<Record<string, LlamaOverrides>>({});
  const refreshLocalOverrides = useCallback(async () => {
    try {
      const blob = await getLocalModelOverrides();
      const map = blob ? (JSON.parse(blob) as Record<string, LlamaOverrides>) : {};
      localOverridesMapRef.current = map;
      setLocalOverridesMap(map);
    } catch {
      /* best-effort — empty map means "all auto" */
    }
  }, []);
  useEffect(() => {
    void refreshLocalOverrides();
  }, [refreshLocalOverrides]);
  /** Per-model persisted overrides keyed by the picker's row id
   *  (name/filename) — seeds the gear panel drafts. */
  const localOverridesByName = useMemo(() => {
    const out: Record<string, LlamaOverrides> = {};
    for (const m of localModels) {
      const ov = localOverridesMap[m.id];
      if (ov) out[m.name || m.filename] = ov;
    }
    return out;
  }, [localModels, localOverridesMap]);

  // Scan local GGUF files (default locations + any persisted folders) for
  // EVERY session — local models are offered in the picker regardless of
  // the session's provider; picking one switches the session to local_gguf.
  useEffect(() => {
    let stale = false;
    void scanLocalModels().then((list) => {
      if (!stale && list) setLocalModels(list);
    });
    return () => {
      stale = true;
    };
  }, [activeChatSessionId]);

  // Track the running sidecar so the ⏏ button on the model pill only shows
  // when a llama-server is actually live. Polled on mount, whenever the
  // active session changes, and whenever a local model finishes loading
  // (so the button appears the moment a pick completes).
  useEffect(() => {
    let stale = false;
    void localModelStatus().then((status) => {
      if (stale) return;
      setActiveLocalModelId(status?.modelId ?? null);
    });
    return () => {
      stale = true;
    };
  }, [activeChatSessionId, localLoading, activeSession?.model]);

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

  // Context meter "used" figure: prefer the live count from llama-server's
  // /tokenize (driven by `useContextMeter`, polled while a local_gguf session
  // is active), and fall back to the input_tokens of the most recent
  // assistant turn for cloud sessions or before the first poll resolves.
  // Both values represent the full prompt size the model saw.
  const lastInputTokens = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.inputTokens != null && m.inputTokens > 0) {
        return m.inputTokens;
      }
    }
    return null;
  }, [messages]);

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
  const liveUsage = useContextMeter({
    chatSessionId: activeChatSessionId,
    isLocal,
    isStreaming: isStreamingForMeter,
    messagesRevision: messages.length,
    compactionRevision,
  });
  // Live count wins for local sessions; the persisted last-turn value is the
  // fallback for cloud sessions and the brief window before the first poll
  // resolves. Either way, the meter's percentage is a real number.
  const usedTokens = isLocal
    ? (liveUsage.usedTokens ?? lastInputTokens)
    : lastInputTokens;

  // Spawn/swap the local-model sidecar for a scanned GGUF record. Returns the
  // error text on failure (surfaced by the callers via the chat error banner)
  // or null on success. The caller decides what to persist — on failure the
  // session must NOT be stomped to the failed model (the previous sidecar is
  // the only thing a send could still hit). `overrides` (from the picker's
  // per-model gear panel) wins; without it the backend loads the persisted
  // overrides blob itself (incl. last-good ngl).
  //
  // lastWarmRef dedupes prompt warmups with the chat-switch effect below:
  // the cached prefix includes the chat's working-directory section, so
  // switching between chats with different roots needs a re-warm.
  const lastWarmRef = useRef<{ sid: string | null; wd: string } | null>(null);
  const spawnLocalModel = useCallback(
    async (match: GgufModel, overrides?: LlamaOverrides): Promise<string | null> => {
      setLocalLoading(true);
      try {
        await startLocalModel(match.id, match.path, match.mmprojPath, overrides);
        // Warm the prompt cache with the EXACT prefix this session's next
        // send will render — system prompt + tools + the `## Working
        // directory` tail. The working dir is frontend state (custom folder →
        // worktree → bound project), resolved here exactly like sendMessage
        // resolves it; the backend can't know it at load time. The loading
        // spinner stays up until the warmup completes, so "loaded" means the
        // first message answers immediately instead of paying CUDA init +
        // multi-thousand-token prompt eval. Best-effort: a failed warmup
        // just means the first send pays the normal cold-start cost.
        try {
          const s = useChatStore.getState();
          const sid = s.activeChatSessionId;
          const session = sid ? s.sessions.find((x) => x.id === sid) : undefined;
          const projects = useProjectsStore.getState();
          const boundProject = sid
            ? projects.projectById(s.sessionProjects[sid] ?? projects.selectedProjectId)
            : undefined;
          const workingDir =
            (sid ? s.cwdOverrides[sid] : undefined) ??
            session?.worktreePath ??
            boundProject?.path;
          // Composer toggles ride along: the tool specs are part of the cached
          // prefix, so a warmup that assumes different toggles than the first
          // send uses saves nothing (this mismatch — web_search/code_exec —
          // is exactly what made first messages pay the full prompt eval).
          await warmupLocalPrompt(
            workingDir,
            sid,
            s.toolsEnabled,
            s.codeExecEnabled,
          );
          lastWarmRef.current = { sid: sid ?? null, wd: workingDir ?? "" };
        } catch (warmErr) {
          console.warn("prompt warmup failed (non-fatal)", warmErr);
        }
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("start local model failed", msg);
        return msg;
      } finally {
        setLocalLoading(false);
      }
    },
    [],
  );

  // Re-warm the prompt cache when the active chat changes (while a local
  // model is loaded and idle): the cached prefix includes the chat's
  // working-directory section, so the first message in a NEW chat (different
  // project, or unbound) used to pay the full ~22s re-eval. Fire-and-forget —
  // a message sent mid-warmup queues behind it (the same cost it would pay
  // without any warmup), and a completed one makes the first token instant.
  useEffect(() => {
    if (!isLocal || localLoading) return;
    const s = useChatStore.getState();
    if (activeChatSessionId && activeChatSessionId in s.streaming) return;
    // Only fresh conversations need a warmup: a session with completed turns
    // already has its real prefix cached from the last turn, and a synthetic
    // warmup would just churn the GPU queue behind live traffic.
    if (activeChatSessionId && s.messages.some((m) => m.role === "assistant")) return;
    const session = activeChatSessionId
      ? s.sessions.find((x) => x.id === activeChatSessionId)
      : undefined;
    const projects = useProjectsStore.getState();
    const boundProject = activeChatSessionId
      ? projects.projectById(s.sessionProjects[activeChatSessionId] ?? projects.selectedProjectId)
      : undefined;
    const wd =
      (activeChatSessionId ? s.cwdOverrides[activeChatSessionId] : undefined) ??
      session?.worktreePath ??
      boundProject?.path ??
      "";
    const last = lastWarmRef.current;
    if (last && last.sid === (activeChatSessionId ?? null) && last.wd === wd) return;
    lastWarmRef.current = { sid: activeChatSessionId ?? null, wd };
    void warmupLocalPrompt(
      wd || null,
      activeChatSessionId,
      s.toolsEnabled,
      s.codeExecEnabled,
    ).catch(() => {});
  }, [activeChatSessionId, isLocal, localLoading]);

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
      if ((session?.agent ?? null) !== sel.agent) {
        await setSessionAgent(activeChatSessionId, sel.agent);
      }
      // ACP agents decide their own model — the agent switch above is all.
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
  const confirmFullAccess = useChatStore((s) => s.confirmFullAccess);
  const cancelFullAccessConfirm = useChatStore((s) => s.cancelFullAccessConfirm);
  const setSessionPolicies = useChatStore((s) => s.setSessionPolicies);
  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      if (!activeChatSessionId) return;
      const { sandbox, approval } = permissionModeToPolicies(mode);
      void setSessionPolicies(activeChatSessionId, sandbox, approval);
    },
    [activeChatSessionId, setSessionPolicies],
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // The composer dock FLOATS over the transcript, so the message list must
  // reserve the dock's real height as bottom padding — a hardcoded constant
  // goes stale the moment the composer grows a line or a queue/approval/
  // goal-loop chip stacks on top of it. Measured live instead.
  const [composerDockRef, composerDockHeight] = useElementHeight<HTMLDivElement>();
  // Whether new content should keep the view pinned to the bottom. Flipped
  // off as soon as the user scrolls up, so streaming tokens never yank the
  // scroll back down while they're reading history; flipped on again when
  // they scroll back to the bottom.
  const stickToBottomRef = useRef(true);
  // Mirrors of the derived render items + the list virtualizer, so the
  // scroll-to-message helper (registered once, above their definitions) can
  // reach the current values without stale closures.
  const itemsRef = useRef<Array<{ key: string; id?: number }>>([]);
  const virtualizerRef = useRef<{ scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto"; behavior?: "auto" | "smooth" }) => void } | null>(null);
  // Currently-mounted virtual row elements by item key. Lets the structural-
  // change effect re-measure just the visible rows (see the structureSig
  // effect below) instead of wiping the whole measurement cache.
  const rowElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // Last-known real height per row key. Rows whose ref-measure was skipped
  // (the virtualizer skips element measures while its isScrolling flag is hot
  // — and the auto-follow scrollTop writes keep it hot through every stream)
  // keep their 160px estimate forever once they scroll out of the render
  // window: ResizeObserver never fires without a later resize, so nothing
  // corrects them. totalSize then under-counts real content height, and the
  // absolutely-positioned rows overflow past it — the typing indicator (which
  // sits right after totalSize) painted over earlier messages instead of
  // following the newest turn. We record each mounted row's offsetHeight here
  // and write it back into the virtualizer's size cache when the row unmounts.
  const rowHeightsRef = useRef<Map<string, number>>(new Map());

  // Draft handed to the composer: bumping `nonce` re-prefills the textarea
  // (used by the per-message "Edit" action to load a message for resend).
  const [draft, setDraft] = useState<{ text: string; nonce: number }>({
    text: "",
    nonce: 0,
  });

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
  // previous launch) — so they never accumulate in the sidebar.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!loaded || !config || activeChatSessionId || autoStarted.current) return;
    autoStarted.current = true;
    void deleteEmptyChatSessions().then((deleted) => {
      if (deleted) void loadSessions();
    });
    const provider = config.provider ?? "openai_compatible";
    // Seed the new session with the provider's persisted default model
    // (chat.<provider>.model) so the model selector stays populated instead of
    // snapping to empty — which previously made it look like the selected
    // model (including a running local sidecar) had been ejected. Falls back
    // to "" only when no default model is configured for the provider, in
    // which case the user must still pick one before sending.
    void newChat(provider, config.model ?? "");
  }, [loaded, activeChatSessionId, config, newChat, loadSessions]);

  const loadOlderMessages = useChatStore((s) => s.loadOlderMessages);
  const hasMoreHistory = useChatStore((s) => s.hasMoreHistory);
  const loadingOlderRef = useRef(false);

  // Track whether the user is pinned near the bottom. Runs on every scroll
  // (user- or programmatic). Once they scroll up past the threshold, auto
  // follow is paused until they return to the bottom. Also: M7 — scrolling to
  // the very top of a paged session prepends the next older page while
  // holding the visual position steady.
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const threshold = 80; // px from bottom to still count as "at bottom"
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distanceFromBottom < threshold;

    // BUG FIX (jump-to-top on send): the prepend trigger used to fire on
    // `scrollTop < 120` alone — but a chat pinned to the bottom whose content
    // barely overflows ALSO sits at scrollTop < 120, so merely SENDING a
    // message (whose scroll events land here) silently prepended up to 200
    // estimated-tall rows above the viewport. The view suddenly showed the
    // oldest page and the anchor restore raced the virtualizer's measuring
    // cascade — reading as "the chat scrolled to the top". Only prepend when
    // the user actually scrolled AWAY from the live edge.
    if (
      container.scrollTop < 120 &&
      distanceFromBottom > threshold &&
      hasMoreHistory &&
      !loadingOlderRef.current &&
      activeChatSessionId
    ) {
      loadingOlderRef.current = true;
      const prevHeight = container.scrollHeight;
      const prevTop = container.scrollTop;
      void loadOlderMessages(activeChatSessionId).finally(() => {
        loadingOlderRef.current = false;
        // Restore the visual anchor: prepended rows pushed everything down.
        requestAnimationFrame(() => {
          const el = messagesContainerRef.current;
          if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
        });
      });
    }
  }, [hasMoreHistory, activeChatSessionId, loadOlderMessages]);

  // Follow new messages / streaming tokens only while pinned to the bottom.
  // Writes scrollTop directly instead of scrollIntoView: scrollIntoView also
  // repositions every scrollable ANCESTOR and can be hijacked mid-flight by
  // the virtualizer's own scroll corrections — both able to leave the list
  // stranded away from (or above) the live edge during a send/stream burst.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (el && stickToBottomRef.current) {
      const target = el.scrollHeight - el.clientHeight;
      // Skip the write when already at the live edge: redundant scrollTop
      // writes fire scroll events that keep the virtualizer's isScrolling
      // flag hot, which makes its element-measure pass SKIP rows mounting
      // mid-stream (the swapped-in persisted row after a turn ends).
      if (Math.abs(el.scrollTop - target) > 1) {
        el.scrollTop = target;
      }
    }
  }, [messages, streaming]);

  // Switching sessions resets to the bottom of the new conversation.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [activeChatSessionId]);

  // The per-action approval card sits below the message list in the composer
  // flex column. Mounting/unmounting it shrinks/grows the scroll viewport, and
  // the browser clamps scrollTop when the viewport shrinks — so the chat
  // appears to "jump to the top" when an approval card appears mid-stream.
  // Preserve the user's scroll anchor across approval-card mount/unmount.
  const approvalKey = activeChatSessionId
    ? pendingApprovals[activeChatSessionId]?.pendingId ?? null
    : null;
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    // Pinned to the live edge? Then after the card settles just slam to the
    // bottom (the follow effect does the same) — computing a restore offset
    // against a mid-layout snapshot is what let this effect fling the chat
    // upward when it fired while content heights were still settling.
    if (stickToBottomRef.current) {
      const raf = requestAnimationFrame(() => {
        const el = messagesContainerRef.current;
        if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
      });
      return () => cancelAnimationFrame(raf);
    }
    // Snapshot the relative scroll position (distance from bottom) before the
    // card's height change is reflected in the layout.
    const prevBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const raf = requestAnimationFrame(() => {
      // After the card mounts/unmounts, restore the same distance-from-bottom
      // so the chat content stays visually put. Clamp into the valid range —
      // a stale/negative target must never move scrollTop.
      const el = messagesContainerRef.current;
      if (!el) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.min(max, Math.max(0, el.scrollHeight - el.clientHeight - prevBottom));
    });
    return () => cancelAnimationFrame(raf);
  }, [approvalKey]);

  // Register a scroll-to-message helper so the TurnNavigator can jump to a
  // specific turn. Sets stickToBottom OFF first so the auto-follow effect
  // doesn't yank the scroll back to the bottom while streaming.
  useEffect(() => {
    setChatScrollToMessage((msgId: number) => {
      stickToBottomRef.current = false;
      // PERF (F5): with the message list virtualized, off-screen bubbles
      // aren't in the DOM — scroll the virtualizer to the message's index
      // instead of querySelector'ing a possibly-unmounted element.
      const idx = itemsRef.current.findIndex((i) => i.id === msgId);
      if (idx >= 0) {
        virtualizerRef.current?.scrollToIndex(idx, {
          align: "start",
          behavior: "smooth",
        });
      }
    });
    return () => setChatScrollToMessage(null);
  }, []);

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
        startLoop(goal);
      }
      void sendMessage(content, attachments, forceResearch);
    },
    [sendMessage, startLoop],
  );

  // Edit-to-fork submit (roadmap #9): retire this message's tail, then re-send
  // the edited text as a new turn. Wired per item so the bubble's Save handler
  // carries the message id.
  const handleSubmitEdit = useCallback(
    (messageId: number | undefined, newContent: string) => {
      if (messageId == null) return;
      void editMessage(messageId, newContent);
    },
    [editMessage],
  );

  const handleStop = useCallback(() => {
    void cancelStream();
  }, [cancelStream]);

  const handleRepeat = useCallback(() => {
    stickToBottomRef.current = true;
    void regenerate();
  }, [regenerate]);

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
      void deleteMessage(messageId);
    },
    [deleteMessage],
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
  };
  const items: TimelineItem[] = useMemo(() => {
    const proposals = activeChatSessionId
      ? artifactProposalsBySession[activeChatSessionId] ?? []
      : [];
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
      for (const entry of proposals.filter((p) => p.proposal.sourceMessageId === m.id)) {
        list.push({
          role: "system",
          content: "",
          key: `proposal-${entry.id}`,
          proposalEntry: entry,
        });
      }
    });
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
        // below. Keeping it out of this memo prevents a 500ms perf heartbeat
        // from rebuilding every persisted row (and invalidating their diagram
        // subtrees) while the turn streams.
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
    return list;
  }, [messages, activeChatSessionId, artifactProposalsBySession, activeIsStreaming, activeStream, waitingForFirstToken, handleDelete, handleSubmitEdit]);
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
  const structureSig = items
    .map((i) => i.key + (i.proposalEntry ? `:${i.proposalEntry.state}` : ""))
    .join("|");
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
      <GitToolsSidebar />
      {!activeChatSessionId || hasItems ? (
        <div
          className="chat-messages"
          ref={messagesContainerRef}
          onScroll={handleScroll}
          // Reserve the floating composer dock's real height (+ breathing
          // room) so the last turn never sits behind it. Falls back to the
          // CSS constant (220px) until the first measurement lands.
          style={{
            paddingBottom:
              composerDockHeight > 0 ? composerDockHeight + 28 : undefined,
          }}
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
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
                      statusNotice && statusNotice.message ? (
                        <div className="chat-status-notice" role="status">
                          <span className="local-spinner" aria-hidden="true" />
                          <span>{statusNotice.message}</span>
                        </div>
                      ) : (
                        <TypingIndicator />
                      )
                    ) : (
                      <MessageBubble
                        message={item}
                        live={item.live}
                        msgId={item.id}
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
            <div className="chat-error">
              <span className="chat-error-icon">⚠</span>
              <span className="chat-error-text">{formatChatError(error)}</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      ) : (
        <div className="chat-welcome">
          <div className="chat-welcome-inner">
            <div className="chat-welcome-greeting">Good to see you</div>
            <div className="chat-welcome-question">How can I help you today?</div>
            <div className="chat-welcome-prompts">
              {WELCOME_PROMPTS.map((p) => (
                <button
                  key={p.title}
                  type="button"
                  className="chat-welcome-prompt"
                  onClick={() => {
                    // Chips send immediately. Without any model (session model
                    // or provider default from Settings) the send would fail,
                    // so fall back to prefilling the composer — the user picks
                    // a model, then hits send.
                    if (activeSession?.model || config?.model) {
                      stickToBottomRef.current = true;
                      void sendMessage(p.title);
                    } else {
                      setDraft({ text: p.title, nonce: Date.now() });
                    }
                  }}
                >
                  <span className="chat-welcome-prompt-title">{p.title}</span>
                  <span className="chat-welcome-prompt-sub">{p.sub}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Plan preview: appears above composer when the latest assistant message contains a plan */}
      <PlanPreview
        messages={messages}
        activeSessionId={activeChatSessionId}
        streaming={activeIsStreaming}
        onSend={handleSend}
      />

      {/* Composer dock: overlays the transcript (position:absolute) so
          messages scroll BEHIND the glass card — that's what makes the
          transparency read as glass. Queue chip + approval card ride on top
          of it inside the same overlay. */}
      <div className="chat-composer-dock" ref={composerDockRef}>
      {/* Goal-loop status chip: shows iteration count + Stop while a /goal or
          /loop is running for THIS session. Sits above the composer so it
          doesn't push the message list. */}
      {activeChatSessionId && loopState[activeChatSessionId]?.active && (() => {
        const loop = loopState[activeChatSessionId];
        return (
          <div className="composer-queue" aria-label="Goal loop running">
            <div className="composer-queue-header" style={{ cursor: "default" }}>
              <span className="composer-queue-chevron" aria-hidden="true">▾</span>
              <span className="composer-queue-index" title="Active goal loop">🔁</span>
              <span className="composer-queue-text" title={loop.goal}>
                Goal loop — iteration {loop.iteration}/{loop.max}{" "}
                {loop.goal ? `· ${loop.goal.slice(0, 80)}${loop.goal.length > 80 ? "…" : ""}` : ""}
              </span>
              <button
                type="button"
                className="composer-queue-remove"
                title="Stop the goal loop"
                aria-label="Stop the goal loop"
                onClick={() => stopLoop()}
              >
                ×
              </button>
            </div>
          </div>
        );
      })()}

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

      <ChatComposer
        draft={draft}
        onSend={handleSend}
        onStop={handleStop}
        streaming={activeIsStreaming}
        disabled={false}
        model={activeChatSessionId ? (resolvedModel ?? "") : undefined}
        modelLabels={
          harnessAgent
            ? Object.fromEntries(harnessModels.map((m) => [m.id, m.label]))
            : undefined
        }
        agent={activeChatSessionId ? (activeSession?.agent ?? null) : undefined}
        onAgentModelPick={handleAgentModelPick}
        permissionMode={
          activeChatSessionId
            ? ((activeSession?.permissionMode as PermissionMode | undefined) ?? "manual")
            : undefined
        }
        onPermissionModeChange={handlePermissionModeChange}
        permissionModeSupported={
          // Kimi/OpenCode/ACP headless runs have no approval channel (kimi -p
          // auto-approves; opencode run can't surface an ask; ACP v1 doesn't
          // map permissions) — the menu only shows for builtin/local chats
          // and Claude Code sessions.
          (!harnessAgent && !acpAgent) || harnessAgent === "claude_code"
        }
        agentLoading={harnessAgent ? harnessLoading : false}
        effort={effort}
        provider={activeSession?.provider}
        modelLoading={localLoading}
        localCtx={localCtx}
        onEffortChange={setEffort}
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

// ---- Plan Preview (above composer) ----

// Plan detection: matches common plan/approach headers that models produce.
// Designed to be inclusive enough for real-world responses (Claude, GPT, etc.)
// but not so loose it triggers on every bullet list.
const PLAN_PATTERNS = [
  // Markdown heading with plan keywords. "Steps" alone is too loose (file
  // trees, install steps, etc.) — require it to be "Steps to/for/of …".
  /^#{1,3}\s*(?:Plan|Planning|Approach|Strategy|Implementation|Proposed Solution|Game Plan|Roadmap|To[- ]Do|Action Plan)\b/im,
  /^#{1,3}\s*Steps\s+(?:to|for|of)\b/im,
  // Phrasal intros — model says "Here's my plan" or "Let me outline"
  /(?:^|\n\n)(?:Here(?:'s| is) (?:my |the |a |an )?(?:plan|approach|breakdown|strategy|outline|steps?))/im,
  /(?:^|\n\n)(?:Let me (?:(?:quickly )?(?:plan|outline|break(?:\s+down)?|sketch|lay out|map out|walk through)|explain (?:my |the )?(?:plan|approach|thinking)))/im,
  /(?:^|\n\n)(?:I(?:'ll| will) (?:plan|break|outline|do the following|take the following|proceed (?:as follows|in these steps)|tackle this (?:in |with )?steps?|start by))/im,
  /(?:^|\n\n)(?:My (?:plan|approach|strategy|recommendation|suggestion) (?:is|would be|:))/im,
  /(?:^|\n\n)(?:Here(?:'s| is) (?:how|what) I(?:'ll| will) (?:do|approach|proceed|tackle|handle|implement))/im,
  // Numbered plan marker: requires TWO consecutive numbered items (a real
  // ordered plan), not just one numbered line.
  /(?:^|\n)(?:\d+[.)]\s+)(?:\*\*[^*]+\*\*\s*)?(?:\d+[.)]\s+)/m,
];

function detectPlanSection(content: string): { title: string; lines: string[]; full: string } | null {
  // Strip reasoning blocks first
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (cleaned.length < 60) return null;

  for (const pattern of PLAN_PATTERNS) {
    const m = pattern.exec(cleaned);
    if (m && m.index >= 0) {
      const start = m.index;
      const after = cleaned.slice(start);
      const headerEnd = m[0].length;
      // Take content from the plan header to the next ## section, or ~500 chars
      const nextSection = after.slice(headerEnd).search(/^#{1,3}\s+(?!Plan|Step)/m);
      const full = nextSection !== -1
        ? after.slice(0, headerEnd + nextSection).trim()
        : after.slice(0, Math.min(after.length, 600)).trim();
      // Only count as a plan if there's substantial content after the header
      const bodyAfterHeader = full.slice(headerEnd).trim();
      if (bodyAfterHeader.length < 30) continue;
      const title = m[0]
        .replace(/^#{1,3}\s*/, "")
        .replace(/[*_`]/g, "")
        .trim()
        .slice(0, 70);
      const allLines = full.split("\n").filter((l) => l.trim().length > 0);
      if (allLines.length < 2) continue;
      return { title, lines: allLines, full };
    }
  }
  return null;
}

function PlanPreview({
  messages,
  activeSessionId,
  streaming,
  onSend,
}: {
  messages: import("../../lib/ipc").ChatMessageRecord[];
  activeSessionId: string | null;
  streaming: boolean;
  onSend: (content: string, attachments: import("./ChatComposer").ChatAttachment[], forceResearch?: boolean) => void;
}) {
  const setPlanCanvas = useUiStore((s) => s.setPlanCanvas);
  const openPlanTab = useUiStore((s) => s.openPlanTab);

  // Only show plan preview when NOT streaming and we have messages
  if (!activeSessionId || streaming) return null;

  // Find the latest assistant message that contains a plan
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return null;

  const plan = detectPlanSection(lastAssistant.content);
  if (!plan) return null;

  // Show first 4 lines clearly, rest with blur
  const visibleLines = plan.lines.slice(0, 4);
  const blurLines = plan.lines.slice(4, 6);

  const handleAgree = () => {
    onSend("I agree with this plan. Proceed with the implementation.", []);
  };

  const handleExpand = () => {
    // Strip the plan's own heading from the body so the plan tab doesn't
    // double-display it
    const bodyWithoutHeader = plan.full.replace(/^#{1,3}\s+[^\n]+\n*/, "").trim();
    setPlanCanvas(bodyWithoutHeader || plan.full, plan.title);
    openPlanTab();
  };

  return (
    <div className="plan-preview">
      <div className="plan-preview-card">
        <div className="plan-preview-title">
          <svg className="plan-preview-icon" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
            <rect x="9" y="3" width="6" height="4" rx="1" />
            <path d="M9 14l2 2 4-4" />
          </svg>
          {plan.title}
        </div>
        <div className="plan-preview-lines">
          {visibleLines.map((line, i) => (
            <div key={i} className="plan-preview-line">{line}</div>
          ))}
          {blurLines.length > 0 && (
            <div className="plan-preview-blur">
              {blurLines.map((line, i) => (
                <div key={i} className="plan-preview-line">{line}</div>
              ))}
            </div>
          )}
        </div>
        <div className="plan-preview-actions">
          <button className="plan-preview-btn expand" onClick={handleExpand}>
            Expand
          </button>
          <button className="plan-preview-btn agree" onClick={handleAgree}>
            Agree &amp; proceed
          </button>
        </div>
      </div>
    </div>
  );
}