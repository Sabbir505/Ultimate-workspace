// Dev-only visual harness for the usage-limit warning NOTCH on the composer:
// mounts the REAL ChatComposer over the REAL usage store with usage alerts
// armed exactly as commands/usage.rs emits them (`usage:limit-alert` /
// `check_usage_limits`), so warn (approaching a cap) and crit (limit reached)
// render in their real dock position and geometry.
// Serve `npx vite`, open http://localhost:1500/usage-notch-harness.html — the
// floating switcher cycles the scenarios and flips the theme.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { ChatComposer } from "../components/chat/ChatComposer";
import { useChatStore } from "../state/chat";
import { useUsageLimitsStore } from "../state/usageLimits";
import type { UsageLimitAlert } from "../lib/ipc";

const SESSION = "usage-notch-harness";
const NOW = Math.floor(Date.now() / 1000);

function capAlert(
  target: string,
  label: string,
  window: string,
  windowLabel: string,
  pct: number,
  used: number,
  cap: number,
): UsageLimitAlert {
  const detail = `$${used.toFixed(2)} / $${cap.toFixed(2)}`;
  const crit = pct >= 100;
  return {
    target,
    label,
    tier: crit ? "crit" : "warn",
    window,
    windowLabel,
    usedPct: pct,
    usedUsd: used,
    capUsd: cap,
    usedTokens: null,
    capTokens: null,
    usedRequests: null,
    capRequests: null,
    resetsAt: null,
    message: crit
      ? `${label} reached its ${windowLabel} cap (${detail})`
      : `${label} at ${pct.toFixed(0)}% of its ${windowLabel} cap (${detail})`,
  };
}

function windowAlert(
  target: string,
  label: string,
  windowLabel: string,
  pct: number,
  resetsInSecs: number | null,
  remainingUsd?: number,
): UsageLimitAlert {
  const crit = pct >= 100;
  return {
    target,
    label,
    tier: crit ? "crit" : "warn",
    window: "5h",
    windowLabel,
    usedPct: pct,
    usedUsd: null,
    capUsd: null,
    usedTokens: null,
    capTokens: null,
    usedRequests: null,
    capRequests: null,
    resetsAt: resetsInSecs == null ? null : NOW + resetsInSecs,
    message:
      remainingUsd !== undefined
        ? `${label}: ${windowLabel} at ${pct.toFixed(0)}% used — $${remainingUsd.toFixed(2)} left`
        : `${label}: ${windowLabel} at ${pct.toFixed(0)}% used`,
  };
}

interface Scenario {
  id: string;
  label: string;
  /** The composer's agent prop — picks which target the notch resolves to. */
  agent: string;
  alerts: UsageLimitAlert[];
}

const SCENARIOS: Scenario[] = [
  { id: "none", label: "No notch", agent: "harness:commandcode", alerts: [] },
  {
    id: "warn",
    label: "Cap warning (86%)",
    agent: "harness:commandcode",
    alerts: [capAlert("commandcode", "CommandCode", "day", "daily", 86, 0.86, 1)],
  },
  {
    id: "crit",
    label: "Limit reached",
    agent: "harness:commandcode",
    alerts: [capAlert("commandcode", "CommandCode", "day", "daily", 104, 1.04, 1)],
  },
  {
    id: "claude",
    label: "Claude 5h window (92%)",
    agent: "harness:claude_code",
    alerts: [
      windowAlert("claude_code", "Claude Code", "5-hour window", 92, 2 * 3600),
    ],
  },
  {
    id: "kimi",
    label: "Kimi Code · token cap",
    agent: "harness:kimi_code",
    alerts: [
      // The other harness shape: Kimi/Pi/Omp report no remaining quota, so
      // the cap the user configured against Relay's own measurement is what
      // can warn (Kimi's tokens come from its wire.jsonl usage.record log).
      {
        target: "kimi_code",
        label: "Kimi Code",
        tier: "warn",
        window: "week",
        windowLabel: "weekly",
        usedPct: 82,
        usedUsd: null,
        capUsd: null,
        usedTokens: 410_000,
        capTokens: 500_000,
        usedRequests: null,
        capRequests: null,
        resetsAt: null,
        message: "Kimi Code at 82% of its weekly cap (410K / 500K tokens)",
      },
    ],
  },
  {
    id: "credits",
    label: "OpenRouter credits low",
    agent: "builtin",
    alerts: [
      // Credits carry no reset timestamp (account balance, not a window).
      windowAlert("chat:openrouter", "OpenRouter", "Account credits", 96, null, 0.42),
    ],
  },
];

function applyScenario(s: Scenario) {
  useUsageLimitsStore.setState({ alerts: s.alerts, dismissed: {} });
}

/** Arms the goal notch so the stacked state (usage ← goal ← card) is visible. */
function armGoalNotch(on: boolean) {
  useChatStore.setState((s) => {
    if (!on) {
      const next = { ...s.loopState };
      delete next[SESSION];
      return { loopState: next };
    }
    return {
      loopState: {
        ...s.loopState,
        [SESSION]: {
          goal: "Refactor the settings panel and add tests",
          iteration: 3,
          max: 20,
          active: true,
          startedAt: Date.now() - 12 * 60_000,
        },
      },
    };
  });
}

useChatStore.setState({ activeChatSessionId: SESSION });
applyScenario(SCENARIOS[1]);

function Harness() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [scenario, setScenario] = useState(SCENARIOS[1]);
  const [goalNotch, setGoalNotch] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    armGoalNotch(goalNotch);
  }, [goalNotch]);
  // The OpenRouter scenario resolves via provider, the rest via agent.
  const provider = scenario.agent === "builtin" ? "openrouter" : undefined;
  const agent = scenario.agent === "builtin" ? "builtin" : scenario.agent;

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
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );

  return (
    <>
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
          flexWrap: "wrap",
          maxWidth: "min(720px, 94vw)",
        }}
      >
        {SCENARIOS.map((s) =>
          pill(s.label, s.id === scenario.id, () => {
            setScenario(s);
            applyScenario(s);
          }),
        )}
        <span style={{ width: 1, background: "var(--border)", margin: "2px 3px" }} />
        {pill("Goal notch", goalNotch, () => setGoalNotch(!goalNotch))}
        {pill(`Theme: ${theme}`, true, () =>
          setTheme(theme === "dark" ? "light" : "dark"),
        )}
      </div>
      <div className="chat-grid-wrap" style={{ height: "100vh" }}>
        <div
          className="chat-view"
          style={{ height: "100vh", display: "flex", flexDirection: "column" }}
        >
          <div className="chat-messages">
            <div className="chat-welcome">
              <div className="chat-welcome-inner">
                <div className="chat-welcome-greeting">Good evening</div>
              </div>
            </div>
            <div style={{ height: 140, flexShrink: 0 }} />
          </div>
          {/* The notch renders inside ChatComposer, directly above the card
              (same in-flow contract as the goal notch). */}
          <div className="chat-composer-dock">
            <ChatComposer
              sessionId={SESSION}
              onSend={() => undefined}
              onStop={() => undefined}
              streaming={false}
              provider={provider}
              agent={agent}
              onAgentModelPick={() => undefined}
            />
          </div>
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
