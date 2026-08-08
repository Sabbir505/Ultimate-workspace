import type { CostQuality } from "../../types";

export function CostQualityPanel({ q, cacheSavingsUsd }: { q: CostQuality; cacheSavingsUsd: number }) {
  return (
    <div className="cost-quality">
      <h3>Cost quality</h3>
      <Bar label="Provider reported" pct={q.providerReportedPct} />
      <Bar label="Model priced" pct={q.modelPricedPct} />
      <Bar label="Unpriced" pct={q.unpricedPct} />
      <div className="cost-quality-savings">
        <span className="cost-quality-savings-label">Cache savings</span>
        <span className="cost-quality-savings-value">${cacheSavingsUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
      </div>
    </div>
  );
}

function Bar({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="cost-quality-bar">
      <div className="cost-quality-bar-label">{label}</div>
      <div className="cost-quality-bar-track"><div className="cost-quality-bar-fill" style={{ width: `${pct}%` }} /></div>
      <div className="cost-quality-bar-pct">{pct.toFixed(1)}%</div>
    </div>
  );
}
