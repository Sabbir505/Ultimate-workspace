// Chat composer, Claude-style: a single rounded card with the textarea on
// top and a footer row below — "+" attach button on the left, model/effort
// pill and a circular ↑ send button on the right.
// Enter sends; Shift+Enter inserts a newline.
// Attached text files are appended to the outgoing message as fenced blocks.
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelEffortMenu } from "./ModelEffortMenu";

const MAX_ATTACHMENT_BYTES = 256 * 1024;

interface Attachment {
  name: string;
  content: string;
}

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-grow the textarea as the user types.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [content]);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    setAttachError(null);
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachError(`${file.name} is too large (max 256 KB)`);
        continue;
      }
      try {
        const text = await file.text();
        setAttachments((prev) =>
          prev.some((a) => a.name === file.name)
            ? prev
            : [...prev, { name: file.name, content: text }],
        );
      } catch {
        setAttachError(`Could not read ${file.name} as text`);
      }
    }
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed && attachments.length === 0) return;
    let message = trimmed;
    for (const a of attachments) {
      message += `\n\nAttached file: ${a.name}\n\`\`\`\n${a.content}\n\`\`\``;
    }
    onSend(message.trim());
    setContent("");
    setAttachments([]);
    setAttachError(null);
    // Reset textarea height.
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
    }
  }, [content, attachments, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!disabled && !streaming) {
          handleSend();
        }
      }
    },
    [disabled, streaming, handleSend],
  );

  const isEmpty = !content.trim() && attachments.length === 0;
  const showSelector = model !== undefined && onModelChange && onEffortChange;

  return (
    <div className="chat-composer">
      <div className="chat-composer-card">
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((a) => (
              <span key={a.name} className="composer-attachment-chip">
                {a.name}
                <button
                  type="button"
                  className="composer-attachment-remove"
                  title="Remove attachment"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((p) => p.name !== a.name))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="chat-composer-textarea"
          placeholder="Write a message…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
        />
        <div className="chat-composer-footer">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="composer-attach-btn"
            title="Attach files"
            aria-label="Attach files"
            onClick={() => fileInputRef.current?.click()}
          >
            +
          </button>
          {attachError && <span className="composer-attach-error">{attachError}</span>}
          <div className="composer-footer-spacer" />
          {showSelector && (
            <ModelEffortMenu
              model={model}
              models={models ?? []}
              effort={effort ?? ""}
              onModelChange={onModelChange}
              onEffortChange={onEffortChange}
            />
          )}
          {streaming ? (
            <button
              className="composer-send-btn stop"
              onClick={onStop}
              title="Stop generating"
              aria-label="Stop generating"
            >
              ■
            </button>
          ) : (
            <button
              className="composer-send-btn"
              onClick={handleSend}
              disabled={isEmpty || disabled}
              title="Send message"
              aria-label="Send message"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
