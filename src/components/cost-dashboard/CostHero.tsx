import type { CostRollups, ProviderCostRollup } from "../../types";

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function CostHero({ rollups }: { rollups: CostRollups }) {
  const { totals, perProvider, rangeStart, rangeEnd } = rollups;
  // Only providers that actually incurred cost appear in the breakdown —
  // local/openai-compatible models are free (cost 0) and add noise.
  const priced = perProvider.filter(p => p.costUsd > 0);
  return (
    <section className="cost-hero">
      <div className="cost-hero-headline">
        <div className="cost-hero-label">RAW TOKEN COST</div>
        <div className="cost-hero-value">{usd(totals.rawTokenCostUsd)}</div>
        <div className="cost-hero-range">{formatDate(rangeStart)} to {formatDate(rangeEnd)}</div>
      </div>
      <div className="cost-hero-breakdown">
        {priced.map(p => <ProviderRow key={p.provider} p={p} total={totals.rawTokenCostUsd} />)}
        {priced.length === 0 && (
          <div className="cost-hero-row-empty">No paid usage in this range.</div>
        )}
      </div>
    </section>
  );
}

function ProviderRow({ p, total }: { p: ProviderCostRollup; total: number }) {
  return (
    <div className="cost-hero-row">
      <span className="cost-hero-row-label">{labelFor(p.provider)}</span>
      <span className="cost-hero-row-cost">{usd(p.costUsd)}</span>
      <span className="cost-hero-row-share">{((p.costUsd / Math.max(total, 1e-9)) * 100).toFixed(1)}%</span>
      <span className="cost-hero-row-tokens">{(p.tokens / 1e9).toFixed(2)}B tokens</span>
    </div>
  );
}

function labelFor(p: string): string {
  // Harness agent ids: "harness:claude_code" / "claude_code" → "Claude Code".
  // Handle the known set explicitly, then fall back to a generic
  // underscore→space transform so any future harness id stays legible.
  if (p === "harness:claude_code" || p === "claude_code") return "Claude Code";
  if (p === "harness:kimi_code" || p === "kimi_code") return "Kimi Code";
  if (p === "harness:opencode" || p === "opencode") return "OpenCode";
  // API providers: "chat:anthropic" → "Anthropic"
  if (p.startsWith("chat:")) return p.slice(5);
  // Other harness-prefixed / bare snake_case ids: strip prefix, underscores→spaces.
  if (p.startsWith("harness:")) p = p.slice(8);
  if (p.includes("_")) {
    return p.replace(/_/g, " ");
  }
  return p;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
