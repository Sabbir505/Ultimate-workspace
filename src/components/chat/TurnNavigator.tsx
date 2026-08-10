// A thin vertical rail on the left edge of the chat view. Each conversation
// turn is a short horizontal tick mark growing out from the rail. Hovering a
// tick reveals a small floating tooltip showing the user message and the
// assistant response (both truncated). Clicking a tick smooth-scrolls the
// chat to that turn.
//
// The rail overlays the chat's left edge (position: absolute inside the chat
// view's relative wrapper), so it takes no layout space — it's just a visual
// timeline. When there are no turns (fresh chat), nothing renders.
import { useMemo, useState } from "react";
import { useChatStore } from "../../state/chat";
import { scrollToChatMessage } from "../../lib/chatScroll";

interface Turn {
  /** Numeric id of the user message — used as the scroll target. */
  userId: number;
  /** Truncated preview of the user's message text. */
  userPreview: string;
  /** Truncated preview of the assistant's response text. */
  assistantPreview: string;
  /** Whether an assistant response follows this user message. */
  hasResponse: boolean;
}

const PREVIEW_MAX = 120;

/** Strip markdown/code fences for a cleaner preview. */
function cleanPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "(code)")
    .replace(/`[^`]+`/g, "")
    .replace(/[#*_>~]/g, "")
    .replace(/\n+/g, " ")
    .trim()
    .slice(0, PREVIEW_MAX);
}

export function TurnNavigator() {
  const messages = useChatStore((s) => s.messages);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const turns: Turn[] = useMemo(() => {
    const result: Turn[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        result.push({
          userId: m.id,
          userPreview: cleanPreview(m.content),
          assistantPreview: "",
          hasResponse: false,
        });
      } else if (m.role === "assistant" && result.length > 0) {
        const last = result[result.length - 1];
        last.hasResponse = true;
        last.assistantPreview = cleanPreview(m.content);
      }
    }
    return result;
  }, [messages]);

  if (turns.length === 0) return null;
  // A single turn isn't worth the rail.
  if (turns.length < 2) return null;

  return (
    <div className="turn-rail" data-session={activeChatSessionId ?? "none"}>
      {turns.map((turn, i) => (
        <div
          key={turn.userId}
          className={`turn-rail-tick ${hoveredIdx === i ? "is-hovered" : ""}`}
          onClick={() => scrollToChatMessage(turn.userId)}
          onMouseEnter={() => setHoveredIdx(i)}
          onMouseLeave={() => setHoveredIdx(null)}
        >
          {/* The horizontal line (tick) grows from the rail. */}
          <span className="turn-rail-line" />
          {/* Floating tooltip on hover: user msg then assistant response. */}
          {hoveredIdx === i && (
            <div className="turn-rail-tooltip">
              <div className="turn-rail-tooltip-user">
                <span className="turn-rail-tooltip-label">You</span>
                <span className="turn-rail-tooltip-text">{turn.userPreview || "…"}</span>
              </div>
              {turn.hasResponse && (
                <div className="turn-rail-tooltip-assistant">
                  <span className="turn-rail-tooltip-label">Response</span>
                  <span className="turn-rail-tooltip-text">
                    {turn.assistantPreview || "…"}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
