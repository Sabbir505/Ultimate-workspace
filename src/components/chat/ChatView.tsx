// ChatView: full main-area chat interface shown when activeView === "chat".
// Flex column layout: scrollable message list + bottom composer.
// Shows an empty state when no chat session is selected.
// Live streaming: accumulates tokens into an assistant bubble that updates
// as they arrive, then swaps to the final persisted message on chat:done.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatStore, type PermissionMode } from "../../state/chat";
import { ChatComposer, type ChatAttachment } from "./ChatComposer";
import { MessageBubble, TypingIndicator } from "./MessageBubble";
import { ArtifactPreviewPane } from "./ArtifactPreviewPane";
import { ApprovalCard, FullAutoConfirmModal } from "./ApprovalFlow";
import { listChatModels, scanLocalModels, startLocalModel, type ChatMessage, type GgufModel } from "../../lib/ipc";

/** Format a backend error message for display. Strips raw JSON blobs,
 *  extracts the human-readable message, and keeps it to one line. */
function formatChatError(raw: string): string {
  // If the error looks like JSON, try to extract a readable message.
  if (raw.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const msg =
        parsed.message ||
        parsed.error?.message ||
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

export function ChatView() {
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const streamingChatSessionId = useChatStore((s) => s.streamingChatSessionId);
  const chatStatus = useChatStore((s) => s.chatStatus);
  const error = useChatStore((s) => s.error);
  const loaded = useChatStore((s) => s.loaded);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const regenerate = useChatStore((s) => s.regenerate);
  const cancelStream = useChatStore((s) => s.cancelStream);
  const previewArtifact = useChatStore((s) => s.previewArtifact);
  const setPreviewArtifact = useChatStore((s) => s.setPreviewArtifact);
  const sessions = useChatStore((s) => s.sessions);
  const setSessionModel = useChatStore((s) => s.setSessionModel);
  const setSessionProvider = useChatStore((s) => s.setSessionProvider);
  const setSessionPermissionMode = useChatStore((s) => s.setSessionPermissionMode);
  const confirmFullAuto = useChatStore((s) => s.confirmFullAuto);
  const cancelFullAutoConfirm = useChatStore((s) => s.cancelFullAutoConfirm);
  const fullAutoConfirmingFor = useChatStore((s) => s.fullAutoConfirmingFor);
  const pendingApprovals = useChatStore((s) => s.pendingApprovals);
  const resolveApproval = useChatStore((s) => s.resolveApproval);
  const effort = useChatStore((s) => s.effort);
  const setEffort = useChatStore((s) => s.setEffort);
  const localCtx = useChatStore((s) => s.localCtx);
  const setLocalCtx = useChatStore((s) => s.setLocalCtx);
  const config = useChatStore((s) => s.config);
  const loadConfig = useChatStore((s) => s.loadConfig);
  const newChat = useChatStore((s) => s.newChat);
  const artifacts = useChatStore((s) =>
    activeChatSessionId ? s.artifacts[activeChatSessionId] : undefined,
  );
  const artifactsByMessage = useChatStore((s) => s.artifactsByMessage);

  const activeSession = sessions.find((s) => s.id === activeChatSessionId) ?? null;
  const isLocal = activeSession?.provider === "local_gguf";
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

  // Context meter "used" figure: the input_tokens of the most recent assistant
  // turn. That value is the full prompt size the provider counted (system +
  // all history + current message + tool results), so it represents how much of
  // the context window the conversation is actually consuming. Null until the
  // first turn completes (the optimistic assistant bubble has no usage yet).
  const lastInputTokens = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.inputTokens != null && m.inputTokens > 0) {
        return m.inputTokens;
      }
    }
    return null;
  }, [messages]);

  const handleModelChange = useCallback(
    async (model: string) => {
      if (!activeChatSessionId) return;
      const localMatch = localModels.find((m) => (m.name || m.filename) === model);
      if (localMatch) {
        // Local model picked (in ANY session): spawn/swap the sidecar first
        // (start_local_model stops any existing one), then point the session
        // at the local provider so subsequent sends hit its endpoint.
        setLocalLoading(true);
        try {
          await startLocalModel(localMatch.id, localMatch.path, undefined, localCtx || undefined, localMatch.mmprojPath);
        } catch (err) {
          console.warn("start local model failed", err);
          setLocalLoading(false);
          return;
        }
        setLocalLoading(false);
        // start_local_model persists chat.local_gguf.model + chat.active_provider
        // in settings. Reload config so chatConfig reflects the running model —
        // "New Chat" seeds the new session from chatConfig.model, and without
        // this refresh the selector on a fresh chat would look empty (as if the
        // local model had been ejected).
        void loadConfig("local_gguf");
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
    [activeChatSessionId, setSessionModel, setSessionProvider, isLocal, localModels, localCtx, config?.provider],
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
      startLocalModel(match.id, match.path, undefined, localCtx || undefined, match.mmprojPath)
        .catch((err) => console.warn("restart local model with new ctx failed", err))
        .finally(() => setLocalLoading(false));
    }, 800);
    return () => clearTimeout(t);
  }, [localCtx, isLocal, activeSession?.model, localModels]);

  // Switching permission mode. The store intercepts a switch INTO full_auto and
  // opens the one-time confirmation modal instead of applying it directly.
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

  // Load the saved provider config (used for auto-starting a session).
  useEffect(() => {
    if (!config) void loadConfig();
  }, [config, loadConfig]);

  // Entering chat with no session selected auto-starts a fresh one, so the
  // user can type immediately without picking/creating a chat first.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!loaded || !config || activeChatSessionId || autoStarted.current) return;
    autoStarted.current = true;
    const provider = config.provider ?? "openai_compatible";
    // Seed the new session with the provider's persisted default model
    // (chat.<provider>.model) so the model selector stays populated instead of
    // snapping to empty — which previously made it look like the selected
    // model (including a running local sidecar) had been ejected. Falls back
    // to "" only when no default model is configured for the provider, in
    // which case the user must still pick one before sending.
    void newChat(provider, config.model ?? "");
  }, [loaded, activeChatSessionId, config, newChat]);

  // Track whether the user is pinned near the bottom. Runs on every scroll
  // (user- or programmatic). Once they scroll up past the threshold, auto
  // follow is paused until they return to the bottom.
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const threshold = 80; // px from bottom to still count as "at bottom"
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distanceFromBottom < threshold;
  }, []);

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

  // Build the list of items to render: persisted messages, plus a live
  // streaming bubble for the active session if tokens are arriving.
  const activeStream = activeChatSessionId ? (streaming[activeChatSessionId] ?? "") : "";
  const isStreaming = streamingChatSessionId === activeChatSessionId && activeStream.length > 0;
  // The request is in flight but no content has streamed yet: show the
  // Claude-style "thinking" animation so the user knows something is happening.
  const waitingForFirstToken =
    streamingChatSessionId === activeChatSessionId &&
    streamingChatSessionId !== null &&
    activeStream.length === 0;
  // A pre-token status notice (chat:status) explains *why* it's waiting — e.g.
  // a local model is cold-starting after an app restart. When present, render
  // its message next to a spinner instead of the generic thinking dots.
  const statusNotice = activeChatSessionId ? chatStatus[activeChatSessionId] : undefined;

  const handleSend = useCallback(
    (content: string, attachments: ChatAttachment[], forceResearch?: boolean) => {
      // Sending always pins to the bottom so the reply is visible.
      stickToBottomRef.current = true;
      void sendMessage(content, attachments, forceResearch);
    },
    [sendMessage],
  );

  // Load a previous user message back into the composer for editing/resend.
  const handleEdit = useCallback((content: string) => {
    setDraft({ text: content, nonce: Date.now() });
  }, []);

  const handleStop = useCallback(() => {
    void cancelStream();
  }, [cancelStream]);

  const handleRepeat = useCallback(() => {
    stickToBottomRef.current = true;
    void regenerate();
  }, [regenerate]);

  // Convert persisted messages for the bubble component.
  // MessageBubble expects { role, content } (its own ChatMessage type), so we
  // map ChatMessageRecord to that shape.
  const items: Array<ChatMessage & { key: string; id?: number; live?: boolean }> = messages.map(
    (m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
      attachments: m.attachments,
      key: `msg-${m.id}`,
      id: m.id,
    }),
  );

  // If streaming, append the live assistant bubble (no action bar while live).
  if (isStreaming) {
    items.push({ role: "assistant", content: activeStream, key: "streaming", live: true });
  }

  const hasItems = items.length > 0;
  // Regenerate applies to the most recent assistant message only.
  const lastAssistantKey = [...items]
    .reverse()
    .find((i) => i.role === "assistant" && !i.live)?.key;

  return (
    <div className={`chat-view-wrap${previewArtifact ? " has-preview" : ""}`}>
    <div className={`chat-view${artifacts && artifacts.length > 0 ? " has-artifacts" : ""}`}>
      {!activeChatSessionId || hasItems ? (
        <div className="chat-messages" ref={messagesContainerRef} onScroll={handleScroll}>
          {items.map((item) => (
            <MessageBubble
              key={item.key}
              message={{ role: item.role as "user" | "assistant" | "system", content: item.content }}
              live={item.live}
              onEdit={item.role === "user" ? handleEdit : undefined}
              onRepeat={
                item.role === "assistant" && item.key === lastAssistantKey
                  ? handleRepeat
                  : undefined
              }
              artifacts={item.id != null ? artifactsByMessage[item.id] : undefined}
              onPreviewArtifact={setPreviewArtifact}
            />
          ))}
          {waitingForFirstToken &&
            (statusNotice && statusNotice.message ? (
              <div className="chat-status-notice" role="status">
                <span className="local-spinner" aria-hidden="true" />
                <span>{statusNotice.message}</span>
              </div>
            ) : (
              <TypingIndicator />
            ))}
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
        streaming={streamingChatSessionId === activeChatSessionId && streamingChatSessionId !== null}
        disabled={false}
        model={activeChatSessionId ? (resolvedModel ?? "") : undefined}
        models={cloudIds}
        localModels={localIds}
        effort={effort}
        provider={activeSession?.provider}
        modelLoading={localLoading}
        localCtx={localCtx}
        onModelChange={handleModelChange}
        onEffortChange={setEffort}
        onLocalCtxChange={setLocalCtx}
        permissionMode={
          activeChatSessionId
            ? ((activeSession?.permissionMode as PermissionMode) ?? "manual")
            : undefined
        }
        onPermissionModeChange={handlePermissionModeChange}
        chatSessionId={activeChatSessionId ?? undefined}
        usedTokens={lastInputTokens}
      />
    </div>
    {previewArtifact && (
      <ArtifactPreviewPane
        artifact={previewArtifact}
        onClose={() => setPreviewArtifact(null)}
      />
    )}
    {fullAutoConfirmingFor && (
      <FullAutoConfirmModal
        onConfirm={() => void confirmFullAuto(fullAutoConfirmingFor)}
        onCancel={cancelFullAutoConfirm}
      />
    )}
    </div>
  );
}