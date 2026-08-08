import type { ModelCostRollup } from "../../types";

export function ModelBreakdownTable({ rows }: { rows: ModelCostRollup[] }) {
  if (rows.length === 0) {
    return <div className="empty-reserved">No model breakdown in this range.</div>;
  }
  return (
    <table className="kv">
      <thead>
        <tr><th>Model</th><th>Cost</th><th>Share</th><th>Tokens</th></tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.modelKey}>
            <td>{r.displayName}</td>
            <td className="mono">${r.costUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 })}</td>
            <td className="mono">{r.sharePct.toFixed(1)}%</td>
            <td className="mono">{r.tokens.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
