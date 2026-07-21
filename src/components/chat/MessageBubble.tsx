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

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";
  const inlineCodeStyle = useInlineCodeStyle();

  return (
    <div className={`chat-bubble${isUser ? " user" : " assistant"}`}>
      <div className="chat-bubble-inner">
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
          {message.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}