// Dev-only visual harness for the composer telemetry HUD (in/out/llm chips)
// and the context meter at NARROW pane widths — the split-view / right
// tool-panel-open case where the chips strip and the meter used to collide.
// Renders the REAL ChatComposer inside real .chat-pane columns (the size
// containers the app's responsive rules key off) against the REAL global CSS.
// Serve `npx vite` and open
// http://localhost:1500/composer-hud-harness.html; the columns are the pane
// widths at which the collision was reported (775px is the full card column).
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { ChatComposer } from "../components/chat/ChatComposer";
import { useChatStore } from "../state/chat";

const SESSION = "composer-hud-harness";

// Idle-after-a-turn telemetry: every chip has a real value (no em-dashes), so
// the strip is at its widest and the collision is at its worst.
useChatStore.setState({
  activeChatSessionId: SESSION,
  livePerf: {},
  sessionMetrics: {},
  lastTurnPerf: {
    [SESSION]: {
      llmTimeMs: 230000,
      toolTimeMs: 41000,
      ttftMs: 380,
      tokensPerSecond: 48,
      outputTokens: 3200,
      inputTokens: 15400,
      cacheHitRate: 0.42,
      elapsedMs: 230000,
    },
  },
});

const WIDTHS = [775, 700, 660, 620, 580, 560, 480, 380];

function Pane({ width }: { width: number }) {
  return (
    <div
      className="chat-pane"
      style={{
        width,
        flexShrink: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div className="chat-view-wrap" style={{ flex: 1, minHeight: 0, height: "100%" }}>
        <div className="chat-view" style={{ flex: 1, minHeight: 0, height: "100%" }}>
          <div className="chat-messages">
            <div className="chat-welcome">
              <div className="chat-welcome-inner">
                <div className="chat-welcome-greeting">{width}px pane</div>
              </div>
            </div>
            <div style={{ height: 40, flexShrink: 0 }} />
          </div>
          <div className="chat-composer-dock">
            <ChatComposer
              sessionId={SESSION}
              onSend={() => undefined}
              onStop={() => undefined}
              streaming={false}
              agent="harness:opencode"
              model="opencode/mimo-v2.6-flash-free"
              onAgentModelPick={() => undefined}
              usedTokens={470000}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Harness() {
  return (
    <div
      className="chat-grid-wrap split-active"
      style={{ height: "100vh", display: "flex", overflowX: "auto" }}
    >
      <div
        className="chat-pane-grid"
        style={{ display: "flex", gap: 0, flex: 1, height: "100%", minHeight: 0 }}
      >
        {WIDTHS.map((w) => (
          <Pane key={w} width={w} />
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
