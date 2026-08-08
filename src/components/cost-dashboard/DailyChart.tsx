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
  const barWidth = 26; const gap = 10; const height = 120;
  const labelH = 26;
  const totalW = data.length * (barWidth + gap);
  return (
    <div className="cost-chart">
      <div className="chart-toggle">
        <button className={`ghost ${mode === "cost" ? "active" : ""}`} onClick={() => setMode("cost")}>Cost</button>
        <button className={`ghost ${mode === "tokens" ? "active" : ""}`} onClick={() => setMode("tokens")}>Tokens</button>
      </div>
      <div className="chart-frame">
        <svg className="chart daily-chart" width={Math.max(totalW, 100)} height={height + labelH} role="img"
             aria-label={`Daily ${mode} chart`}>
          {data.map((d, i) => {
            const value = mode === "cost" ? d.costUsd : sumTokens(d.tokensByProvider);
            const max = mode === "cost" ? maxCost : maxTokens;
            const h = Math.max(3, (value / max) * height);
            const x = i * (barWidth + gap);
            return (
              <g key={d.day}>
                <rect className="bar" x={x} y={height - h} width={barWidth} height={h} rx={3} />
                <text className="bar-value" x={x + barWidth / 2} y={h > 18 ? height - h + 12 : height - h - 6} textAnchor="middle">
                  {mode === "cost" ? fmtUsd(value) : fmtTokens(value)}
                </text>
                <text className="bar-label" x={x + barWidth / 2} y={height + 15} textAnchor="middle">{d.day.slice(5)}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <table className="visually-hidden">
        <caption>Daily {mode}</caption>
        <thead><tr><th>Day</th><th>Value</th></tr></thead>
        <tbody>{data.map(d => <tr key={d.day}><td>{d.day}</td><td>{mode === "cost" ? d.costUsd : sumTokens(d.tokensByProvider)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 10) return `$${n.toFixed(0)}`;
  if (n > 0) return `$${n.toFixed(2)}`;
  return "$0";
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}

function sumTokens(t: Record<string, number>): number {
  return Object.values(t).reduce((a, b) => a + b, 0);
}
