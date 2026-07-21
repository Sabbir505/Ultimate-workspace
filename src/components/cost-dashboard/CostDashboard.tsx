// Cost dashboard (§7.12): per-project totals and a daily spend chart over the
// get_cost_rollups aggregate. Charts are tiny hand-rolled SVG bars — no chart
// dependency (noted as a deliberate choice in BUILD_LOG). Everything is
// labelled an estimate, per the PRD.
import { useEffect, useState } from "react";
import { getCostRollups, safeListen } from "../../lib/ipc";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";
import type { CostRollups, CostUpdatedPayload } from "../../types";

function usd(n: number): string {
  // 5 decimal places so small per-session costs are visible; whole-dollar
  // amounts stay readable.
  return `$${n.toFixed(n >= 10 ? 2 : 5)}`;
}

function BarChart({
  data,
  height = 140,
}: {
  data: Array<{ label: string; value: number }>;
  height?: number;
}) {
  if (data.length === 0) {
    return (
      <div className="empty-reserved" style={{ minHeight: 160, height: 160 }}>
        <span className="empty-icon">📊</span>
        <span className="empty-text">No spend recorded yet — bars appear as harnesses report usage.</span>
      </div>
    );
  }
  const max = Math.max(...data.map((d) => d.value), 0.0001);
  const barWidth = 28;
  const gap = 10;
  const labelHeight = 26;
  const width = data.length * (barWidth + gap);
  return (
    <svg className="chart" width={width} height={height + labelHeight} role="img">
      {data.map((d, i) => {
        const barHeight = Math.max(2, (d.value / max) * height);
        const x = i * (barWidth + gap);
        const y = height - barHeight;
        return (
          <g key={d.label}>
            <rect className="bar" x={x} y={y} width={barWidth} height={barHeight} rx={3} />
            <text className="bar-value" x={x + barWidth / 2} y={y - 4} textAnchor="middle">
              {usd(d.value)}
            </text>
            <text className="bar-label" x={x + barWidth / 2} y={height + 14} textAnchor="middle">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function CostDashboard() {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const projects = useProjectsStore((s) => s.projects);
  const [rollups, setRollups] = useState<CostRollups | null>(null);

  useEffect(() => {
    const load = () => void getCostRollups().then((r) => r && setRollups(r));
    load();
    // Refetch whenever the backend parses a new usage event.
    const unlisten = safeListen<CostUpdatedPayload>("cost:updated", load);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id.slice(0, 6);
  const daily = (rollups?.daily ?? []).slice(-14); // last two weeks
  const totalAll = (rollups?.perProject ?? []).reduce((sum, p) => sum + p.totalCostUsd, 0);

  return (
    <div className="view-overlay modal-centered" onPointerDown={(e) => e.target === e.currentTarget && setActiveView("grid")}>
      <div className="view-panel">
        <div className="view-header">
          <h2>Cost Dashboard</h2>
          <button className="ghost" onClick={() => setActiveView("grid")}>
            ✕
          </button>
        </div>
        <div className="view-body">
          <p className="estimate-note">
            All figures are best-effort estimates parsed from harness output; actual billing may
            differ.
          </p>

          <section className="cost-section">
            <h3>Daily spend (all projects, last 14 days)</h3>
            <div className="cost-chart-frame">
              <BarChart data={daily.map((d) => ({ label: d.day.slice(5), value: d.costUsd }))} />
            </div>
          </section>

          <section className="cost-section">
            <h3>Per-project totals</h3>
            {rollups && rollups.perProject.length > 0 ? (
              <table className="kv">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Input tokens</th>
                    <th>Output tokens</th>
                    <th>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rollups.perProject.map((row) => (
                    <tr key={row.projectId}>
                      <td>{projectName(row.projectId)}</td>
                      <td className="mono">{row.totalInputTokens.toLocaleString()}</td>
                      <td className="mono">{row.totalOutputTokens.toLocaleString()}</td>
                      <td className="mono">{usd(row.totalCostUsd)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ fontWeight: 600 }}>Total</td>
                    <td></td>
                    <td></td>
                    <td className="mono" style={{ fontWeight: 600 }}>
                      {usd(totalAll)}
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <div className="empty-reserved">
                <span className="empty-icon">📭</span>
                <span className="empty-text">
                  No cost events recorded yet — they appear as harnesses report usage.
                </span>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
