import { useMemo, useRef, useState } from "react";
import type { CostRollups, DailyCost } from "../../types";

type Mode = "cost" | "tokens";

// Fixed categorical hue order (validated palette, dataviz skill) — assigned
// by provider identity, never by rank, so filtering never repaints survivors.
const SERIES_ORDER = [
  "claude_code",
  "kimi_code",
  "opencode",
  "chat:anthropic",
  "chat:openai",
  "chat:openrouter",
  "chat:local_gguf",
  "other", // everything else folds in here (never a 9th generated hue)
];

function seriesLabel(p: string): string {
  switch (p) {
    case "claude_code": return "Claude Code";
    case "kimi_code": return "Kimi";
    case "opencode": return "OpenCode";
    // "chat:anthropic" → "Anthropic" etc. — the prefix is a grouping artifact.
    case "chat:anthropic": return "Anthropic";
    case "chat:openai": return "OpenAI";
    case "chat:openrouter": return "OpenRouter";
    case "chat:local_gguf": return "Local GGUF";
  }
  // Generic fallback: strip grouping prefixes + convert snake_case to spaces
  // so any harness id reads "claude code" instead of "claude_code".
  let out = p === "other" ? "Other" : p.startsWith("chat:") ? p.slice(5) : p;
  if (out.startsWith("harness:")) out = out.slice(8);
  return out.replace(/_/g, " ");
}

function dayValue(d: DailyCost, mode: Mode, p: string): number {
  const m = mode === "cost" ? d.costByProvider : d.tokensByProvider;
  return m[p] ?? 0;
}

// Normalize compatible providers into their native buckets so
// "chat:anthropic_compatible" stacks under Anthropic (same wire family).
function normalizeProvider(p: string): string {
  if (p === "chat:anthropic_compatible" || p === "chat:anthropic") return "chat:anthropic";
  if (p === "chat:openai_compatible" || p === "chat:openai") return "chat:openai";
  return p;
}

export function DailyChart({ rollups }: { rollups: CostRollups }) {
  const [mode, setMode] = useState<Mode>("cost");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);

  const data = rollups.daily;

  const { series, stacked } = useMemo(() => {
    if (data.length === 0) return { series: [] as string[], stacked: [] as number[][] };
    // Collect the providers actually present, in the fixed hue order.
    const present = new Set<string>();
    for (const d of data) {
      const m = mode === "cost" ? d.costByProvider : d.tokensByProvider;
      for (const p of Object.keys(m)) present.add(normalizeProvider(p));
    }
    const ordered = SERIES_ORDER.filter(p => present.has(p));
    const others = [...present].filter(p => !SERIES_ORDER.includes(p)).sort();
    const series = [...ordered, ...(others.length ? ["other" as string] : [])];
    // Per-day cumulative top per series (stacked bottom→top in series order).
    const stacked = data.map(d => {
      const tops: number[] = [];
      let acc = 0;
      for (const p of series) {
        const v = p === "other"
          ? Object.entries(mode === "cost" ? d.costByProvider : d.tokensByProvider)
              .filter(([o]) => !SERIES_ORDER.includes(normalizeProvider(o)))
              .reduce((s, [, v]) => s + v, 0)
          : Object.entries(mode === "cost" ? d.costByProvider : d.tokensByProvider)
              .filter(([o]) => normalizeProvider(o) === p)
              .reduce((s, [, v]) => s + v, 0);
        acc += v;
        tops.push(acc);
      }
      return tops;
    });
    return { series, stacked };
  }, [data, mode]);

  const height = 170;
  const barW = 28;
  const gap = 6;
  const step = barW + gap;
  const totalW = Math.max(data.length * step, 100);
  const maxTotal = Math.max(...stacked.map(t => t[t.length - 1] ?? 0), 1);
  const y = (v: number) => height - (v / maxTotal) * height;

  const fmt = mode === "cost" ? fmtUsd : fmtTokens;

  if (data.length === 0) {
    return <div className="cost-chart empty-reserved">No usage in this range.</div>;
  }

  // Stacked area path for one series: top edge from its cumulative tops,
  // bottom edge = previous series' tops (or baseline).
  const areaPath = (sIdx: number, dIdxStart: number, dIdxEnd: number) => {
    const top = stacked.map((tops, i) => [i, tops[sIdx]] as const);
    const bot = sIdx === 0 ? top.map(([i]) => [i, 0] as const) : stacked.map((tops, i) => [i, tops[sIdx - 1]] as const);
    const x = (i: number) => i * step + barW / 2;
    let d = `M ${x(dIdxStart)} ${y(bot[dIdxStart][1])}`;
    for (const [i, v] of top) d += ` L ${x(i)} ${y(v)}`;
    for (let i = bot.length - 1; i >= 0; i--) d += ` L ${x(bot[i][0])} ${y(bot[i][1])}`;
    d += " Z";
    return d;
  };

  const hovered = hoverIdx !== null ? data[hoverIdx] : null;

  return (
    <div className="cost-chart">
      <div className="chart-toggle">
        <button className={`ghost ${mode === "cost" ? "active" : ""}`} onClick={() => setMode("cost")}>Cost</button>
        <button className={`ghost ${mode === "tokens" ? "active" : ""}`} onClick={() => setMode("tokens")}>Tokens</button>
      </div>

      <div className="chart-frame" ref={frameRef} onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}>
        <svg className="chart daily-chart" width={totalW} height={height + 24} role="img"
             aria-label={`Daily ${mode} by provider, stacked area chart`}>
          {/* Recessive gridlines */}
          {[0.25, 0.5, 0.75, 1].map(f => (
            <line key={f} className="gridline" x1={0} x2={totalW} y1={y(maxTotal * f)} y2={y(maxTotal * f)} />
          ))}
          {/* Stacked areas, bottom series first */}
          {series.map((p, sIdx) => (
            <path key={p} className="area"
                  style={{ ["--series" as string]: `var(--series-${sIdx + 1}, var(--series-other))` }}
                  d={areaPath(sIdx, 0, data.length - 1)} />
          ))}
          {/* Crosshair on the hovered day */}
          {hoverIdx !== null && (
            <line className="crosshair" x1={hoverIdx * step + barW / 2} x2={hoverIdx * step + barW / 2} y1={0} y2={height} />
          )}
          {/* Day labels + hover hit targets (full column height) */}
          {data.map((d, i) => (
            <g key={d.day}>
              <rect className="hit-target" x={i * step} y={0} width={step} height={height}
                    onMouseEnter={() => setHoverIdx(i)}
                    onMouseLeave={() => setHoverIdx(null)} />
              <text className="bar-label" x={i * step + barW / 2} y={height + 16} textAnchor="middle">
                {d.day.slice(5)}
              </text>
            </g>
          ))}
        </svg>

        {/* Hover tooltip: absolute inside the chart-frame (which is
            position: relative) so left/top resolve in the chart's own
            coordinate space and the tooltip sits over the hovered bar,
            not over the RAW TOKEN COST hero. */}
        {hovered && (
          <div className="chart-tooltip" style={{
            left: `min(${hoverIdx! * step + barW / 2 - scrollLeft}px, calc(100% - 150px))`,
          }}>
            <div className="chart-tooltip-day">{hovered.day}</div>
            {series.map((p, sIdx) => {
              const v = p === "other"
                ? Object.entries(mode === "cost" ? hovered.costByProvider : hovered.tokensByProvider)
                    .filter(([o]) => !SERIES_ORDER.includes(normalizeProvider(o)))
                    .reduce((s, [, v]) => s + v, 0)
                : Object.entries(mode === "cost" ? hovered.costByProvider : hovered.tokensByProvider)
                    .filter(([o]) => normalizeProvider(o) === p)
                    .reduce((s, [, v]) => s + v, 0);
              if (v <= 0) return null;
              return (
                <div key={p} className="chart-tooltip-row">
                  <span className="chart-tooltip-swatch" style={{ background: `var(--series-${sIdx + 1}, var(--series-other))` }} />
                  <span className="chart-tooltip-name">{seriesLabel(p)}</span>
                  <span className="chart-tooltip-value">{fmt(v)}</span>
                </div>
              );
            })}
            <div className="chart-tooltip-total">
              <span>Total</span>
              <span className="chart-tooltip-value">{fmt(mode === "cost" ? hovered.costUsd : sumTokens(hovered.tokensByProvider))}</span>
            </div>
          </div>
        )}
      </div>

      {/* Legend — required for ≥2 series; text in text tokens, swatch carries identity */}
      {series.length >= 2 && (
        <div className="chart-legend">
          {series.map((p, sIdx) => (
            <div key={p} className="chart-legend-item">
              <span className="chart-legend-swatch" style={{ background: `var(--series-${sIdx + 1}, var(--series-other))` }} />
              <span className="chart-legend-label">{seriesLabel(p)}</span>
            </div>
          ))}
        </div>
      )}

      <table className="visually-hidden">
        <caption>Daily {mode} by provider</caption>
        <thead><tr><th>Day</th><th>Provider</th><th>Value</th></tr></thead>
        <tbody>
          {data.map(d => {
            const m = mode === "cost" ? d.costByProvider : d.tokensByProvider;
            return Object.entries(m).map(([p, v]) => (
              <tr key={`${d.day}-${p}`}><td>{d.day}</td><td>{p}</td><td>{v}</td></tr>
            ));
          })}
        </tbody>
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
