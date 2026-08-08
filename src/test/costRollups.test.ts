import type {
  CostRollups, CostTotals, ProviderCostRollup, DailyCost,
  CostByKind, ModelCostRollup, CostQuality, ProjectCostRollup,
} from "../types";

const sample: CostRollups = {
  totals: { rawTokenCostUsd: 100, providerReportedUsd: 5, estimatedUsd: 95, unpricedUsd: 0 },
  perProvider: [
    { provider: "claude_code", costUsd: 80, tokens: 1_000_000, sharePct: 80 },
    { provider: "kimi_code", costUsd: 20, tokens: 250_000, sharePct: 20 },
  ],
  daily: [{ day: "2026-08-01", costUsd: 10, tokensByProvider: { claude_code: 100_000 }, costByProvider: { claude_code: 8 } }],
  byKind: {
    processedTokens: 1_100_000, cachedInputTokens: 1_000_000,
    uncachedInputTokens: 100_000, outputTokens: 50_000, reasoningTokens: 5_000,
    sessions: 12, responses: 120,
  },
  perModel: [
    { modelKey: "claude-sonnet-4-5", displayName: "claude-sonnet-4-5", costUsd: 80, sharePct: 80, tokens: 1_000_000, provider: "claude_code" },
  ],
  costQuality: { providerReportedPct: 5, modelPricedPct: 95, unpricedPct: 0, cacheSavingsUsd: 12.3 },
  perProject: [{ projectId: "p1", totalCostUsd: 80, totalInputTokens: 1_000_000, totalOutputTokens: 50_000 }],
  rangeStart: "2026-07-09", rangeEnd: "2026-08-07", rangeDays: 30,
};

describe("CostRollups shape", () => {
  it("preserves all required keys", () => {
    expect(sample.totals.rawTokenCostUsd).toBe(100);
    expect(sample.perProvider[0].provider).toBe("claude_code");
    expect(sample.daily[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sample.costQuality.cacheSavingsUsd).toBeCloseTo(12.3);
    expect(sample.rangeDays).toBe(30);
  });
  it("sums per-provider to total", () => {
    const sum = sample.perProvider.reduce((s, p) => s + p.costUsd, 0);
    expect(sum).toBeCloseTo(sample.totals.rawTokenCostUsd, 1);
  });
});
