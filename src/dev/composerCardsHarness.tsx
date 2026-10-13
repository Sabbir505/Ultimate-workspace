// Dev-only visual harness for the docked composer cards: the present_plan
// proposal and the harness question, re-skinned in the goal notch's language
// — the composer card's liquid glass, 18px side inset, rim-only shadow,
// flat bottom fused onto the card below. Renders the REAL components (and
// the REAL ChatComposer, with a seeded goal loop and message queue so the
// goal notch and the in-card queue notch show too) against the REAL global
// CSS — no Tauri backend required. The window sits over a real app wallpaper
// preset (public/sideart — the same slot Settings → Appearance → App
// wallpaper drives), painted through the shell's own mechanism, so the
// liquid glass has something under it to refract. Serve `npx vite` and open
// http://localhost:1500/composer-cards-harness.html; the floating switcher
// flips card, wallpaper, goal notch, and theme.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { ChatComposer } from "../components/chat/ChatComposer";
import { PlanProposalCard } from "../components/chat/PlanProposalCard";
import { QuestionCard } from "../components/chat/QuestionCard";
import { wallpaperCanvasTint } from "../state/appearance";
import { GOAL_LOOP_MAX, useChatStore } from "../state/chat";

const SESSION = "composer-cards-harness";
const GOAL =
  "Repair the compounding model in D:\\artifact\\compound-interest\\index.html and keep the frequency selector honest";

// Seed the real store shape (startLoop itself would fire the telemetry IPC,
// which doesn't exist outside Tauri): an armed loop for the goal notch and a
// two-message queue so the composer card's own queue notch renders.
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
useChatStore.setState((s) => ({
  activeChatSessionId: SESSION,
  messageQueue: {
    ...s.messageQueue,
    [SESSION]: [
      {
        id: 1,
        content:
          "Also add a regression test that pins quarterly + monthly to the old outputs.",
      },
      { id: 2, content: "And rename the simulate() local n to periodsPerYear." },
    ],
  },
}));
setLoop(true);

// App wallpaper — the same public/sideart presets Settings → Appearance →
// App wallpaper offers, applied the way useWallpaper() applies a real one
// (html[data-wallpaper] + --app-wallpaper + scrim/tint at the app's default
// dim of 50). A preset URL is a static path, so the blob-URL dance real
// uploads need isn't required here.
const WALLPAPERS = ["dusk", "aurora", "violet", "waves", "ember", "forest"] as const;
type Wallpaper = (typeof WALLPAPERS)[number] | null;

function applyWallpaper(preset: Wallpaper) {
  const root = document.documentElement;
  if (preset) {
    root.dataset.wallpaper = "on";
    root.style.setProperty("--app-wallpaper", `url("/sideart/${preset}.jpg")`);
  } else {
    delete root.dataset.wallpaper;
    root.style.removeProperty("--app-wallpaper");
  }
  root.style.setProperty("--wallpaper-scrim-a", "0.5");
  root.style.setProperty("--wallpaper-canvas-tint", `${wallpaperCanvasTint(50)}%`);
}

// The plan from the design screenshot, so the preview mirrors it 1:1.
const PLAN = `## Goal

Repair the compounding model in \`D:\\artifact\\compound-interest\\index.html\` (a single-file, dependency-free calculator) so the frequency selector does what it claims, and tidy the two adjacent rough edges I noticed while reading it.

## What's wrong today

The \`simulate()\` loop steps month by month and applies interest only when \`mo % periodMonths === 0\`:

\`\`\`js
if (mo % periodMonths === 0 || mo === months) { balance *= (1 + r / n); }
\`\`\`

At \`n = 4\` (quarterly) and \`n = 12\` (monthly) that is correct. At \`n = 365\` (Daily) it is not: \`mo % (12 / 365)\` is a fraction, so the branch is effectively never taken until the final month — interest lands once a year but with the rate divided by 365.`;

const QUESTION = {
  question:
    'Is "ultimate workspace" a domain idea for Relay, or are you considering renaming the product itself?',
  options: [
    { label: "Just a domain idea" },
    { label: "Considering a rename" },
    { label: "It's a tagline" },
    { label: "Price the aftermarket instead" },
  ],
};

function Harness() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [card, setCard] = useState<"plan" | "question">("plan");
  const [goalOn, setGoalOn] = useState(true);
  const [wallpaper, setWallpaper] = useState<Wallpaper>("dusk");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    applyWallpaper(wallpaper);
    return () => applyWallpaper(null);
  }, [wallpaper]);
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
    <div className="app" style={{ height: "100vh", overflow: "hidden" }}>
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
        {pill("Plan card", card === "plan", () => setCard("plan"))}
        {pill("Question card", card === "question", () => setCard("question"))}
        <span style={{ width: 1, background: "var(--border)", margin: "2px 3px" }} />
        {pill(goalOn ? "Goal: pursuing" : "Goal: off", goalOn, () => {
          const next = !goalOn;
          setGoalOn(next);
          setLoop(next);
        })}
        <span style={{ width: 1, background: "var(--border)", margin: "2px 3px" }} />
        {pill(`BG: ${wallpaper ?? "none"}`, wallpaper !== null, () => {
          const idx = wallpaper ? WALLPAPERS.indexOf(wallpaper) : -1;
          setWallpaper(idx + 1 < WALLPAPERS.length ? WALLPAPERS[idx + 1] : null);
        })}
        <span style={{ width: 1, background: "var(--border)", margin: "2px 3px" }} />
        {pill(theme === "dark" ? "Dark" : "Light", true, () =>
          setTheme(theme === "dark" ? "light" : "dark"),
        )}
      </div>
      <div className="chat-grid-wrap" style={{ flex: 1, minWidth: 0 }}>
        <div
          className="chat-view"
          style={{ height: "100%", display: "flex", flexDirection: "column" }}
        >
          <div className="chat-messages">
            {/* Transcript context parked where the dock overlays it, so the
                frosted cards have content to blur (that's the effect being
                reviewed). */}
            <div style={{ height: "32vh", flexShrink: 0 }} />
            <div className="chat-bubble user">
              <div className="chat-bubble-inner">
                <div className="chat-markdown">
                  <p>Plan it first — fix the compounding-frequency bug in the calculator.</p>
                </div>
              </div>
            </div>
            <div className="chat-bubble assistant">
              <div className="chat-bubble-inner">
                <div className="chat-markdown">
                  <p>
                    Before I touch anything, here's the approach I'll follow — approve it
                    and I'll start.
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div className="chat-composer-dock">
            {card === "question" && (
              <div className="plan-preview">
                <QuestionCard
                  question={{ pendingId: "q1", questions: [QUESTION] }}
                  onResolve={() => undefined}
                />
              </div>
            )}
            {card === "plan" && (
              <div className="plan-preview">
                <PlanProposalCard
                  proposal={{
                    pendingId: "p1",
                    title: "Plan: Fix compounding-frequency bug in compound-interest calculator",
                    plan: PLAN,
                  }}
                  onResolve={() => undefined}
                />
              </div>
            )}
            <ChatComposer
              sessionId={SESSION}
              onSend={() => undefined}
              onStop={() => undefined}
              streaming
              agent="builtin"
              onAgentModelPick={() => undefined}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);