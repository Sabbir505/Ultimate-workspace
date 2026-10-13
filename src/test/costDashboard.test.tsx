import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CostDashboard } from "../components/cost-dashboard/CostDashboard";
import { getCostRollups, getPriceInfo, pricesRefreshNow } from "../lib/ipc";

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
    // Stored price blob markers. Default: never fetched (null age) — the
    // per-test overrides below drive both branches of the open-time
    // staleness gate.
    getPriceInfo: vi.fn().mockResolvedValue({ fetchedAt: null }),
    pricesRefreshNow: vi.fn().mockResolvedValue(null),
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
  beforeEach(() => {
    // The price mocks are module-level spies: clear CALLS only (implementations
    // are re-set per test below) so call-count assertions don't leak between
    // tests, and a held promise from one test can't resolve into another.
    (getPriceInfo as unknown as ReturnType<typeof vi.fn>).mockReset();
    (pricesRefreshNow as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

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

  // ---- Live price table: open-time freshness (the "Live prices updated …" line) ----

  const priceFn = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

  it("re-fetches the price table on open so the updated time is fresh", async () => {
    // The reported bug: the dashboard spun (rollups + plan windows) but the
    // price line kept showing the previous fetch time. Every open re-fetches,
    // so the bar must land on the NEW fetch time.
    const staleAt = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    const freshAt = staleAt + 90;
    priceFn(getPriceInfo).mockResolvedValue({ fetchedAt: staleAt });
    priceFn(pricesRefreshNow).mockResolvedValue({ stored: 42, fetchedAt: freshAt });

    render(<CostDashboard />);
    // The bar lands on the FRESH fetch time, not the stored one.
    await waitFor(() => {
      const note = document.querySelector(".cost-footer-note");
      expect(note?.textContent).toContain(
        `Live prices updated ${new Date(freshAt * 1000).toLocaleString()}`,
      );
    });
    expect(priceFn(pricesRefreshNow)).toHaveBeenCalled();
  });

  it("shows an updating cue while the open-time price fetch is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    priceFn(getPriceInfo).mockResolvedValue({
      fetchedAt: Math.floor(Date.now() / 1000) - 2 * 60 * 60,
    });
    priceFn(pricesRefreshNow).mockReturnValue(
      new Promise((resolve) => { release = resolve; }),
    );

    render(<CostDashboard />);
    // In flight: the PRICE BAR says so instead of changing silently (scoped
    // to the bar — the header has its own "Updating…" for the rollups).
    await waitFor(() => {
      const bar = document.querySelector(".cost-price-bar");
      expect(bar?.textContent).toContain("Updating…");
    });

    release({ stored: 42, fetchedAt: Math.floor(Date.now() / 1000) });
    await waitFor(() => {
      const bar = document.querySelector(".cost-price-bar");
      expect(bar?.textContent).not.toContain("Updating…");
    });
  });

  it("re-fetches on every open, even with a fresh stored blob", async () => {
    // No staleness gate: a blob fetched a minute ago still re-fetches, so the
    // "Live prices updated" line always tracks an open the user just made.
    const recentAt = Math.floor(Date.now() / 1000) - 60;
    const freshAt = recentAt + 30;
    priceFn(getPriceInfo).mockResolvedValue({ fetchedAt: recentAt });
    priceFn(pricesRefreshNow).mockResolvedValue({ stored: 42, fetchedAt: freshAt });

    render(<CostDashboard />);
    await waitFor(() => {
      const note = document.querySelector(".cost-footer-note");
      expect(note?.textContent).toContain(
        `Live prices updated ${new Date(freshAt * 1000).toLocaleString()}`,
      );
    });
    expect(priceFn(pricesRefreshNow)).toHaveBeenCalled();
  });
});
