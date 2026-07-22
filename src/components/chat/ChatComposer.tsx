// Chat composer, Claude-style: a single rounded card with the textarea on
// top and a footer row below — "+" attach button on the left, model/effort
// pill and a circular ↑ send button on the right.
// Enter sends; Shift+Enter inserts a newline.
// Attached text files are appended to the outgoing message as fenced blocks.
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelEffortMenu } from "./ModelEffortMenu";

function GlobeIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

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
  /** Prefill the textarea (e.g. editing a prior message). Bumping `nonce`
   *  re-applies `text` even if the text is unchanged. */
  draft?: { text: string; nonce: number };
  /** Model/effort selector state — selector is hidden when model is undefined. */
  model?: string;
  models?: string[];
  effort?: string;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
  /** Whether tool use (web search, …) is enabled for this chat. */
  toolsEnabled?: boolean;
  onToolsToggle?: (enabled: boolean) => void;
  /** Whether code execution (opt-in, security-sensitive) is enabled. */
  codeExecEnabled?: boolean;
  onCodeExecToggle?: (enabled: boolean) => void;
  /** Diagram mode override: "" = Auto (model decides), "quick" = Mermaid, "designed" = generate_diagram. */
  diagramMode?: "" | "quick" | "designed";
  onDiagramModeChange?: (mode: "" | "quick" | "designed") => void;
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
  toolsEnabled,
  onToolsToggle,
  codeExecEnabled,
  onCodeExecToggle,
  diagramMode,
  onDiagramModeChange,
}: Props) {
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
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
          {onToolsToggle && (
            <button
              type="button"
              className={`composer-tools-btn${toolsEnabled ? " active" : ""}`}
              title={
                toolsEnabled
                  ? "Web search enabled — click to disable"
                  : "Enable web search & tools"
              }
              aria-label="Toggle web search and tools"
              aria-pressed={toolsEnabled ? true : false}
              onClick={(e) => {
                e.currentTarget.blur();
                onToolsToggle(!toolsEnabled);
              }}
            >
              <GlobeIcon />
              <span>Search</span>
            </button>
          )}
          {onCodeExecToggle && (
            <button
              type="button"
              className={`composer-tools-btn${codeExecEnabled ? " active" : ""}`}
              title={
                codeExecEnabled
                  ? "Code execution enabled — runs code locally with a time limit. Click to disable."
                  : "Enable code execution (runs model-written code locally — use with care)"
              }
              aria-label="Toggle code execution"
              aria-pressed={codeExecEnabled ? true : false}
              onClick={(e) => {
                e.currentTarget.blur();
                onCodeExecToggle(!codeExecEnabled);
              }}
            >
              <CodeIcon />
              <span>Code</span>
            </button>
          )}
          {onDiagramModeChange && (
            <div
              className="composer-diagram-toggle"
              title="Diagram style: Auto (model decides), Quick (Mermaid inline), Designed (full HTML diagram, PNG-exportable)"
              role="radiogroup"
              aria-label="Diagram mode"
            >
              <button
                type="button"
                className={`diagram-toggle-seg${!diagramMode ? " active" : ""}`}
                aria-pressed={!diagramMode}
                onClick={(e) => {
                  e.currentTarget.blur();
                  onDiagramModeChange("");
                }}
              >
                Auto
              </button>
              <button
                type="button"
                className={`diagram-toggle-seg${diagramMode === "quick" ? " active" : ""}`}
                aria-pressed={diagramMode === "quick"}
                onClick={(e) => {
                  e.currentTarget.blur();
                  onDiagramModeChange("quick");
                }}
              >
                Quick
              </button>
              <button
                type="button"
                className={`diagram-toggle-seg${diagramMode === "designed" ? " active" : ""}`}
                aria-pressed={diagramMode === "designed"}
                onClick={(e) => {
                  e.currentTarget.blur();
                  onDiagramModeChange("designed");
                }}
              >
                Designed
              </button>
            </div>
          )}
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
