// Chat composer, Claude-style: a single rounded card with the textarea on
// top and a footer row below — "+" attach button on the left, model/effort
// pill and a circular ↑ send button on the right.
// Enter sends; Shift+Enter inserts a newline.
// Attachments: images are sent as vision input, docx/pptx/xlsx/pdf are extracted
// to text server-side, and plain-text files are inlined into the message.
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelEffortMenu } from "./ModelEffortMenu";

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOC_BYTES = 10 * 1024 * 1024;

// Attachment kinds map to the backend `ChatAttachmentInput`: images go to the
// model as vision input, docs are text-extracted server-side, text is inlined.
export interface ChatAttachment {
  name: string;
  kind: "text" | "image" | "doc";
  /** Decoded text for `kind === "text"`. */
  text?: string;
  /** Base64 bytes (no data: prefix) for images and docs. */
  data?: string;
  /** MIME type for images, e.g. "image/png". */
  mediaType?: string;
  /** File extension for docs: "docx" | "pptx" | "xlsx" | "pdf". */
  format?: string;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];
const DOC_EXTS = ["docx", "pptx", "xlsx", "pdf"];

/** Read a File's bytes as base64 (without the `data:...;base64,` prefix). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = typeof reader.result === "string" ? reader.result : "";
      resolve(res.slice(res.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface Props {
  onSend: (content: string, attachments: ChatAttachment[]) => void;
  onStop?: () => void;
  streaming: boolean;
  disabled?: boolean;
  /** Prefill the textarea (e.g. editing a prior message). Bumping `nonce`
   *  re-applies `text` even if the text is unchanged. */
  draft?: { text: string; nonce: number };
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
  draft,
  model,
  models,
  effort,
  onModelChange,
  onEffortChange,
}: Props) {
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Prefill from an external draft (per-message Edit action). Focuses and
  // moves the caret to the end so the user can immediately tweak and resend.
  useEffect(() => {
    if (!draft || draft.nonce === 0) return;
    setContent(draft.text);
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      const end = draft.text.length;
      requestAnimationFrame(() => ta.setSelectionRange(end, end));
    }
  }, [draft?.nonce]);

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
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const isImage =
        IMAGE_EXTS.includes(ext) ||
        (file.type.startsWith("image/") && file.type !== "image/svg+xml");
      const isDoc = DOC_EXTS.includes(ext);
      const limit = isImage ? MAX_IMAGE_BYTES : isDoc ? MAX_DOC_BYTES : MAX_TEXT_BYTES;
      if (file.size > limit) {
        setAttachError(`${file.name} is too large (max ${Math.round(limit / 1024 / 1024)} MB)`);
        continue;
      }
      try {
        let attachment: ChatAttachment;
        if (isImage) {
          attachment = {
            name: file.name,
            kind: "image",
            data: await readAsBase64(file),
            mediaType: file.type || `image/${ext === "jpg" ? "jpeg" : ext}`,
          };
        } else if (isDoc) {
          attachment = {
            name: file.name,
            kind: "doc",
            data: await readAsBase64(file),
            format: ext,
          };
        } else {
          attachment = { name: file.name, kind: "text", text: await file.text() };
        }
        setAttachments((prev) =>
          prev.some((a) => a.name === file.name) ? prev : [...prev, attachment],
        );
      } catch {
        setAttachError(`Could not read ${file.name}`);
      }
    }
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed && attachments.length === 0) return;
    onSend(trimmed, attachments);
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
