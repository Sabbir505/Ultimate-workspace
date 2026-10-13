// VizCard — the native rendering surface for the `visualize` tool's
// structured payloads. Unlike WidgetFrame (the model-authored-HTML escape
// hatch), NOTHING here is model code: the payload is validated data
// (src/lib/viz.ts, mirroring build_viz_payload in the backend) and every
// renderer is a Relay component styled from the app's own CSS variables —
// natively on-theme, no iframe, no bridge, no sanitization concerns.
import { useContext, useMemo, useState, type ReactNode } from "react";
import { createContext } from "react";
import {
  parseVizPayload,
  vizToCsv,
  type VizChart,
  type VizDivider,
  type VizDonut,
  type VizLine,
  type VizPayload,
  type VizProse,
  type VizStack,
  type VizStat,
  type VizStyle,
} from "../../../lib/viz";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import type { ChatArtifact } from "../../../state/chat";
import type { ChatSource } from "../../../lib/chatCitations";
// The chat's own markdown renderer — reused (not reimplemented) so a prose
// section carries the same code highlighting, KaTeX math, citation chips and
// XSS posture as the answer body.
import { Markdown } from "../ActivitySteps";

/** The palette a container stack can pass down (see styleVars). Charts index it
 *  modulo its length, so a stack's own colours reach every section that has
 *  not chosen its own. */
const MAX_VIZ_PALETTE = 8;

/** The renderer registry: presentation kind → Relay's own component.
 *  The model can only request kinds this table knows; anything else (and any
 *  malformed payload) falls back to an explicit unavailable note. */
const vizRenderers: Record<string, ((payload: VizPayload) => ReactNode) | undefined> = {
  chart: (p) => (p.kind === "chart" ? <ChartRenderer payload={p} /> : null),
  table: (p) => (p.kind === "table" ? <TableRenderer payload={p} /> : null),
  "task-board": (p) => (p.kind === "task-board" ? <TaskBoardRenderer payload={p} /> : null),
  timeline: (p) => (p.kind === "timeline" ? <TimelineRenderer payload={p} /> : null),
  line: (p) => (p.kind === "line" ? <LineRenderer payload={p} /> : null),
  donut: (p) => (p.kind === "donut" ? <DonutRenderer payload={p} /> : null),
  stat: (p) => (p.kind === "stat" ? <StatRenderer payload={p} /> : null),
  stack: (p) => (p.kind === "stack" ? <StackRenderer payload={p} /> : null),
  prose: (p) => (p.kind === "prose" ? <ProseRenderer payload={p} /> : null),
  divider: (p) => (p.kind === "divider" ? <DividerRenderer payload={p} /> : null),};

/** Map the agent's style to scoped CSS custom properties on the card root.
 *  Unset fields fall back to the app theme inside the stylesheet — the
 *  agent layers creativity ON TOP of the design system, never instead of it. */
function styleVars(style: VizStyle | null): Record<string, string> {
  const vars: Record<string, string> = {};
  if (style?.accent) vars["--viz-accent"] = style.accent;
  if (style?.palette) {
    style.palette.forEach((c, i) => {
      vars[`--viz-c${i + 1}`] = c;
    });
  }
  if (style?.tone === "light") {
    vars["--viz-bg"] = "#ffffff";
    vars["--viz-fg"] = "#1c1c1c";
    vars["--viz-dim"] = "#6f6f6e";
    vars["--viz-border"] = "#dcdcdb";
  }
  if (style?.tone === "dark") {
    vars["--viz-bg"] = "#181818";
    vars["--viz-fg"] = "#e8e8e8";
    vars["--viz-dim"] = "#9a9a9a";
    vars["--viz-border"] = "#333333";
  }
  if (style?.radius === "sharp") vars["--viz-radius"] = "2px";
  if (style?.radius === "pill") vars["--viz-radius"] = "18px";
  return vars;
}

// ---- Chart: CSS bars on a TRUE zero baseline (positives grow up from the
// zero line, negatives hang below it) ----

function ChartRenderer({ payload }: { payload: VizChart }) {
  const max = Math.max(...payload.bars.map((b) => b.value), 0);
  const min = Math.min(...payload.bars.map((b) => b.value), 0);
  const range = max - min || 1;
  // The zero line's offset from the plot top, in % of the plot height.
  const zeroPct = (max / range) * 100;
  const showValues = payload.bars.length <= 12;
  // With many bars, label every Nth so they stay readable at chat width.
  const labelEvery = payload.bars.length > 24 ? 4 : payload.bars.length > 12 ? 2 : 1;
  const fmt = (v: number) => {
    const s = Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : String(Math.round(v * 100) / 100);
    return payload.unit ? `${s} ${payload.unit}` : s;
  };
  const barColor = (i: number) =>
    payload.style?.palette?.[i % payload.style.palette.length] ??
    // Fall through to the CSS custom properties a CONTAINER stack sets on the
    // card root, so a stack's palette reaches every section that does not
    // choose its own (same chain as the donut's segColor below).
    `var(--viz-c${(i % MAX_VIZ_PALETTE) + 1}, var(--viz-accent, var(--accent)))`;
  return (
    <div className="chat-viz-chart" data-testid="viz-chart">
      <div
        className="chat-viz-chart-plot"
        role="img"
        aria-label={`Bar chart, ${payload.bars.length} item${payload.bars.length === 1 ? "" : "s"}: ${payload.bars
          .map((b) => `${b.label} ${fmt(b.value)}`)
          .join(", ")}`}
      >
        <div className="chat-viz-chart-zero" style={{ top: `${zeroPct}%` }} />
        {payload.bars.map((bar, i) => {
          // The bar hangs from its TOP edge: positives start at their value's
          // offset above the zero line, negatives start AT the zero line.
          const topPct = ((max - Math.max(bar.value, 0)) / range) * 100;
          const hPct = (Math.abs(bar.value) / range) * 100;
          const negative = bar.value < 0;
          return (
            <div className="chat-viz-chart-slot" key={`${bar.label}-${i}`}>
              <div className="chat-viz-chart-barwrap">
                {showValues && (
                  <span
                    className={`chat-viz-chart-val${negative ? " neg" : ""}`}
                    style={{
                      top: negative
                        ? `calc(${Math.min(topPct + hPct, 100)}% + 3px)`
                        : `calc(${topPct}% - 15px)`,
                    }}
                  >
                    {fmt(bar.value)}
                  </span>
                )}
                <div
                  className={`chat-viz-chart-bar${negative ? " neg" : ""}`}
                  style={{
                    top: `${topPct}%`,
                    height: `${Math.max(hPct, 0.75)}%`,
                    background: negative ? undefined : barColor(i),
                  }}
                  title={`${bar.label}: ${fmt(bar.value)}`}
                />
              </div>
              {i % labelEvery === 0 ? (
                <span className="chat-viz-chart-label" title={bar.label}>
                  {bar.label}
                </span>
              ) : (
                <span className="chat-viz-chart-label" aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Table ----

function TableRenderer({ payload }: { payload: Extract<VizPayload, { kind: "table" }> }) {
  return (
    <div className="chat-viz-tablewrap" data-testid="viz-table">
      <table className="chat-viz-table">
        <thead>
          <tr>
            {payload.columns.map((col, i) => (
              <th key={i} style={{ textAlign: col.align }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {payload.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} style={{ textAlign: payload.columns[c]?.align ?? "left" }}>
                  {cell === "" ? "\u00A0" : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Task board (kanban columns) ----

function TaskBoardRenderer({ payload }: { payload: Extract<VizPayload, { kind: "task-board" }> }) {
  return (
    <div className="chat-viz-board" data-testid="viz-board">
      {payload.columns.map((col, i) => (
        <div className="chat-viz-board-col" key={i}>
          <div className="chat-viz-board-colhead">
            <span className="chat-viz-board-coltitle">{col.title}</span>
            <span className="chat-viz-board-count">{col.tasks.length}</span>
          </div>
          {col.tasks.map((task, t) => (
            <div className="chat-viz-task" key={t}>
              <span className="chat-viz-task-title">{task.title}</span>
              {task.meta && <span className="chat-viz-task-meta">{task.meta}</span>}
            </div>
          ))}
          {col.tasks.length === 0 && <div className="chat-viz-board-empty">No tasks</div>}
        </div>
      ))}
    </div>
  );
}

// ---- Timeline (vertical rail) ----

function TimelineRenderer({ payload }: { payload: Extract<VizPayload, { kind: "timeline" }> }) {
  return (
    <div className="chat-viz-timeline" data-testid="viz-timeline">
      {payload.events.map((ev, i) => (
        <div className="chat-viz-event" key={i}>
          <span className="chat-viz-event-dot" aria-hidden="true" />
          <div className="chat-viz-event-body">
            <div className="chat-viz-event-row">
              <span className="chat-viz-event-label">{ev.label}</span>
              {ev.at && <span className="chat-viz-event-at">{ev.at}</span>}
            </div>
            {ev.detail && <div className="chat-viz-event-detail">{ev.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Line (SVG trend with optional area fill) ----

function LineRenderer({ payload }: { payload: VizLine }) {
  const W = 560;
  const H = 170;
  const values = payload.points.map((p) => p.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const x = (i: number) => (i / (payload.points.length - 1)) * (W - 16) + 8;
  const y = (v: number) => 12 + (1 - (v - min) / range) * (H - 34);
  const line = payload.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(payload.points.length - 1).toFixed(1)},${(H - 20).toFixed(1)} L${x(0).toFixed(1)},${(H - 20).toFixed(1)} Z`;
  const labelEvery = Math.ceil(payload.points.length / 8);
  const fmt = (v: number) => {
    const s = Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : String(Math.round(v * 100) / 100);
    return payload.unit ? `${s} ${payload.unit}` : s;
  };
  const stroke = payload.style?.accent ?? "var(--viz-accent, var(--accent))";
  return (
    <div className="chat-viz-line" data-testid="viz-line">
      <svg viewBox={`0 0 ${W} ${H}`} className="chat-viz-line-svg" role="img"
           aria-label={`Line chart, ${payload.points.length} points`}>
        {payload.area && <path d={area} fill={stroke} opacity={0.14} />}
        <line x1={0} x2={W} y1={y(min > 0 ? min : 0)} y2={y(min > 0 ? min : 0)} stroke="currentColor" opacity={0.25} />
        <path d={line} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {payload.points.length <= 40 &&
          payload.points.map((p, i) => (
            <circle key={i} cx={x(i)} cy={y(p.value)} r={2.8} fill={stroke}>
              <title>{`${p.label || i + 1}: ${fmt(p.value)}`}</title>
            </circle>
          ))}
      </svg>
      <div className="chat-viz-line-labels">
        {payload.points.map((p, i) => (
          <span key={i} className="chat-viz-line-label" style={{ visibility: i % labelEvery === 0 ? "visible" : "hidden" }}>
            {p.label || ""}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- Donut (SVG arcs + legend) ----

function DonutRenderer({ payload }: { payload: VizDonut }) {
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const segColor = (i: number) =>
    payload.style?.palette?.[i % payload.style.palette.length] ??
    (i === 0 ? "var(--viz-accent, var(--accent))" : `var(--viz-c${i + 1}, var(--accent))`);
  const fmt = (v: number) => {
    const s = Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : String(Math.round(v * 100) / 100);
    return payload.unit ? `${s} ${payload.unit}` : s;
  };
  return (
    <div className="chat-viz-donut" data-testid="viz-donut">
      <svg viewBox="0 0 140 140" className="chat-viz-donut-svg" role="img"
           aria-label={`Donut chart, ${payload.segments.length} segments`}>
        {payload.segments.map((seg, i) => {
          const frac = seg.value / payload.total;
          const dash = `${Math.max(frac * C - 2, 0.5)} ${C - Math.max(frac * C - 2, 0.5)}`;
          const el = (
            <circle
              key={i}
              cx={70} cy={70} r={R}
              fill="none"
              stroke={segColor(i)}
              strokeWidth={16}
              strokeDasharray={dash}
              strokeDashoffset={-offset * C}
              transform="rotate(-90 70 70)"
            >
              <title>{`${seg.label}: ${fmt(seg.value)} (${Math.round(frac * 100)}%)`}</title>
            </circle>
          );
          offset += frac;
          return el;
        })}
      </svg>
      <div className="chat-viz-donut-legend">
        {payload.segments.map((seg, i) => (
          <div className="chat-viz-legend-row" key={i}>
            <span className="chat-viz-legend-swatch" style={{ background: segColor(i) }} />
            <span className="chat-viz-legend-label">{seg.label}</span>
            <span className="chat-viz-legend-value">{fmt(seg.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Stat (big-number KPI row) ----

function StatRenderer({ payload }: { payload: VizStat }) {
  return (
    <div className="chat-viz-stats" data-testid="viz-stats">
      {payload.stats.map((s, i) => {
        const good = s.good === true;
        const bad = s.good === false;
        return (
          <div className="chat-viz-stat" key={i}>
            <span className="chat-viz-stat-label">{s.label}</span>
            <span className="chat-viz-stat-value">{s.value}</span>
            {s.delta && (
              <span className={`chat-viz-stat-delta${good ? " good" : bad ? " bad" : ""}`}>{s.delta}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- Composition: the stack container ----

/** A card whose sections are other cards plus prose. Every section renders
 *  through the SAME registry (so a nested chart is the ChartRenderer, and a
 *  nested stack recurses), each wrapped so its own style overrides locally
 *  while the container's style — set as CSS custom properties on the card root
 *  — is inherited. `columns: 2` gives a side-by-side layout, which is what a
 *  comparison or a two-up itinerary wants; anything gridder is render_widget. */
function StackRenderer({ payload }: { payload: VizStack }) {
  return (
    <div
      className={`chat-viz-stack${payload.columns === 2 ? " chat-viz-stack-2" : ""}`}
      data-testid="viz-stack"
    >
      {payload.sections.map((section, i) => {
        if (section.kind === "divider") {
          return <div className="chat-viz-divider" key={i} role="separator" />;
        }
        // A section is a full request minus a title, so it goes back through
        // the registry — including its own style application.
        const renderer = vizRenderers[section.kind];
        return (
          <div className="chat-viz-section" key={i}>
            {renderer ? renderer(section) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Markdown inside a typed card is rendered by `ProseRenderer` below, which
 *  delegates to the chat's own renderer — headings, code with highlighting,
 *  KaTeX math, GFM tables, mermaid and `[1]` citation chips all arrive with it.
 *  That is the whole of the reference "rich content elements" list for one
 *  component. */

function DividerRenderer({ payload }: { payload: VizDivider }) {
  // The divider's whole request is its presence; say nothing about the payload.
  void payload;
  return <div className="chat-viz-divider" role="separator" />;
}
/** Hover-revealed card actions: the data leaves as CSV or JSON. Uses the
 *  app clipboard (no shell, no bridge — the payload is already local data). */
function CardActions({ payload }: { payload: VizPayload }) {
  const [, copy] = useCopyToClipboard();
  const [copied, setCopied] = useState<"csv" | "json" | null>(null);
  const doCopy = async (kind: "csv" | "json") => {
    const text = kind === "csv" ? vizToCsv(payload) : JSON.stringify(payload, null, 2);
    if (text === null) return;
    const ok = await copy(text);
    if (ok) {
      setCopied(kind);
      setTimeout(() => setCopied(null), 1400);
    }
  };
  return (
    <div className="chat-viz-actions">
      <button
        type="button"
        className="chat-viz-action"
        title="Copy as CSV"
        onClick={() => void doCopy("csv")}
      >
        {copied === "csv" ? "Copied" : "CSV"}
      </button>
      <button
        type="button"
        className="chat-viz-action"
        title="Copy as JSON"
        onClick={() => void doCopy("json")}
      >
        {copied === "json" ? "Copied" : "JSON"}
      </button>
    </div>
  );
}

/** Markdown-dependent props, threaded from the chat so a `prose` section gets
 *  the same treatment as the answer body (citation chips, artifact previews,
 *  mermaid repair). They have defaults so existing call sites keep working. */
export type VizCardMarkdownProps = {
  onPreviewArtifact?: (artifact: ChatArtifact) => void;
  sources?: ChatSource[];
  chatSessionId?: string | null;
};

export function VizCard({
  viz,
  payload,
  onPreviewArtifact,
  sources,
  chatSessionId,
}: {
  viz: string | undefined;
  payload: unknown;
} & VizCardMarkdownProps) {
  const parsed = useMemo(() => parseVizPayload(viz, payload), [viz, payload]);
  if (!parsed) {
    // The backend validates too, so this is a defensive fallback (streaming
    // race, older message, registry drift) — explicit, never broken UI.
    return (
      <div className="chat-viz-card chat-viz-fallback" data-testid="viz-fallback">
        Visualization unavailable — the data could not be rendered.
      </div>
    );
  }
  const renderer = vizRenderers[parsed.kind];
  return (
    <VizMarkdownContext.Provider value={{ onPreviewArtifact, sources, chatSessionId }}>
      <div
        className={`chat-viz-card${parsed.style?.tone && parsed.style.tone !== "app" ? ` chat-viz-tone-${parsed.style.tone}` : ""}`}
        style={styleVars(parsed.style)}
        data-testid={`viz-card-${parsed.kind}`}
      >
        <div className="chat-viz-title">
          <span className="chat-viz-title-text">{parsed.title ?? "Visualization"}</span>
          <CardActions payload={parsed} />
        </div>
        {renderer ? (
          renderer(parsed)
        ) : (
          <div className="chat-viz-fallback" data-testid="viz-fallback">
            Visualization unavailable — no renderer for "{parsed.kind}".
          </div>
        )}
      </div>
    </VizMarkdownContext.Provider>
  );
}

/** Makes the chat's markdown props available to `prose` sections deep inside a
 *  stack without threading them through every renderer signature. */
const VizMarkdownContext = createContext<VizCardMarkdownProps>({});

function ProseRenderer({ payload }: { payload: VizProse }) {
  const md = useContext(VizMarkdownContext);
  return (
    <div className="chat-viz-prose" data-testid="viz-prose">
      <Markdown
        content={payload.markdown}
        onPreviewArtifact={md.onPreviewArtifact}
        cache={false}
        sources={md.sources}
        chatSessionId={md.chatSessionId}
      />
    </div>
  );
}
