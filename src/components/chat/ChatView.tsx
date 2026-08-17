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
import { useUiStore } from "../../state/ui";
import { ChatComposer, type ChatAttachment } from "./ChatComposer";
import { ApprovalCard, FullAutoConfirmModal } from "./ApprovalFlow";
import type { PermissionMode } from "../../state/chat";
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
import { listChatModels, listHarnessModels, scanLocalModels, startLocalModel, stopLocalModel, localModelStatus, deleteEmptyChatSessions, getLocalModelOverrides, setLocalModelOverrides, type ChatMessage, type GgufModel, type HarnessModelConfig, type LlamaOverrides } from "../../lib/ipc";
import { harnessModelCatalog } from "../../lib/harnessModels";
import { setChatScrollToMessage } from "../../lib/chatScroll";
import { TurnNavigator } from "./TurnNavigator";
import { useContextMeter } from "../../hooks/useContextMeter";
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

/** Dedupe model ids case-insensitively — some providers return the same model
 *  in mixed case ("GPT-4o" and "gpt-4o"); first occurrence wins. Blanks dropped. */
function dedupeModelIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = id.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** Case-insensitive membership check for model id lists. */
function includesModelId(ids: string[], id: string): boolean {
  const key = id.trim().toLowerCase();
  return ids.some((i) => i.trim().toLowerCase() === key);
}

export function ChatView({ popoutSessionId }: { popoutSessionId?: string } = {}) {
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
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
  const artifacts = useChatStore((s) =>
    activeChatSessionId ? s.artifacts[activeChatSessionId] : undefined,
  );
  const artifactsByMessage = useChatStore((s) => s.artifactsByMessage);
  const sessionTasks = useChatStore((s) =>
    activeChatSessionId ? Object.values(s.tasks[activeChatSessionId] ?? {}) : [],
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
  // The provider whose cloud models the selector lists. For local_gguf
  // sessions that's the configured cloud provider (so the user can switch
  // back); for any other session it's the session's own provider. Only the
  // compatible providers + OpenRouter have a `/v1/models` endpoint to list.
  const cloudProvider = isLocal
    ? config?.provider && config.provider !== "local_gguf"
      ? config.provider
      : null
    : (activeSession?.provider ?? null);
  const cloudCompatible =
    cloudProvider === "anthropic_compatible" ||
    cloudProvider === "openai_compatible" ||
    cloudProvider === "openrouter";
  const [models, setModels] = useState<string[]>([]);
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
  // The active session's local model record, when it resolves in the scan —
  // gates the inline Advanced runtime editor and provides its spawn args.
  const activeLocal = useMemo(
    () =>
      isLocal && activeSession?.model
        ? localModels.find((m) => (m.name || m.filename) === activeSession.model) ?? null
        : null,
    [isLocal, activeSession?.model, localModels],
  );
  /** Slider-ctx merge for one-off spawns: the composer ctx slider wins over
   *  the persisted ctx when set; no slider → undefined lets the backend load
   *  the persisted blob itself (incl. last-good ngl). */
  const ovrWithCtx = useCallback(
    (id: string): LlamaOverrides | undefined =>
      localCtx ? { ...(localOverridesMapRef.current[id] ?? {}), ctx: localCtx } : undefined,
    [localCtx],
  );

  // Fetch the cloud model list (uses the stored key and base URL from
  // Settings). Refetched when the listed provider changes.
  useEffect(() => {
    setModels([]);
    if (!cloudProvider || !cloudCompatible) return;
    let stale = false;
    void listChatModels(cloudProvider).then((list) => {
      if (!stale && list) setModels(dedupeModelIds(list.map((m) => m.id)));
    });
    return () => {
      stale = true;
    };
  }, [cloudProvider, cloudCompatible, activeChatSessionId]);

  // Scan local GGUF files (default locations + any persisted folders) for
  // EVERY session — local models are offered in the selector regardless of
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

  // Cloud ids for the selector, deduped case-insensitively. The session's
  // current cloud model is always included, even if not in the endpoint list.
  const cloudIds = (() => {
    const ids = dedupeModelIds(models);
    if (!isLocal && activeSession?.model && !includesModelId(ids, activeSession.model)) {
      ids.unshift(activeSession.model);
    }
    return ids;
  })();
  // Local ids (scanned GGUF display names), same treatment for a local
  // session's current model.
  const localIds = (() => {
    const ids = dedupeModelIds(localModels.map((m) => m.name || m.filename));
    if (isLocal && activeSession?.model) {
      // The session's stored local model can be keyed three ways depending on
      // how it was set: the GGUF metadata `name`, the `filename`, OR the
      // registry id-slug that start_local_model persists to
      // chat.local_gguf.model (which seeds "New Chat"). If ANY of those match
      // a scanned model, that model is already listed — don't prepend a stale
      // second row (the "selected + non-selected duplicate" bug). Only prepend
      // when the stored model is genuinely not in the scan (e.g. the file was
      // removed from the scan folders but the session still references it).
      const stored = activeSession.model.trim().toLowerCase();
      const alreadyListed =
        includesModelId(ids, activeSession.model) ||
        localModels.some(
          (m) =>
            (m.id && m.id.toLowerCase() === stored) ||
            (m.filename && m.filename.toLowerCase() === stored) ||
            (m.name && m.name.toLowerCase() === stored),
        );
      if (!alreadyListed) ids.unshift(activeSession.model);
    }
    return ids;
  })();

  // The model id shown as "selected" in the selector. The session may store a
  // local model under its registry id-slug (persisted by start_local_model),
  // but the selector lists local models by `name || filename`. Resolve the
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

  const handleModelChange = useCallback(
    async (model: string) => {
      if (!activeChatSessionId) return;
      const localMatch = localModels.find((m) => (m.name || m.filename) === model);
      if (localMatch) {
        // Local model picked (in ANY session): spawn/swap the sidecar first
        // (start_local_model stops any existing one), then point the session
        // at the local provider so subsequent sends hit its endpoint.
        setLocalLoading(true);
        let startErr: string | null = null;
        try {
          await startLocalModel(localMatch.id, localMatch.path, localMatch.mmprojPath, ovrWithCtx(localMatch.id));
        } catch (err) {
          // Keep the failure reason around so the user sees a meaningful
          // error instead of a cryptic 400 on the NEXT send. Two important
          // things to know:
          //   1. We do NOT update the session model — the sidecar didn't
          //      load, so the previous model (still in the registry) is
          //      the only one a send could possibly hit. Stomping the
          //      session to the failed model would orphan the session on
          //      a dead endpoint and the user would see a 400.
          //   2. We surface the error to the chat store's `error` field
          //      so the same `chat-error` banner that handles provider
          //      errors shows it. The error is also scrubbed via
          //      `formatChatError` to strip the noisy llama.cpp startup
          //      logs and keep just the salient reason (e.g. "unknown
          //      model architecture: 'kimi-k3'").
          startErr = err instanceof Error ? err.message : String(err);
          console.warn("start local model failed", startErr);
        } finally {
          setLocalLoading(false);
        }
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
    [activeChatSessionId, setSessionModel, setSessionProvider, isLocal, localModels, ovrWithCtx, config?.provider],
  );

  // Apply context-size changes to a running local model: llama-server's -c is
  // fixed at process start, so moving the slider reloads the model with the
  // new value. Debounced so dragging doesn't respawn the server on every
  // tick, and guarded so mounting/session switches don't trigger a reload.
  const appliedCtxRef = useRef(localCtx);
  useEffect(() => {
    if (localCtx === appliedCtxRef.current) return;
    if (!isLocal || !activeSession?.model) {
      // No running local model — the value applies to the next start.
      appliedCtxRef.current = localCtx;
      return;
    }
    const model = activeSession.model;
    const match = localModels.find((m) => (m.name || m.filename) === model);
    if (!match) {
      appliedCtxRef.current = localCtx;
      return;
    }
    const t = setTimeout(() => {
      appliedCtxRef.current = localCtx;
      setLocalLoading(true);
      startLocalModel(match.id, match.path, match.mmprojPath, ovrWithCtx(match.id))
        .catch((err) => console.warn("restart local model with new ctx failed", err))
        .finally(() => setLocalLoading(false));
    }, 800);
    return () => clearTimeout(t);
  }, [localCtx, isLocal, activeSession?.model, localModels, ovrWithCtx]);

  // "Apply & reload" from the composer's inline Advanced runtime editor:
  // persist the draft into the overrides blob, then restart the sidecar with
  // it (start_local_model records the fresh last-good ngl on success).
  const handleApplyLocalOverrides = useCallback(
    async (overrides: LlamaOverrides) => {
      if (!activeLocal) return;
      setLocalLoading(true);
      try {
        const next = { ...localOverridesMapRef.current, [activeLocal.id]: overrides };
        await setLocalModelOverrides(JSON.stringify(next));
        localOverridesMapRef.current = next;
        setLocalOverridesMap(next);
        await startLocalModel(activeLocal.id, activeLocal.path, activeLocal.mmprojPath, overrides);
        const status = await localModelStatus();
        setActiveLocalModelId(status?.modelId ?? null);
      } catch (err) {
        useChatStore.setState({
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setLocalLoading(false);
      }
    },
    [activeLocal],
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

  // Agent selection from the composer's agent chip. Persisted per session;
  // "builtin"/"local" keep today's provider behavior (the model menu's cloud
  // and local sections drive provider switches as before), a "harness:<id>"
  // pick only records the agent + unlocks the per-harness model catalog.
  const handleAgentChange = useCallback(
    (agent: string) => {
      if (activeChatSessionId) void setSessionAgent(activeChatSessionId, agent);
    },
    [activeChatSessionId, setSessionAgent],
  );

  // Permission posture: the approval card above the composer resolves the
  // session's pending tool approval (built-in loop + Claude Code harness
  // can_use_tool share the same card); the mode menu in the composer footer
  // persists per session. Switching into full_auto goes through the one-time
  // confirmation modal.
  const pendingApprovals = useChatStore((s) => s.pendingApprovals);
  const fullAutoConfirmingFor = useChatStore((s) => s.fullAutoConfirmingFor);
  const resolveApproval = useChatStore((s) => s.resolveApproval);
  const confirmFullAuto = useChatStore((s) => s.confirmFullAuto);
  const cancelFullAutoConfirm = useChatStore((s) => s.cancelFullAutoConfirm);
  const setSessionPermissionMode = useChatStore((s) => s.setSessionPermissionMode);
  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      if (activeChatSessionId) void setSessionPermissionMode(activeChatSessionId, mode);
    },
    [activeChatSessionId, setSessionPermissionMode],
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
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

    if (
      container.scrollTop < 120 &&
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
  // Uses an instant jump (no smooth animation) so rapid streaming updates
  // don't fight the user's own scrolling.
  useEffect(() => {
    if (stickToBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages, streaming]);

  // Switching sessions resets to the bottom of the new conversation.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [activeChatSessionId]);

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
  const items: Array<
    ChatMessage & {
      key: string;
      id?: number;
      live?: boolean;
      onDelete?: () => void;
      onEdit?: (newContent: string) => void;
      superseded?: boolean;
      segmentStart?: boolean;
    }
  > = useMemo(() => {
    const list: Array<
      ChatMessage & {
        key: string;
        id?: number;
        live?: boolean;
        onDelete?: () => void;
        onEdit?: (newContent: string) => void;
        superseded?: boolean;
        segmentStart?: boolean;
      }
    > = messages.map((m, i) => {
      const superseded = !!m.supersededBy;
      // A retired segment begins when a superseded row follows an active one
      // (chronological order). Renders the "— edited —" divider above it.
      const prev = messages[i - 1];
      const segmentStart = superseded && !prev?.supersededBy;
      return {
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
        attachments: m.attachments,
        // Assistant turns carry a worked-duration window; null/legacy rows omit it.
        durationSec:
          m.startedAt != null && m.completedAt != null
            ? m.completedAt - m.startedAt
            : undefined,
        key: `msg-${m.id}`,
        id: m.id,
        superseded,
        segmentStart,
        onDelete: () => handleDelete(m.id),
        onEdit: m.role === "user" ? (newContent) => handleSubmitEdit(m.id, newContent) : undefined,
      };
    });
    // If streaming, append the live assistant bubble (no action bar while live).
    if (isStreaming) {
      list.push({ role: "assistant", content: activeStream, key: "streaming", live: true });
    }
    return list;
  }, [messages, isStreaming, activeStream, handleDelete, handleSubmitEdit]);

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

  const hasItems = items.length > 0;
  // Regenerate applies to the most recent assistant message only.
  const lastAssistantKey = [...items]
    .reverse()
    .find((i) => i.role === "assistant" && !i.live)?.key;

  return (
    <div className="chat-view-wrap">
    <TurnNavigator />
    <div className={`chat-view${artifacts && artifacts.length > 0 ? " has-artifacts" : ""}`}>
      <GitToolsSidebar />
      {!activeChatSessionId || hasItems ? (
        <div className="chat-messages" ref={messagesContainerRef} onScroll={handleScroll}>
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
                  ref={virtualizer.measureElement}
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
                    />
                  </Suspense>
                </div>
              );
            })}
          </div>
          {waitingForFirstToken &&
            (statusNotice && statusNotice.message ? (
              <div className="chat-status-notice" role="status">
                <span className="local-spinner" aria-hidden="true" />
                <span>{statusNotice.message}</span>
              </div>
            ) : (
              <TypingIndicator />
            ))}
          {sessionTasks.length > 0 && (
            <div className="chat-tasks">
              {sessionTasks.map((t) => (
                <Suspense key={t.taskId} fallback={null}>
                  <TaskProgressCard task={t} />
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
        models={harnessAgent ? harnessModels.map((m) => m.id) : acpAgent ? [] : cloudIds}
        modelLabels={
          harnessAgent
            ? Object.fromEntries(harnessModels.map((m) => [m.id, m.label]))
            : undefined
        }
        modelEndpoint={harnessAgent ? (harnessCfg?.endpoint ?? null) : undefined}
        agent={activeChatSessionId ? (activeSession?.agent ?? null) : undefined}
        onAgentChange={handleAgentChange}
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
        localModels={localIds}
        effort={effort}
        provider={activeSession?.provider}
        modelLoading={localLoading}
        localCtx={localCtx}
        onModelChange={handleModelChange}
        onEffortChange={setEffort}
        onLocalCtxChange={setLocalCtx}
        onEjectLocalModel={ejectLocalModel}
        localModelActive={isLocal && !!activeLocalModelId}
        activeLocal={
          activeLocal
            ? { id: activeLocal.id, path: activeLocal.path, mmprojPath: activeLocal.mmprojPath }
            : null
        }
        localOverrides={activeLocal ? localOverridesMap[activeLocal.id] : undefined}
        onApplyLocalOverrides={handleApplyLocalOverrides}
        applyingOverrides={localLoading}
        usedTokens={usedTokens}
        liveMaxTokens={isLocal ? liveUsage.maxTokens : 0}
        thinking={thinking}
        onThinkingChange={setThinking}
        thinkingSupported={thinkingSupported}
      />
      {fullAutoConfirmingFor && (
        <FullAutoConfirmModal
          onConfirm={() => void confirmFullAuto(fullAutoConfirmingFor)}
          onCancel={cancelFullAutoConfirm}
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
  // Markdown heading with plan keywords
  /^#{1,3}\s*(?:Plan|Planning|Approach|Strategy|Steps|Implementation|Proposed Solution|Game Plan|Roadmap|To[- ]Do|Action Plan)/im,
  // Phrasal intros — model says "Here's my plan" or "Let me outline"
  /(?:^|\n\n)(?:Here(?:'s| is) (?:my |the |a |an )?(?:plan|approach|breakdown|strategy|outline|steps?))/im,
  /(?:^|\n\n)(?:Let me (?:(?:quickly )?(?:plan|outline|break(?:\s+down)?|sketch|lay out|map out|walk through)|explain (?:my |the )?(?:plan|approach|thinking)))/im,
  /(?:^|\n\n)(?:I(?:'ll| will) (?:plan|break|outline|do the following|take the following|proceed (?:as follows|in these steps)|tackle this (?:in |with )?steps?|start by))/im,
  /(?:^|\n\n)(?:My (?:plan|approach|strategy|recommendation|suggestion) (?:is|would be|:))/im,
  /(?:^|\n\n)(?:Here(?:'s| is) (?:how|what) I(?:'ll| will) (?:do|approach|proceed|tackle|handle|implement))/im,
  // Numbered plan marker
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
  const addTab = useUiStore((s) => s.addTab);
  const setToolPanelCollapsed = useUiStore((s) => s.setToolPanelCollapsed);

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
    // Strip the plan's own heading from the body so Canvas doesn't double-display
    const bodyWithoutHeader = plan.full.replace(/^#{1,3}\s+[^\n]+\n*/, "").trim();
    setPlanCanvas(bodyWithoutHeader || plan.full, plan.title);
    addTab("canvas");
    setToolPanelCollapsed(false);
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