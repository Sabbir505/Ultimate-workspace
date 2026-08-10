import type { ModelCostRollup } from "../../types";

/** Human-readable label for a model key in the breakdown table. */
function modelLabel(key: string): string {
  // Strip "harness:" prefix and capitalize
  if (key.startsWith("harness:")) {
    return key.slice(8).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // API models: just show the model id
  return key;
}

export function ModelBreakdownTable({ rows }: { rows: ModelCostRollup[] }) {
  if (rows.length === 0) {
    return <div className="empty-reserved">No model breakdown in this range.</div>;
  }
  return (
    <div className="model-breakdown">
      <h3>Model breakdown</h3>
      <table className="kv">
        <thead>
          <tr><th>Model</th><th>Cost</th><th>Share</th><th>Tokens</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.modelKey}>
              <td>{modelLabel(r.displayName)}</td>
              <td className="mono">${r.costUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 })}</td>
              <td className="mono">{r.sharePct.toFixed(1)}%</td>
              <td className="mono">{r.tokens.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
