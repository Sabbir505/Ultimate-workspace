// TypingIndicator: the 3-line "assistant is responding" spinner shown while
// the first token is still in flight. Lives in its own module so ChatView
// can render it WITHOUT statically importing MessageBubble — that import
// used to drag react-markdown + katex into the entry chunk
// (PERFORMANCE_AUDIT.md item 12).

export function TypingIndicator() {
  return (
    <div className="chat-bubble assistant">
      <div className="chat-bubble-inner">
        <div className="chat-typing" aria-label="Assistant is responding" role="status">
          <span className="chat-typing-prompt">›</span>
          <span className="chat-typing-cursor" />
        </div>
      </div>
    </div>
  );
}
