import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CostDashboard } from "../components/cost-dashboard/CostDashboard";

// Mock the IPC layer so the dashboard gets a known rollup. importOriginal
// keeps every other export (listBudgets, setBudget, …) real so the
// BudgetPanel mounted inside CostDashboard doesn't hit undefined exports.
vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    getCostRollups: vi.fn().mockResolvedValue({
    totals: { rawTokenCostUsd: 100, providerReportedUsd: 5, estimatedUsd: 95, unpricedUsd: 0 },
    perProvider: [{ provider: "claude_code", costUsd: 80, tokens: 1_000_000, sharePct: 80 }],
    daily: [{ day: "2026-08-01", costUsd: 10, tokensByProvider: { claude_code: 100_000 }, costByProvider: { claude_code: 8 } }],
    byKind: { processedTokens: 1_100_000, cachedInputTokens: 1_000_000, uncachedInputTokens: 100_000, outputTokens: 50_000, reasoningTokens: 5_000, sessions: 12, responses: 120 },
    perModel: [{ modelKey: "claude-sonnet-4-5", displayName: "claude-sonnet-4-5", costUsd: 80, sharePct: 80, tokens: 1_000_000, provider: "claude_code" }],
    costQuality: { providerReportedPct: 5, modelPricedPct: 95, unpricedPct: 0, cacheSavingsUsd: 12.3 },
    perProject: [{ projectId: "p1", totalCostUsd: 80, totalInputTokens: 1_000_000, totalOutputTokens: 50_000 }],
    rangeStart: "2026-07-09", rangeEnd: "2026-08-07", rangeDays: 30,
  }),
    safeListen: vi.fn().mockResolvedValue(() => {}),
  };
});

describe("CostDashboard", () => {
  it("renders the raw token cost and the model breakdown", async () => {
    render(<CostDashboard />);
    expect(await screen.findByText(/\$100/)).toBeTruthy();
    expect(await screen.findByText(/claude-sonnet-4-5/)).toBeTruthy();
  });

  it("switches the range toggle", async () => {
    render(<CostDashboard />);
    fireEvent.click(await screen.findByText("7d"));
    // The hook re-fetches; the mock resolves to the same payload, so the
    // existing data is still shown. We assert the toggle is now active.
    expect((await screen.findByText("7d")).className).toMatch(/active/);
  });
});
