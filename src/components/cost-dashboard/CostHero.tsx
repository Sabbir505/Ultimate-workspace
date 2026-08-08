import type { CostRollups, ProviderCostRollup } from "../../types";

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function CostHero({ rollups }: { rollups: CostRollups }) {
  const { totals, perProvider, rangeStart, rangeEnd } = rollups;
  return (
    <section className="cost-hero">
      <div className="cost-hero-headline">
        <div className="cost-hero-label">RAW TOKEN COST</div>
        <div className="cost-hero-value">{usd(totals.rawTokenCostUsd)}</div>
        <div className="cost-hero-range">{formatDate(rangeStart)} to {formatDate(rangeEnd)}</div>
      </div>
      <div className="cost-hero-breakdown">
        {perProvider.map(p => <ProviderRow key={p.provider} p={p} total={totals.rawTokenCostUsd} />)}
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
  if (p === "claude_code") return "Claude Code";
  if (p === "kimi_code") return "Kimi Code";
  if (p === "opencode") return "OpenCode";
  if (p.startsWith("chat:")) return "Chat: " + p.slice(5);
  return p;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
