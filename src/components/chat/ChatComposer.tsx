// Chat composer: auto-growing textarea, Send/Stop button.
// Enter sends; Shift+Enter inserts a newline. Disabled while empty or streaming.
// A model + effort selector pill sits under the textarea when provided.
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelEffortMenu } from "./ModelEffortMenu";

interface Props {
  onSend: (content: string) => void;
  onStop?: () => void;
  streaming: boolean;
  disabled?: boolean;
  /** Model/effort selector state — selector is hidden when model is undefined. */
  model?: string;
  models?: string[];
  effort?: string;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
}

export function ChatComposer({
  onSend,
  onStop,
  streaming,
  disabled,
  model,
  models,
  effort,
  onModelChange,
  onEffortChange,
}: Props) {
  const [content, setContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea as the user types.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [content]);

  const handleSend = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setContent("");
    // Reset textarea height.
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
    }
  }, [content, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!disabled && !streaming && content.trim()) {
          handleSend();
        }
      }
    },
    [content, disabled, streaming, handleSend],
  );

  const isEmpty = !content.trim();

  const showSelector = model !== undefined && onModelChange && onEffortChange;

  return (
    <div className="chat-composer">
      <div className="chat-composer-input-row">
        <textarea
          ref={textareaRef}
          className="chat-composer-textarea"
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
        />
        {streaming ? (
          <button
            className="chat-send-btn"
            onClick={onStop}
            title="Stop generating"
          >
            ■ Stop
          </button>
        ) : (
          <button
            className="chat-send-btn primary"
            onClick={handleSend}
            disabled={isEmpty || disabled}
            title="Send message"
          >
            Send
          </button>
        )}
      </div>
      {showSelector && (
        <div className="chat-composer-controls">
          <ModelEffortMenu
            model={model}
            models={models ?? []}
            effort={effort ?? ""}
            onModelChange={onModelChange}
            onEffortChange={onEffortChange}
          />
        </div>
      )}
    </div>
  );
}