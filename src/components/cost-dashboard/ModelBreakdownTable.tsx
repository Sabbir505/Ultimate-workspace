import type { ModelCostRollup } from "../../types";

/** Human-readable label for a model key in the breakdown table. */
function modelLabel(key: string): string {
  // Strip "harness:" prefix, convert snake_case to spaces, and title-case.
  // Handles both "harness:claude_code" and a bare "claude_code" (which can
  // appear when a harness row's model key falls back to the harness id).
  const cleaned = key.replace(/^harness:/, "").replace(/_/g, " ").trim();
  if (cleaned !== key) {
    return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // API models: just show the model id (e.g. "claude-sonnet-4-5").
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
