// Cost dashboard (§7.12): per-project totals and a daily spend chart over the
// get_cost_rollups aggregate. Charts are tiny hand-rolled SVG bars — no chart
// dependency (noted as a deliberate choice in BUILD_LOG). Everything is
// labelled an estimate, per the PRD.
import { useEffect, useState } from "react";
import { getCostRollups, getChatMessages, listChatSessions, safeListen, type ChatSession, type ChatMessageRecord } from "../../lib/ipc";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";
import type { CostRollups, CostUpdatedPayload } from "../../types";

function usd(n: number): string {
  // 5 decimal places so small per-session costs are visible; whole-dollar
  // amounts stay readable.
  return `$${n.toFixed(n >= 10 ? 2 : 5)}`;
}

function tokens(n: number): string {
  return n.toLocaleString();
}

// Distinct warm palette for local model bars — cycles through if more models
// than colors. Each model gets a stable color based on its index.
const MODEL_COLORS = [
  "#C15F3C", // terracotta (accent)
  "#D4A574", // warm sand
  "#8B9A6B", // sage green
  "#A67B5B", // warm brown
  "#6B8E9F", // steel blue
  "#C4A77D", // camel
  "#7D6B5D", // warm gray
  "#B8A07A", // beige
];

function ModelBarChart({
  data,
  height = 120,
}: {
  data: Array<{ label: string; value: number; color: string }>;
  height?: number;
}) {
  if (data.length === 0) {
    return (
      <div className="empty-reserved" style={{ minHeight: 140, height: 140 }}>
        <span className="empty-icon">📊</span>
        <span className="empty-text">No local model usage yet.</span>
      </div>
    );
  }
  const max = Math.max(...data.map((d) => d.value), 1);
  const barWidth = 36;
  const gap = 14;
  const width = data.length * (barWidth + gap);
  const svgHeight = height + 4;
  return (
    <svg className="chart model-chart" width={width} height={svgHeight} role="img">
      {data.map((d) => {
        const barHeight = Math.max(4, (d.value / max) * height);
        const x = data.indexOf(d) * (barWidth + gap);
        const y = height - barHeight;
        return (
          <g key={d.label}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              rx={4}
              fill={d.color}
              opacity={0.85}
            />
            {/* Token count inside or above bar */}
            <text
              x={x + barWidth / 2}
              y={barHeight > 20 ? y + 14 : y - 6}
              textAnchor="middle"
              fill={barHeight > 20 ? "#fff" : "var(--text)"}
              fontSize={10}
              fontWeight={600}
            >
              {d.value >= 1000 ? `${(d.value / 1000).toFixed(1)}k` : d.value.toString()}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ModelLegend({
  items,
}: {
  items: Array<{ label: string; color: string }>;
}) {
  return (
    <div className="model-legend">
      {items.map((item) => (
        <div key={item.label} className="model-legend-item">
          <span className="model-legend-swatch" style={{ background: item.color }} />
          <span className="model-legend-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
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

/** Aggregate local-model usage by fetching all chat sessions, filtering to
 *  local_gguf, then pulling messages and summing tokens per model. */
async function fetchLocalModelUsage(): Promise<
  Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    messageCount: number;
    lastUsed: string;
  }>
> {
  const sessions = await listChatSessions();
  if (!sessions) return [];
  const localSessions = sessions.filter((s) => s.provider === "local_gguf");
  if (localSessions.length === 0) return [];

  // Fetch messages for each local session and aggregate
  const byModel = new Map<
    string,
    { inputTokens: number; outputTokens: number; messageCount: number; lastUsed: number }
  >();

  await Promise.all(
    localSessions.map(async (session) => {
      const messages = await getChatMessages(session.id);
      if (!messages) return;
      for (const m of messages) {
        if (m.role !== "assistant") continue; // only assistant messages have usage
        const model = session.model || "Unknown";
        const existing = byModel.get(model) ?? {
          inputTokens: 0,
          outputTokens: 0,
          messageCount: 0,
          lastUsed: 0,
        };
        existing.inputTokens += m.inputTokens ?? 0;
        existing.outputTokens += m.outputTokens ?? 0;
        existing.messageCount += 1;
        if (m.createdAt > existing.lastUsed) existing.lastUsed = m.createdAt;
        byModel.set(model, existing);
      }
    }),
  );

  return Array.from(byModel.entries())
    .map(([model, stats]) => ({
      model,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      messageCount: stats.messageCount,
      lastUsed: new Date(stats.lastUsed).toISOString().split("T")[0],
    }))
    .sort((a, b) => b.messageCount - a.messageCount);
}

export function CostDashboard() {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const projects = useProjectsStore((s) => s.projects);
  const [rollups, setRollups] = useState<CostRollups | null>(null);
  const [localUsage, setLocalUsage] = useState<
    Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      messageCount: number;
      lastUsed: string;
    }>
  >([]);

  useEffect(() => {
    const load = () => void getCostRollups().then((r) => r && setRollups(r));
    load();
    // Refetch whenever the backend parses a new usage event.
    const unlisten = safeListen<CostUpdatedPayload>("cost:updated", load);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    void fetchLocalModelUsage().then((u) => setLocalUsage(u));
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

          {/* Local model usage section */}
          <section className="cost-section">
            <h3>Local model usage</h3>
            {localUsage.length > 0 ? (
              <>
                <div className="cost-chart-frame">
                  <ModelBarChart
                    data={localUsage.map((u, i) => ({
                      label: u.model.length > 18 ? u.model.slice(0, 15) + "…" : u.model,
                      value: u.inputTokens + u.outputTokens,
                      color: MODEL_COLORS[i % MODEL_COLORS.length],
                    }))}
                    height={120}
                  />
                </div>
                <ModelLegend
                  items={localUsage.map((u, i) => ({
                    label: u.model.length > 24 ? u.model.slice(0, 21) + "…" : u.model,
                    color: MODEL_COLORS[i % MODEL_COLORS.length],
                  }))}
                />
                <table className="kv" style={{ marginTop: 16, marginBottom: 40 }}>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Messages</th>
                      <th>Input tokens</th>
                      <th>Output tokens</th>
                      <th>Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {localUsage.map((row) => (
                      <tr key={row.model}>
                        <td style={{ fontWeight: 500 }}>{row.model}</td>
                        <td className="mono">{row.messageCount}</td>
                        <td className="mono">{tokens(row.inputTokens)}</td>
                        <td className="mono">{tokens(row.outputTokens)}</td>
                        <td className="mono">{row.lastUsed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <div className="empty-reserved">
                <span className="empty-icon">🤖</span>
                <span className="empty-text">
                  No local model usage yet — chat with a local GGUF model to see stats here.
                </span>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
