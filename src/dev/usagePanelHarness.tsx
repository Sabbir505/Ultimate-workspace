// Dev-only visual harness for the Usage & limits panel: mounts the REAL
// UsageLimitsPanel over the REAL usage store with representative meter data
// (API provider with a rate-limit header window, CommandCode GOAT with caps +
// plan windows, Claude Code 5h/7d windows, a free CLI with local usage only,
// OpenRouter credits). Serve `npx vite` and open
// http://localhost:1500/usage-panel-harness.html — the floating switcher
// toggles normal vs pressure (warn/crit) and flips the theme.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { UsageLimitsPanel } from "../components/cost-dashboard/UsageLimitsPanel";
import { useUsageLimitsStore } from "../state/usageLimits";
import type { UsageMeterPayload, UsageTotals } from "../lib/ipc";

function totals(input: number, cost: number, requests = 1): UsageTotals {
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    requests,
    costUsd: cost,
  };
}

const NOW = Math.floor(Date.now() / 1000);

function meters(pressure: boolean): UsageMeterPayload[] {
  return [
    {
      target: "chat:anthropic",
      label: "Anthropic API",
      windows: {
        lastHour: totals(128_000, 0.42, 14),
        lastDay: totals(2_400_000, 7.8, 190),
        lastWeek: totals(16_800_000, 54.2, 1320),
        lastMonth: totals(62_400_000, 201.4, 4900),
      },
      caps: [],
      reported: [
        {
          target: "chat:anthropic",
          window: "tokens",
          label: "Token rate limit",
          source: "headers",
          usedPct: pressure ? 82 : 61,
          used: pressure ? 123_000 : 91_500,
          limit: 150_000,
          remaining: pressure ? 27_000 : 58_500,
          unit: "tokens",
          resetsAt: NOW + 38,
          status: null,
          observedAt: NOW,
        },
      ],
      plan: null,
      health: null,
    },
    {
      target: "commandcode",
      label: "CommandCode",
      windows: {
        lastHour: totals(410_000, 1.24, 22),
        lastDay: totals(3_100_000, 9.1, 140),
        lastWeek: totals(11_200_000, 31.8, 520),
        lastMonth: totals(38_900_000, 98.6, 1780),
      },
      caps: [
        {
          window: "day",
          usedPct: pressure ? 86 : 44,
          usedUsd: pressure ? 0.86 : 0.44,
          capUsd: 1,
          usedTokens: null,
          capTokens: null,
          usedRequests: null,
          capRequests: null,
          thresholdPct: 80,
          tier: pressure ? "warn" : "ok",
        },
      ],
      reported: [
        {
          target: "commandcode",
          window: "5h",
          label: "5-hour window",
          source: "commandcode",
          usedPct: pressure ? 92 : 43,
          used: pressure ? 12.9 : 6.02,
          limit: 14,
          remaining: pressure ? 1.1 : 7.98,
          unit: "usd",
          resetsAt: NOW + (pressure ? 1_800 : 9_000),
          status: null,
          observedAt: NOW,
        },
        {
          target: "commandcode",
          window: "week",
          label: "Weekly window",
          source: "commandcode",
          usedPct: pressure ? 72 : 18,
          used: pressure ? 25.2 : 6.3,
          limit: 35,
          remaining: pressure ? 9.8 : 28.7,
          unit: "usd",
          resetsAt: NOW + 4 * 86_400,
          status: null,
          observedAt: NOW,
        },
        {
          target: "commandcode",
          window: "month",
          label: "Monthly window",
          source: "commandcode",
          usedPct: pressure ? 82 : 13,
          used: pressure ? 57.6 : 9.1,
          limit: 70,
          remaining: pressure ? 12.4 : 60.9,
          unit: "usd",
          resetsAt: NOW + 21 * 86_400,
          status: null,
          observedAt: NOW,
        },
      ],
      plan: {
        target: "commandcode",
        planName: "GOAT",
        planId: "individual-goat",
        status: "active",
        periodStart: NOW - 9 * 86_400,
        periodEnd: NOW + 21 * 86_400,
        creditsRemaining: pressure ? 12.4 : 60.9,
        creditsTotal: 70,
        creditsUnit: "usd",
        tokensTotal: pressure ? 812_400_000 : 577_700_000,
        requestsTotal: pressure ? 4_104 : 2_866,
        costTotalUsd: pressure ? 18.9 : 9.1,
        source: "commandcode",
        observedAt: NOW,
      },
      health: null,
    },
    {
      target: "claude_code",
      label: "Claude Code",
      windows: {
        lastHour: totals(240_000, 0, 18),
        lastDay: totals(1_900_000, 0, 120),
        lastWeek: totals(8_100_000, 0, 480),
        lastMonth: totals(24_600_000, 0, 1500),
      },
      caps: [],
      reported: [
        {
          target: "claude_code",
          window: "5h",
          label: "5-hour window",
          source: "claude_code",
          usedPct: pressure ? 101 : 55,
          used: null,
          limit: null,
          remaining: null,
          unit: "percent",
          resetsAt: NOW + 2 * 3_600,
          status: pressure ? "exceeded" : null,
          observedAt: NOW,
        },
        {
          target: "claude_code",
          window: "week",
          label: "Weekly window",
          source: "claude_code",
          usedPct: pressure ? 78 : 34,
          used: null,
          limit: null,
          remaining: null,
          unit: "percent",
          resetsAt: NOW + 3 * 86_400,
          status: null,
          observedAt: NOW,
        },
      ],
      plan: null,
      health: null,
    },
    {
      target: "opencode",
      label: "OpenCode",
      windows: {
        lastHour: totals(90_000, 0, 9),
        lastDay: totals(700_000, 0, 61),
        lastWeek: totals(3_400_000, 0, 260),
        lastMonth: totals(9_800_000, 0, 720),
      },
      caps: [
        {
          window: "day",
          usedPct: pressure ? 91 : 26,
          usedUsd: null,
          capUsd: null,
          usedTokens: null,
          capTokens: null,
          usedRequests: pressure ? 91 : 26,
          capRequests: 100,
          thresholdPct: 80,
          tier: pressure ? "warn" : "ok",
        },
      ],
      reported: [],
      plan: null,
      health: null,
    },
    {
      target: "chat:openrouter",
      label: "OpenRouter",
      windows: {
        lastHour: totals(0, 0, 0),
        lastDay: totals(0, 0, 0),
        lastWeek: totals(120_000, 0.36, 4),
        lastMonth: totals(880_000, 2.4, 24),
      },
      caps: [],
      reported: [
        {
          target: "chat:openrouter",
          window: "credits",
          label: "Account credits",
          source: "openrouter",
          usedPct: pressure ? 96 : 32,
          used: pressure ? 9.58 : 3.2,
          limit: 10,
          remaining: pressure ? 0.42 : 6.8,
          unit: "usd",
          resetsAt: null,
          status: null,
          observedAt: NOW,
        },
      ],
      plan: {
        target: "chat:openrouter",
        planName: "OpenRouter",
        planId: null,
        status: null,
        periodStart: null,
        periodEnd: null,
        creditsRemaining: pressure ? 0.42 : 6.8,
        creditsTotal: 10,
        creditsUnit: "usd",
        tokensTotal: null,
        requestsTotal: null,
        costTotalUsd: null,
        source: "openrouter",
        observedAt: NOW,
      },
      health: pressure ? "out of credit / spend cap reached" : null,
    },
  ];
}

useUsageLimitsStore.setState({ meters: Object.fromEntries(meters(false).map((m) => [m.target, m])) });

function Harness() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [pressure, setPressure] = useState(false);
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
        {pill("Normal", !pressure, () => setPressure(false))}
        {pill("Pressure (warn/crit)", pressure, () => setPressure(true))}
        <span style={{ width: 1, background: "var(--border)", margin: "2px 3px" }} />
        {pill(theme === "dark" ? "Dark" : "Light", true, () =>
          setTheme(theme === "dark" ? "light" : "dark"),
        )}
      </div>
      <div
        style={{
          minHeight: "100vh",
          padding: "28px clamp(16px, 6vw, 80px) 60px",
          background: "var(--surface, #0b0d12)",
        }}
      >
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Cost dashboard · Usage &amp; limits</h3>
          <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--text-dim)" }}>
            Dev harness — seeded meters, no IPC. Data mirrors what the backend reports for each
            source.
          </p>
          <div style={{ display: "contents" }}>
            <Panels pressure={pressure} />
          </div>
        </div>
      </div>
    </>
  );
}

function Panels({ pressure }: { pressure: boolean }) {
  useEffect(() => {
    useUsageLimitsStore.setState({
      meters: Object.fromEntries(meters(pressure).map((m) => [m.target, m])),
    });
  }, [pressure]);
  return <UsageLimitsPanel />;
}

createRoot(document.getElementById("root")!).render(<Harness />);
