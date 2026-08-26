import { useState } from "react";
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

type SortField = "costUsd" | "tokens" | "sharePct";
type SortDirection = "asc" | "desc";

export function ModelBreakdownTable({ rows }: { rows: ModelCostRollup[] }) {
  const [sortField, setSortField] = useState<SortField>("costUsd");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");

  const sortedRows = [...rows].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];
    return sortDir === "desc" ? bVal - aVal : aVal - bVal;
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "desc" ? "asc" : "desc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const sortIcon = (field: SortField) => {
    if (sortField !== field) return null;
    return sortDir === "desc" ? "↓" : "↑";
  };

  if (rows.length === 0) {
    return <div className="empty-reserved">No model breakdown in this range.</div>;
  }
  return (
    <div className="model-breakdown">
      <h3>Model breakdown</h3>
      <table className="kv">
        <thead>
          <tr>
            <th>Model</th>
            <th onClick={() => handleSort("costUsd")} style={{ cursor: "pointer" }}>
              Cost {sortIcon("costUsd")}
            </th>
            <th onClick={() => handleSort("sharePct")} style={{ cursor: "pointer" }}>
              Share {sortIcon("sharePct")}
            </th>
            <th onClick={() => handleSort("tokens")} style={{ cursor: "pointer" }}>
              Tokens {sortIcon("tokens")}
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map(r => (
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
