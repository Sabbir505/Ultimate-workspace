import { useState } from "react";
import type { CostRollups } from "../../types";

type Mode = "cost" | "tokens";

export function DailyChart({ rollups }: { rollups: CostRollups }) {
  const [mode, setMode] = useState<Mode>("cost");
  const data = rollups.daily;
  if (data.length === 0) {
    return <div className="empty-reserved">No usage in this range.</div>;
  }
  const maxCost = Math.max(...data.map(d => d.costUsd), 0.01);
  const maxTokens = Math.max(...data.map(d => sumTokens(d.tokensByProvider)), 1);
  const barWidth = 18; const gap = 6; const height = 80;
  const totalW = data.length * (barWidth + gap);
  return (
    <div className="cost-chart">
      <div className="chart-toggle">
        <button className={`ghost ${mode === "cost" ? "active" : ""}`} onClick={() => setMode("cost")}>Cost</button>
        <button className={`ghost ${mode === "tokens" ? "active" : ""}`} onClick={() => setMode("tokens")}>Tokens</button>
      </div>
      <svg className="chart daily-chart" width={totalW} height={height + 26} role="img"
           aria-label={`Daily ${mode} chart`}>
        {data.map((d, i) => {
          const value = mode === "cost" ? d.costUsd : sumTokens(d.tokensByProvider);
          const max = mode === "cost" ? maxCost : maxTokens;
          const h = Math.max(2, (value / max) * height);
          const x = i * (barWidth + gap);
          return (
            <g key={d.day}>
              <rect className="bar" x={x} y={height - h} width={barWidth} height={h} rx={2} />
              <text className="bar-label" x={x + barWidth / 2} y={height + 14} textAnchor="middle">{d.day.slice(5)}</text>
            </g>
          );
        })}
      </svg>
      <table className="visually-hidden">
        <caption>Daily {mode}</caption>
        <thead><tr><th>Day</th><th>Value</th></tr></thead>
        <tbody>{data.map(d => <tr key={d.day}><td>{d.day}</td><td>{mode === "cost" ? d.costUsd : sumTokens(d.tokensByProvider)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function sumTokens(t: Record<string, number>): number {
  return Object.values(t).reduce((a, b) => a + b, 0);
}
