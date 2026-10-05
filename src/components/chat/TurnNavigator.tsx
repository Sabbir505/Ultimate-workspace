// A thin vertical rail on the left edge of the chat view. Each conversation
// turn is a short horizontal tick mark growing out from the rail. Hovering a
// tick reveals a small floating tooltip showing the user message and the
// assistant response (both truncated). Clicking a tick smooth-scrolls the
// chat to that turn.
//
// The rail overlays the chat's left edge (position: absolute inside the chat
// view's relative wrapper), so it takes no layout space — it's just a visual
// timeline. When there are no turns (fresh chat), nothing renders.
//
// Long-lived chats (automation run logs grow one turn per run) outgrow the
// screen: the rail is a FIXED-HEIGHT window (a little under the full screen)
// that scrolls internally, pinned to the newest turns. The hover tooltip is
// portaled to document.body so the rail's scroll overflow can't clip it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
// Bound the input before the (backtracking-heavy) fence regexes run: the
// output is truncated to PREVIEW_MAX anyway, and slicing first keeps this
// off the full multi-KB message body on every token flush. 600 ≫ 120, so
// the visible preview is unchanged for realistic content.
const PREVIEW_INPUT_MAX = 600;

/** Strip markdown/code fences for a cleaner preview. */
function cleanPreview(text: string): string {
  const bounded = text.length > PREVIEW_INPUT_MAX ? text.slice(0, PREVIEW_INPUT_MAX) : text;
  return bounded
    .replace(/```[\s\S]*?```/g, "(code)")
    .replace(/`[^`]+`/g, "")
    .replace(/[#*_>~]/g, "")
    .replace(/\n+/g, " ")
    .trim()
    .slice(0, PREVIEW_MAX);
}

export function TurnNavigator({
  sessionId,
  paneId,
}: {
  /** The session THIS ChatView instance renders — pane-scoped, so the rail
   *  always describes the chat beside which it floats. */
  sessionId: string | null;
  /** Set when this view is a pinned split pane: read THAT pane's buffer,
   *  not the global main list (which belongs to the active session). */
  paneId?: string;
}) {
  const storeMessages = useChatStore((s) => s.messages);
  const paneBuf = useChatStore((s) => (paneId ? s.paneBuffers[paneId] : undefined));
  const messages = paneBuf ? paneBuf.messages : storeMessages;
  const activeChatSessionId = sessionId;
  // Split view: dispatch the jump to the FOCUSED half's view — the registry
  // is keyed by session id, and each view registers under its own.
  const [hovered, setHovered] = useState<
    { idx: number; anchorTop: number; anchorLeft: number } | null
  >(null);
  // Tooltip vertical position, clamped against the viewport after the
  // portaled tooltip has rendered and can be measured (hidden until then).
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipTop, setTooltipTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!hovered) {
      setTooltipTop(null);
      return;
    }
    const el = tooltipRef.current;
    if (!el) return;
    const half = el.offsetHeight / 2;
    const margin = 8;
    setTooltipTop(
      Math.min(
        Math.max(hovered.anchorTop, half + margin),
        window.innerHeight - half - margin,
      ),
    );
  }, [hovered]);

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

  // Pin the rail's own scroll window to the NEWEST turns (they render at the
  // bottom, oldest-first like the transcript): on mount and whenever a turn
  // lands, the visible ticks are the recent ones — an automation chat whose
  // rail holds 200+ turns opens showing its latest run, not its first.
  const railRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = railRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, activeChatSessionId]);

  if (turns.length === 0) return null;
  // A single turn isn't worth the rail.
  if (turns.length < 2) return null;

  return (
    <div className="turn-rail" ref={railRef} data-session={activeChatSessionId ?? "none"}>
      {turns.map((turn, i) => (
        <div
          key={turn.userId}
          className={`turn-rail-tick ${hovered?.idx === i ? "is-hovered" : ""}`}
          onClick={() => scrollToChatMessage(turn.userId, activeChatSessionId)}
          onMouseEnter={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHovered({ idx: i, anchorTop: r.top + r.height / 2, anchorLeft: r.right + 8 });
          }}
          onMouseLeave={() => setHovered(null)}
        >
          {/* The horizontal line (tick) grows from the rail. */}
          <span className="turn-rail-line" />
        </div>
      ))}
      {/* Floating tooltip on hover: user msg then assistant response. Portaled
          so the rail's overflow (the fixed-height scroll window) can't clip
          it; clamped vertically so it stays on screen near the first/last
          tick of a scrolled rail. */}
      {hovered &&
        turns[hovered.idx] &&
        createPortal(
          <div
            ref={tooltipRef}
            className="turn-rail-tooltip"
            style={{
              left: hovered.anchorLeft,
              top: tooltipTop ?? hovered.anchorTop,
              visibility: tooltipTop == null ? "hidden" : undefined,
            }}
          >
            <div className="turn-rail-tooltip-user">
              <span className="turn-rail-tooltip-label">You</span>
              <span className="turn-rail-tooltip-text">
                {turns[hovered.idx].userPreview || "…"}
              </span>
            </div>
            {turns[hovered.idx].hasResponse && (
              <div className="turn-rail-tooltip-assistant">
                <span className="turn-rail-tooltip-label">Response</span>
                <span className="turn-rail-tooltip-text">
                  {turns[hovered.idx].assistantPreview || "…"}
                </span>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
