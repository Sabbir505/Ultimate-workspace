// A single chat message bubble. User messages right-aligned, assistant
// left-aligned. Renders markdown via react-markdown with syntax highlighting.
// Streaming token-by-token updates are debounced to ~50ms by the caller —
// this component simply accepts a `content: string` prop and renders it.
import { useCallback, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import type { ChatMessage } from "../../lib/ipc";

interface Props {
  message: ChatMessage;
  /** True for the in-progress streaming bubble — hides the action bar. */
  live?: boolean;
  /** When provided (user messages), shows an "Edit" action that loads the
   *  message text back into the composer. */
  onEdit?: (content: string) => void;
}

/** Per-message action bar (Claude-style): copy for every message, plus edit
 *  for user messages. Appears on hover under the bubble. */
function MessageActions({
  content,
  onEdit,
}: {
  content: string;
  onEdit?: (content: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable — silently ignore.
    }
  }, [content]);

  return (
    <div className="chat-msg-actions">
      <button
        className="chat-msg-action"
        onClick={copy}
        title="Copy message"
        aria-label="Copy message"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {onEdit && (
        <button
          className="chat-msg-action"
          onClick={() => onEdit(content)}
          title="Edit message"
          aria-label="Edit message"
        >
          Edit
        </button>
      )}
    </div>
  );
}

/** Splits a `<think>…</think>` reasoning block (streamed by reasoning
 *  models) off the front of the message. `done` is false while the closing
 *  tag hasn't arrived yet (still thinking). */
function splitThinking(content: string): {
  thinking: string | null;
  done: boolean;
  rest: string;
} {
  const match = /^\s*<think>([\s\S]*?)(?:<\/think>|$)/.exec(content);
  if (!match) return { thinking: null, done: true, rest: content };
  const done = match[0].includes("</think>");
  return {
    thinking: match[1].trim(),
    done,
    rest: content.slice(match[0].length).trim(),
  };
}

function ThinkingBlock({ thinking, done }: { thinking: string; done: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`chat-thinking${done ? "" : " live"}`}>
      <button
        className="chat-thinking-toggle"
        onClick={() => setOpen((o) => !o)}
        title={open ? "Hide thinking" : "Show thinking"}
      >
        <span className="chat-thinking-icon">✵</span>
        {done ? "Thought process" : "Thinking…"}
        <span className={`chat-thinking-chevron${open ? " open" : ""}`}>›</span>
      </button>
      {open && <div className="chat-thinking-body">{thinking}</div>}
    </div>
  );
}

/** Returns a style object for inline code elements using CSS variable lookups
 *  that work in both light and dark themes (the variables resolve at runtime). */
function useInlineCodeStyle() {
  return useMemo(
    () => ({
      background: "var(--surface-2)",
      padding: "2px 6px",
      borderRadius: "var(--radius-xs)",
      fontFamily: "var(--font-mono)",
      fontSize: "0.9em",
      boxShadow: "var(--glass-rim-soft)",
    }),
    [],
  );
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable — silently ignore.
    }
  }, [code]);

  return (
    <button className="ghost copy-code-btn" onClick={handleCopy}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function MessageBubble({ message, live, onEdit }: Props) {
  const isUser = message.role === "user";
  const inlineCodeStyle = useInlineCodeStyle();
  const { thinking, done, rest } = isUser
    ? { thinking: null, done: true, rest: message.content }
    : splitThinking(message.content);

  return (
    <div className={`chat-bubble${isUser ? " user" : " assistant"}`}>
      <div className="chat-bubble-inner">
        {thinking !== null && thinking.length > 0 && (
          <ThinkingBlock thinking={thinking} done={done} />
        )}
        <ReactMarkdown
          components={{
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || "");
              const codeString = String(children).replace(/\n$/, "");

              // Inline code: no language class and short.
              if (!match && !String(children).includes("\n")) {
                return (
                  <code style={inlineCodeStyle} {...props}>
                    {children}
                  </code>
                );
              }

              // Code block with language.
              return (
                <div className="chat-code-block">
                  <div className="chat-code-header">
                    <span className="chat-code-lang">
                      {match ? match[1] : "text"}
                    </span>
                    <CopyButton code={codeString} />
                  </div>
                  <SyntaxHighlighter
                    style={{}}
                    language={match ? match[1] : "text"}
                    PreTag="div"
                    customStyle={{
                      margin: 0,
                      background: "transparent",
                      padding: "12px 16px",
                      fontSize: "12px",
                      fontFamily: "var(--font-mono)",
                      lineHeight: 1.5,
                      overflowX: "auto",
                    }}
                    codeTagProps={{
                      style: {
                        fontFamily: "var(--font-mono)",
                      },
                    }}
                  >
                    {codeString}
                  </SyntaxHighlighter>
                </div>
              );
            },
            // Render links with target=_blank and glass-appropriate styling.
            a({ href, children }) {
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--accent)" }}
                >
                  {children}
                </a>
              );
            },
          }}
        >
          {rest}
        </ReactMarkdown>
      </div>
      {!live && <MessageActions content={message.content} onEdit={onEdit} />}
    </div>
  );
}