// ChatView: full main-area chat interface shown when activeView === "chat".
// Flex column layout: scrollable message list + bottom composer.
// Shows an empty state when no chat session is selected.
// Live streaming: accumulates tokens into an assistant bubble that updates
// as they arrive, then swaps to the final persisted message on chat:done.
import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "../../state/chat";
import { ChatComposer } from "./ChatComposer";
import { MessageBubble } from "./MessageBubble";
import { listChatModels, type ChatMessage } from "../../lib/ipc";

export function ChatView() {
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const streamingChatSessionId = useChatStore((s) => s.streamingChatSessionId);
  const error = useChatStore((s) => s.error);
  const loaded = useChatStore((s) => s.loaded);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const cancelStream = useChatStore((s) => s.cancelStream);
  const sessions = useChatStore((s) => s.sessions);
  const setSessionModel = useChatStore((s) => s.setSessionModel);
  const effort = useChatStore((s) => s.effort);
  const setEffort = useChatStore((s) => s.setEffort);
  const toolsEnabled = useChatStore((s) => s.toolsEnabled);
  const setToolsEnabled = useChatStore((s) => s.setToolsEnabled);
  const config = useChatStore((s) => s.config);
  const loadConfig = useChatStore((s) => s.loadConfig);
  const newChat = useChatStore((s) => s.newChat);

  const activeSession = sessions.find((s) => s.id === activeChatSessionId) ?? null;
  const isCompatible =
    activeSession?.provider === "anthropic_compatible" ||
    activeSession?.provider === "openai_compatible";
  const [models, setModels] = useState<string[]>([]);

  // Fetch the model list for compatible providers (uses the stored key and
  // base URL from Settings). Refetched when the session's provider changes.
  useEffect(() => {
    setModels([]);
    if (!activeSession || !isCompatible) return;
    let stale = false;
    void listChatModels(activeSession.provider).then((list) => {
      if (!stale && list) setModels(list.map((m) => m.id));
    });
    return () => {
      stale = true;
    };
  }, [activeSession?.provider, isCompatible, activeChatSessionId]);

  const modelIds = (() => {
    const ids = [...models];
    if (activeSession?.model && !ids.includes(activeSession.model)) {
      ids.unshift(activeSession.model);
    }
    return ids;
  })();

  const handleModelChange = useCallback(
    (model: string) => {
      if (activeChatSessionId) void setSessionModel(activeChatSessionId, model);
    },
    [activeChatSessionId, setSessionModel],
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

  const handleSend = useCallback(
    (content: string) => {
      // Sending always pins to the bottom so the reply is visible.
      stickToBottomRef.current = true;
      void sendMessage(content);
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

  // Convert persisted messages for the bubble component.
  // MessageBubble expects { role, content } (its own ChatMessage type), so we
  // map ChatMessageRecord to that shape.
  const items: Array<ChatMessage & { key: string; live?: boolean }> = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
    key: `msg-${m.id}`,
  }));

  // If streaming, append the live assistant bubble (no action bar while live).
  if (isStreaming) {
    items.push({ role: "assistant", content: activeStream, key: "streaming", live: true });
  }

  const hasItems = items.length > 0;

  return (
    <div className="chat-view">
      {!activeChatSessionId && !hasItems ? (
        <div className="chat-empty">
          <div className="empty-reserved">
            <span className="empty-icon">💬</span>
            <span className="empty-text">
              Start a conversation — select a chat from the sidebar or type a message below.
            </span>
          </div>
        </div>
      ) : (
        <div className="chat-messages" ref={messagesContainerRef} onScroll={handleScroll}>
          {items.map((item) => (
            <MessageBubble
              key={item.key}
              message={{ role: item.role as "user" | "assistant", content: item.content }}
              live={item.live}
              onEdit={item.role === "user" ? handleEdit : undefined}
            />
          ))}
          {error && (
            <div className="chat-error">
              <span className="chat-error-icon">⚠</span>
              <span>{error}</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      <ChatComposer
        draft={draft}
        onSend={handleSend}
        onStop={handleStop}
        streaming={streamingChatSessionId === activeChatSessionId && streamingChatSessionId !== null}
        disabled={false}
        model={activeChatSessionId ? (activeSession?.model ?? "") : undefined}
        models={modelIds}
        effort={effort}
        onModelChange={handleModelChange}
        onEffortChange={setEffort}
        toolsEnabled={toolsEnabled}
        onToolsToggle={setToolsEnabled}
      />
    </div>
  );
}