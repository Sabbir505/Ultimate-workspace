import type { CostByKind } from "../../types";

export function StatsRow({ byKind, cacheSavingsUsd }: { byKind: CostByKind; cacheSavingsUsd: number }) {
  return (
    <div className="stats-row">
      <Stat label="Processed" value={fmt(byKind.processedTokens)} sub="tokens" />
      <Stat label="Cached input" value={fmt(byKind.cachedInputTokens)} sub={`${pct(byKind.cachedInputTokens, byKind.processedTokens)}% of input`} />
      <Stat label="Uncached input" value={fmt(byKind.uncachedInputTokens)} sub="tokens" />
      <Stat label="Output" value={fmt(byKind.outputTokens)} sub={`${fmt(byKind.reasoningTokens)} reasoning`} />
      <Stat label="Responses" value={byKind.responses.toLocaleString()} sub={`${byKind.sessions} sessions`} />
      <Stat label="Cache savings" value={`$${cacheSavingsUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} sub="cumulative" accent />
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? "stat-accent" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
}
function pct(part: number, whole: number): string {
  return whole > 0 ? ((part / whole) * 100).toFixed(1) : "0.0";
}
