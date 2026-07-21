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

  // Load sessions on mount if not already loaded.
  useEffect(() => {
    if (!loaded) {
      void loadSessions();
    }
  }, [loaded, loadSessions]);

  // Smart auto-scroll: only scroll if the user is already near the bottom.
  // If they've scrolled up to read history, don't yank the scroll.
  const scrollToBottomIfNear = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const threshold = 120; // px from bottom to consider "near"
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < threshold) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  // Scroll on new messages or streaming tokens.
  useEffect(() => {
    scrollToBottomIfNear();
  }, [messages, streaming, scrollToBottomIfNear]);

  // Build the list of items to render: persisted messages, plus a live
  // streaming bubble for the active session if tokens are arriving.
  const activeStream = activeChatSessionId ? (streaming[activeChatSessionId] ?? "") : "";
  const isStreaming = streamingChatSessionId === activeChatSessionId && activeStream.length > 0;

  const handleSend = useCallback(
    (content: string) => {
      void sendMessage(content);
    },
    [sendMessage],
  );

  const handleStop = useCallback(() => {
    void cancelStream();
  }, [cancelStream]);

  // Convert persisted messages for the bubble component.
  // MessageBubble expects { role, content } (its own ChatMessage type), so we
  // map ChatMessageRecord to that shape.
  const items: Array<ChatMessage & { key: string }> = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
    key: `msg-${m.id}`,
  }));

  // If streaming, append the live assistant bubble.
  if (isStreaming) {
    items.push({ role: "assistant", content: activeStream, key: "streaming" });
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
        <div className="chat-messages" ref={messagesContainerRef}>
          {items.map((item) => (
            <MessageBubble key={item.key} message={{ role: item.role as "user" | "assistant", content: item.content }} />
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
        onSend={handleSend}
        onStop={handleStop}
        streaming={streamingChatSessionId === activeChatSessionId && streamingChatSessionId !== null}
        disabled={false}
        model={activeChatSessionId ? (activeSession?.model ?? "") : undefined}
        models={modelIds}
        effort={effort}
        onModelChange={handleModelChange}
        onEffortChange={setEffort}
      />
    </div>
  );
}