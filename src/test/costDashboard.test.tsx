import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CostDashboard } from "../components/cost-dashboard/CostDashboard";
import { getCostRollups } from "../lib/ipc";

// Shared fixture: the hoisted factory mock below resolves with it, and the
// in-place range-switch test re-uses it as the payload that eventually
// settles the held request. vi.hoisted because vi.mock factories run before
// any module-level const.
const ROLLUPS_PAYLOAD = vi.hoisted(() => ({
  totals: { rawTokenCostUsd: 100, providerReportedUsd: 5, estimatedUsd: 95 },
  perProvider: [{ provider: "claude_code", costUsd: 80, tokens: 1_000_000, sharePct: 80 }],
  daily: [{ day: "2026-08-01", costUsd: 10, tokensByProvider: { claude_code: 100_000 }, costByProvider: { claude_code: 8 } }],
  byKind: { processedTokens: 1_100_000, cachedInputTokens: 1_000_000, uncachedInputTokens: 100_000, outputTokens: 50_000, reasoningTokens: 5_000, sessions: 12, responses: 120 },
  perModel: [{ modelKey: "claude-sonnet-4-5", displayName: "claude-sonnet-4-5", costUsd: 80, sharePct: 80, tokens: 1_000_000, provider: "claude_code" }],
  costQuality: { providerReportedPct: 5, modelPricedPct: 95, unpricedPct: 0, cacheSavingsUsd: 12.3 },
  perProject: [{ projectId: "p1", totalCostUsd: 80, totalInputTokens: 1_000_000, totalOutputTokens: 50_000 }],
  rangeStart: "2026-07-09", rangeEnd: "2026-08-07", rangeDays: 30,
}));

// Mock the IPC layer so the dashboard gets a known rollup. importOriginal
// keeps every other export (listBudgets, setBudget, …) real so the
// BudgetPanel mounted inside CostDashboard doesn't hit undefined exports.
vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    getCostRollups: vi.fn().mockResolvedValue(ROLLUPS_PAYLOAD),
    safeListen: vi.fn().mockResolvedValue(() => {}),
    getArtifactCosts: vi.fn().mockResolvedValue([
      {
        artifactId: "a1",
        kind: "skill",
        name: "Docx skill",
        liveRuns: 4,
        evalRuns: 2,
        inputTokens: 12_000,
        outputTokens: 3_400,
        cacheReadTokens: 8_000,
        costUsd: 0.042,
      },
    ]),
  };
});

describe("CostDashboard", () => {
  it("renders the raw token cost and the model breakdown", async () => {
    render(<CostDashboard />);
    expect(await screen.findByText(/\$100/)).toBeTruthy();
    expect(await screen.findByText(/claude-sonnet-4-5/)).toBeTruthy();
  });

  it("attributes per-artifact spend (improvements engine P3)", async () => {
    render(<CostDashboard />);
    const table = await screen.findByTestId("artifact-cost-table");
    expect(table.textContent).toContain("Docx skill");
    expect(table.textContent).toContain("Skill");
    // Live vs eval split: 4 tracked runs + 2 engine eval runs, with cost.
    const cells = table.querySelectorAll("td");
    expect(cells[2].textContent).toBe("4");
    expect(cells[3].textContent).toBe("2");
    expect(table.textContent).toContain("$0.04");
  });

  it("surfaces the cache-savings headline with the cached share", async () => {
    // CostHero leads with what prompt caching saved (costQuality
    // .cacheSavingsUsd) plus the cached share of input when there is one.
    render(<CostDashboard />);
    expect(await screen.findByText(/Saved \$12\.30 by prompt caching/)).toBeTruthy();
    expect(await screen.findByText(/90\.9% of input cached/)).toBeTruthy();
  });

  it("switches the range toggle", async () => {
    render(<CostDashboard />);
    fireEvent.click(await screen.findByText("7d"));
    // The hook re-fetches; the mock resolves to the same payload, so the
    // existing data is still shown. We assert the toggle is now active.
    expect((await screen.findByText("7d")).className).toMatch(/active/);
  });

  it("swaps data in place on a range switch instead of blanking the page", async () => {
    // Gate: requests resolve instantly until `hold` flips, then hang until
    // released. Counting calls would be brittle (effect re-runs), and a
    // mockReturnValueOnce risks being consumed by the initial load.
    let hold = false;
    let release: (v: unknown) => void = () => {};
    (getCostRollups as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (!hold) return Promise.resolve(ROLLUPS_PAYLOAD);
      return new Promise((resolve) => { release = resolve; });
    });

    render(<CostDashboard />);
    const panel = await screen.findByTestId("cost-rollups");
    // Initial load resolved, so the panel is live and not dimmed.
    await waitFor(() => expect(panel.className).toBe("cost-rollups-body"));

    // Hold the next request and click 90d: the previous range's content
    // must stay mounted (no full-page "Loading…"), dimmed and flagged, so
    // it can't be misread as 90-day data.
    hold = true;
    fireEvent.click(screen.getByText("90d"));

    await waitFor(() => expect(panel.className).toBe("cost-rollups-body cost-refreshing"));
    expect(panel.getAttribute("aria-busy")).toBe("true");
    // Still the old data, still on screen — no "Loading…" takeover.
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(panel.textContent).toContain("claude-sonnet-4-5");
    expect(screen.getByText("Updating…")).toBeTruthy();

    hold = false;
    release(ROLLUPS_PAYLOAD);
    await waitFor(() => expect(panel.className).toBe("cost-rollups-body"));
    expect(screen.queryByText("Updating…")).toBeNull();
  });
});
