// Usage & limits panel (Cost dashboard): per-source cards with rolling usage
// columns, configured caps (tone + threshold tick), and provider/CLI-reported
// plan windows. "Remaining" only appears where a source reports it — the
// panel must never invent numbers; local models are excluded backend-side.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UsageLimitsPanel } from "../components/cost-dashboard/UsageLimitsPanel";
import { useUsageLimitsStore } from "../state/usageLimits";
import type { UsageMeterPayload, UsageTotals } from "../lib/ipc";

const setUsageLimit = vi.fn(async (..._args: unknown[]) => null);
const getUsageMeters = vi.fn();
const checkUsageLimits = vi.fn(async (..._args: unknown[]) => []);

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUsageMeters: (...a: unknown[]) => getUsageMeters(...a),
  checkUsageLimits: (...a: unknown[]) => checkUsageLimits(...a),
  setUsageLimit: (...a: unknown[]) => setUsageLimit(...a),
  removeUsageLimit: vi.fn(async () => undefined),
  refreshUsageWindows: vi.fn(async () => ({ updated: [], errors: [] })),
}));

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

const anthropic: UsageMeterPayload = {
  target: "chat:anthropic",
  label: "Anthropic API",
  windows: {
    lastHour: totals(1_200, 0.02),
    lastDay: totals(50_000, 0.4),
    lastWeek: totals(200_000, 1.6),
    lastMonth: totals(800_000, 6.4),
  },
  caps: [],
  reported: [
    {
      target: "chat:anthropic",
      window: "tokens",
      label: "Token rate limit",
      source: "headers",
      usedPct: 68,
      used: 102_000,
      limit: 150_000,
      remaining: 48_000,
      unit: "tokens",
      resetsAt: null,
      status: null,
      observedAt: 0,
    },
  ],
  plan: null,
  health: null,
};

const commandcode: UsageMeterPayload = {
  target: "commandcode",
  label: "CommandCode",
  windows: {
    lastHour: totals(10_000, 0.12),
    lastDay: totals(60_000, 0.86),
    lastWeek: totals(300_000, 4.2),
    lastMonth: totals(900_000, 12.4),
  },
  caps: [
    {
      window: "day",
      usedPct: 86,
      usedUsd: 0.86,
      capUsd: 1,
      usedTokens: null,
      capTokens: null,
      usedRequests: null,
      capRequests: null,
      thresholdPct: 80,
      tier: "warn",
    },
  ],
  reported: [
    {
      target: "commandcode",
      window: "5h",
      label: "5-hour window",
      source: "commandcode",
      usedPct: 43,
      used: 6,
      limit: 14,
      remaining: 8,
      unit: "usd",
      resetsAt: null,
      status: null,
      observedAt: 0,
    },
  ],
  plan: {
    target: "commandcode",
    planName: "GOAT",
    planId: "individual-goat",
    status: "active",
    periodStart: null,
    periodEnd: null,
    creditsRemaining: 57.6,
    creditsTotal: 70,
    creditsUnit: "usd",
    tokensTotal: 577_700_000,
    requestsTotal: 2866,
    costTotalUsd: 9.1,
    source: "commandcode",
    observedAt: 0,
  },
  health: null,
};

beforeEach(() => {
  getUsageMeters.mockResolvedValue([anthropic, commandcode]);
  useUsageLimitsStore.setState({ meters: {}, alerts: [], dismissed: {}, loading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UsageLimitsPanel", () => {
  it("renders per-provider and per-harness cards with rolling windows", async () => {
    render(<UsageLimitsPanel />);
    expect(await screen.findByText("Anthropic API")).toBeTruthy();
    expect(screen.getByText("CommandCode")).toBeTruthy();
    expect(screen.getByText("API providers")).toBeTruthy();
    expect(screen.getByText("Harness CLIs")).toBeTruthy();
    // Rolling strip columns: the commandcode 1h token cell + the 30d cell.
    expect(screen.getAllByText("10.0K").length).toBeGreaterThan(0);
    expect(screen.getAllByText("900.0K").length).toBeGreaterThan(0);
    // Four window columns per card.
    expect(document.querySelectorAll(".usage-stat").length).toBe(8);
  });

  it("shows reported plan windows and credits without inventing numbers", async () => {
    render(<UsageLimitsPanel />);
    expect(await screen.findByText("5-hour window")).toBeTruthy();
    expect(screen.getByText("$8.00 left of $14.00")).toBeTruthy();
    expect(screen.getByText("$57.60 left")).toBeTruthy();
    expect(screen.getByText("GOAT")).toBeTruthy();
    // Header window shows remaining-of-limit tokens.
    expect(screen.getByText("48.0K left of 150.0K")).toBeTruthy();
    // Account-wide period totals (what the provider's own dashboard shows),
    // distinct from the locally measured columns.
    const acct = screen.getByTestId("usage-account");
    expect(acct.textContent).toContain("2,866 runs");
    expect(acct.textContent).toContain("577.7M tokens");
    expect(acct.textContent).toContain("$9.10 spent");
  });

  it("tints the card and meter for a cap in the warn tier", async () => {
    render(<UsageLimitsPanel />);
    expect(await screen.findByText("day cap")).toBeTruthy();
    expect(screen.getByText("$0.86 of $1.00")).toBeTruthy();
    expect(screen.getByText("86% used")).toBeTruthy();
    expect(screen.getByText("warn at 80%")).toBeTruthy();
    const card = document.querySelector('[data-target="commandcode"]');
    expect(card?.className).toContain("usage-card-warn");
    expect(card?.querySelector(".usage-meter-warn")).toBeTruthy();
    // Threshold tick rendered on the cap track.
    expect(card?.querySelector(".usage-meter-tick")).toBeTruthy();
  });

  it("shows a remaining-only credits window when the period summary is unavailable", async () => {
    // The real-world case that hid the monthly row: credits reported, the
    // usage/summary call failed, so there is no used/limit pair — the row
    // must still read as a number.
    const remainingOnly: UsageMeterPayload = {
      target: "commandcode",
      label: "CommandCode",
      windows: {
        lastHour: totals(0, 0, 0),
        lastDay: totals(0, 0, 0),
        lastWeek: totals(0, 0, 0),
        lastMonth: totals(0, 0, 0),
      },
      caps: [],
      reported: [
        {
          target: "commandcode",
          window: "month",
          label: "Monthly credits",
          source: "commandcode",
          usedPct: null,
          used: null,
          limit: null,
          remaining: 3.5,
          unit: "usd",
          resetsAt: null,
          status: null,
          observedAt: 0,
        },
      ],
      plan: null,
      health: null,
    };
    getUsageMeters.mockResolvedValueOnce([remainingOnly]);
    render(<UsageLimitsPanel />);
    expect(await screen.findByText("Monthly credits")).toBeTruthy();
    expect(screen.getByText("$3.50 left")).toBeTruthy();
  });

  it("saves a cap from the inline editor", async () => {
    render(<UsageLimitsPanel />);
    await screen.findByText("Anthropic API");
    // CommandCode already has a cap ("Edit cap"), so the only "Set cap" is
    // the Anthropic card.
    fireEvent.click(screen.getByText("Set cap"));
    fireEvent.change(screen.getByPlaceholderText("$"), { target: { value: "5" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(setUsageLimit).toHaveBeenCalled());
    const args = setUsageLimit.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe("chat:anthropic");
    expect(args[1]).toBe("day");
    expect(args[2]).toBe(5);
  });
});
