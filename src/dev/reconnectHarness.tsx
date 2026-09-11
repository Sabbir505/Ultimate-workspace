// Dev-only visual harness for the reconnect line (chat/reconnect.rs): the
// real MessageBubble + the real CSS cascade, no Tauri backend, so the states
// a dropped connection passes through can be seen in a real engine.
// Serve `npx vite`, open http://localhost:1500/reconnect-harness.html.
//
// Three states, top to bottom:
// 1. MID-ANSWER — the stall case the line exists for: the turn already has
//    text on screen and the ladder re-dials under it. The line renders in the
//    slot the hover action bar occupies once the turn ends.
// 2. PRE-TOKEN — nothing has streamed yet (or a restart just cleared the
//    buffer): there is no bubble content to hang the line on, so it rides the
//    pre-token notice slot instead, exactly as ChatView's typing row does.
// 3. RECOVERED — a retry took; the first token retires the line and the
//    answer continues in place.
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { MessageBubble } from "../components/chat/MessageBubble";
import type { ChatMessage } from "../lib/ipc/chatSessions";

const USER_TURN = "There's a failing test in the sync module — can you find it and fix it?";

// A half-finished answer, the way a mid-stream stall leaves it.
const PARTIAL_ANSWER = `I'll start by running the test suite to see what's failing.

The failure is in \`syncQueue.test.ts\` — the retry test expects three attempts
but gets four. Looking at the queue implementation, the retry counter is
incremented before the backoff check, so the final failure re-`;

const RECOVERED_ANSWER = `${PARTIAL_ANSWER}enqueues once more.

The fix is to increment the counter after the backoff gate rather than before it.`;

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        font: "11px ui-monospace, monospace",
        color: "var(--text-dim)",
        padding: "2px 2px 8px",
      }}
    >
      {children}
    </div>
  );
}

/** One transcript row, the way ChatView's virtualized rows are built: the
 *  inter-bubble gap lives on the row (paddingBottom), not on the container. */
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ paddingBottom: 18 }}>{children}</div>;
}

/** The line itself, exactly as ChatView renders it under a bubble. */
function ReconnectLine({ message }: { message: string }) {
  return (
    <div className="chat-reconnect-notice" role="status">
      <span className="local-spinner" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

/** The same line in the pre-token slot (the typing row). Same class on
 *  purpose: ChatView renders a reconnect notice identically in both slots, so
 *  it doesn't change appearance when a restart clears the buffer. */
function PreTokenLine({ message }: { message: string }) {
  return (
    <div className="chat-reconnect-notice" role="status">
      <span className="local-spinner" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

const userMessage: ChatMessage = { role: "user", content: USER_TURN, createdAt: 1_760_000_000 };
const livePerf = { chatSessionId: "harness", elapsedMs: 42_000 } as never;
const partial: ChatMessage = { role: "assistant", content: PARTIAL_ANSWER };
const empty: ChatMessage = { role: "assistant", content: "" };
const recovered: ChatMessage = { role: "assistant", content: RECOVERED_ANSWER };

createRoot(document.getElementById("root")!).render(
  <div className="app-shell">
    <div className="chat-grid-wrap" style={{ height: "100vh" }}>
      <div
        className="chat-view"
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        {/* display:block + row padding mirrors the virtualizer's geometry
            (see ChatView: the gap is on the row, not the container). */}
        <div className="chat-messages" style={{ display: "block" }}>
          <Label>1. mid-answer stall — the partial stays, the ladder re-dials under it</Label>
          <Row>
            <MessageBubble message={userMessage} />
          </Row>
          <Row>
            <MessageBubble message={partial} live livePerf={livePerf} />
            <ReconnectLine message="Reconnecting… (3/10)" />
          </Row>

          <Label>2. nothing streamed yet — the line rides the pre-token slot instead</Label>
          <Row>
            <MessageBubble message={empty} live livePerf={livePerf} />
          </Row>
          <Row>
            <PreTokenLine message="Reconnecting… (3/10)" />
          </Row>

          <Label>3. recovered — the retry's first token retires the line</Label>
          <Row>
            <MessageBubble message={recovered} live livePerf={livePerf} />
          </Row>
          <div style={{ height: 120, flexShrink: 0 }} />
        </div>
      </div>
    </div>
  </div>,
);
