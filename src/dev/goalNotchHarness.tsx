// Dev-only visual harness for the active-goal notch (/goal · /loop): mounts
// the REAL ChatComposer over the REAL store with loopState armed for the
// composer's session — the exact state a live loop produces — so the notch
// above the card renders (and disappears) exactly as it does in the app.
// Serve `npx vite`, open http://localhost:1500/goal-notch-harness.html; the
// floating switcher arms/stops the loop and flips the theme.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { ChatComposer } from "../components/chat/ChatComposer";
import { GOAL_LOOP_MAX, useChatStore } from "../state/chat";

const SESSION = "goal-notch-harness";
const GOAL =
  "Continue until you have a demo that is 100x faster in real-ish work compared to the Rust compiler";

// Arm/stop the loop through the real store shape (startLoop itself would
// fire the telemetry IPC, which doesn't exist outside Tauri).
function setLoop(active: boolean) {
  useChatStore.setState((s) => ({
    loopState: {
      ...s.loopState,
      [SESSION]: {
        goal: GOAL,
        iteration: active ? 3 : 4,
        max: GOAL_LOOP_MAX,
        active,
        startedAt: Date.now() - 4 * 60_000,
      },
    },
  }));
}

useChatStore.setState({ activeChatSessionId: SESSION });
setLoop(true);

function Harness() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [goalOn, setGoalOn] = useState(true);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const pill = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      onClick={onClick}
      style={{
        padding: "4px 10px",
        fontSize: 11.5,
        borderRadius: 99,
        border: "1px solid " + (active ? "var(--border-strong)" : "transparent"),
        background: active ? "var(--surface-glass-2)" : "transparent",
        color: active ? "var(--text)" : "var(--text-dim)",
        cursor: "pointer",
        boxShadow: "none",
      }}
    >
      {label}
    </button>
  );
  return (
    <>
      {/* Harness-only chrome (not app CSS) */}
      <div
        style={{
          position: "fixed",
          top: 10,
          right: 12,
          zIndex: 999,
          display: "flex",
          gap: 4,
          padding: 4,
          borderRadius: 12,
          background: "var(--surface-glass)",
          border: "1px solid var(--border-strong)",
          boxShadow: "var(--glass-drop)",
        }}
      >
        {pill(goalOn ? "Goal: pursuing" : "Goal: off", goalOn, () => {
          const next = !goalOn;
          setGoalOn(next);
          setLoop(next);
        })}
        <span style={{ width: 1, background: "var(--border)", margin: "2px 3px" }} />
        {pill(theme === "dark" ? "Dark" : "Light", true, () =>
          setTheme(theme === "dark" ? "light" : "dark"),
        )}
      </div>
      <div className="chat-grid-wrap" style={{ height: "100vh" }}>
        <div className="chat-view" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
          <div className="chat-messages">
            <div className="chat-welcome">
              <div className="chat-welcome-inner">
                <div className="chat-welcome-greeting">Good evening</div>
              </div>
            </div>
            <div style={{ height: 120, flexShrink: 0 }} />
          </div>
          <div className="chat-composer-dock">
            <ChatComposer
              sessionId={SESSION}
              onSend={() => undefined}
              onStop={() => undefined}
              streaming={false}
              agent="builtin"
              onAgentModelPick={() => undefined}
            />
          </div>
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
