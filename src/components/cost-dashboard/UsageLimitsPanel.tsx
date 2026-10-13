// Usage & limits panel: rolling usage (1h/24h/7d/30d) per API provider and
// harness CLI, the provider/CLI-REPORTED plan windows (Claude Code 5h/7d,
// CommandCode 5h/weekly/monthly credits, OpenCode Go rolling/weekly/monthly,
// Anthropic/OpenAI rate-limit headers, OpenRouter credits), and
// user-configured caps with 80%/100% tiers.
//
// Mounted in the Cost dashboard between the stats row and the
// model-breakdown / cost-quality grid.
// "Remaining" only appears where a source actually reports it (or a cap is
// configured) — nothing is invented for CLIs with no usage surface, and
// local models (no limit model at all) are excluded backend-side.
import { useEffect, useState } from "react";
import {
  removeUsageLimit,
  setUsageLimit,
  toastError,
  type RateWindowPayload,
  type UsageMeterPayload,
  type UsageTotals,
} from "../../lib/ipc";
import { usageResetSuffix, useUsageLimitsStore } from "../../state/usageLimits";

type Tone = "ok" | "warn" | "crit";

const WINDOW_LABELS: Array<["1h" | "24h" | "7d" | "30d", keyof UsageMeterPayload["windows"]]> = [
  ["1h", "lastHour"],
  ["24h", "lastDay"],
  ["7d", "lastWeek"],
  ["30d", "lastMonth"],
];

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(n >= 0.01 ? 2 : 4)}`;
}

function tokenTotal(t: UsageTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens + t.reasoningTokens;
}

function toneFor(pct: number, threshold: number, exceeded: boolean): Tone {
  if (exceeded || pct >= 100) return "crit";
  if (pct >= threshold) return "warn";
  return "ok";
}

function worstTone(m: UsageMeterPayload): Tone {
  let worst: Tone = "ok";
  const bump = (t: Tone) => {
    if (t === "crit") worst = "crit";
    else if (t === "warn" && worst === "ok") worst = "warn";
  };
  for (const c of m.caps) bump(c.tier === "crit" ? "crit" : c.tier === "warn" ? "warn" : "ok");
  for (const w of m.reported) {
    if (w.usedPct === null) continue;
    bump(toneFor(w.usedPct, 80, w.status === "exceeded"));
  }
  if (m.health) bump("crit");
  return worst;
}

/** One meter line: label + detail head, a track with the warn threshold
 *  ticked, and a % used / reset foot. */
function Meter({
  label,
  detail,
  tone,
  pct,
  threshold,
  footLeft,
  footRight,
}: {
  label: string;
  detail: string;
  tone: Tone;
  pct: number | null;
  threshold?: number;
  footLeft?: string;
  footRight?: string;
}) {
  return (
    <div className={`usage-meter usage-meter-${tone}`}>
      <div className="usage-meter-head">
        <span className="usage-meter-label">{label}</span>
        <span className="usage-meter-detail">{detail}</span>
      </div>
      <div className="usage-meter-track">
        <span
          className="usage-meter-fill"
          style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
        />
        {threshold != null ? (
          <span
            className="usage-meter-tick"
            style={{ left: `${Math.min(99, Math.max(1, threshold))}%` }}
            title={`Warn at ${threshold.toFixed(0)}%`}
          />
        ) : null}
      </div>
      {footLeft || footRight ? (
        <div className="usage-meter-foot">
          <span>{footLeft ?? ""}</span>
          <span>{footRight ?? ""}</span>
        </div>
      ) : null}
    </div>
  );
}

function reportedDetail(w: RateWindowPayload): { detail: string; footLeft: string; footRight: string } {
  const pct = w.usedPct;
  const footRight = usageResetSuffix(w.resetsAt) ?? "";
  if (w.unit === "usd") {
    // Remaining-only is a real state (credits reported while the period
    // summary is unavailable) — it must still read as a number, not "—".
    const detail =
      w.remaining !== null && w.limit !== null
        ? `${fmtUsd(w.remaining)} left of ${fmtUsd(w.limit)}`
        : w.remaining !== null
          ? `${fmtUsd(w.remaining)} left`
          : w.used !== null
            ? `${fmtUsd(w.used)} used`
            : pct !== null
              ? `${pct.toFixed(0)}% used`
              : "—";
    return { detail, footLeft: pct !== null ? `${pct.toFixed(0)}% used` : "", footRight };
  }
  if (w.unit === "percent") {
    return { detail: pct !== null ? `${pct.toFixed(0)}% used` : "no limit reported", footLeft: "", footRight };
  }
  const detail =
    w.remaining !== null && w.limit !== null
      ? `${fmtTokens(w.remaining)} left of ${fmtTokens(w.limit)}`
      : w.remaining !== null
        ? `${fmtTokens(w.remaining)} left`
        : w.used !== null
          ? `${fmtTokens(w.used)} used`
          : "—";
  return { detail, footLeft: pct !== null ? `${pct.toFixed(0)}%` : "", footRight };
}

function MeterCard({ m }: { m: UsageMeterPayload }) {
  const [editing, setEditing] = useState(false);
  const [draftWindow, setDraftWindow] = useState<string>("day");
  const [draftUsd, setDraftUsd] = useState("");
  const [draftReq, setDraftReq] = useState("");
  const [draftPct, setDraftPct] = useState("80");
  const [busy, setBusy] = useState(false);
  const refresh = useUsageLimitsStore((s) => s.refresh);

  const existing = m.caps[0];
  const tone = worstTone(m);
  // Account-wide totals the SOURCE reported (CommandCode's usage summary) —
  // these are the numbers the vendor's own dashboard shows, distinct from the
  // locally measured rolling columns below.
  const accountBits: string[] = [];
  if (m.plan?.requestsTotal != null) accountBits.push(`${m.plan.requestsTotal.toLocaleString()} runs`);
  if (m.plan?.tokensTotal != null) accountBits.push(`${fmtTokens(m.plan.tokensTotal)} tokens`);
  if (m.plan?.costTotalUsd != null) accountBits.push(`${fmtUsd(m.plan.costTotalUsd)} spent`);

  const startEdit = () => {
    setDraftWindow(existing?.window ?? "day");
    setDraftUsd(existing?.capUsd != null ? String(existing.capUsd) : "");
    setDraftReq(existing?.capRequests != null ? String(existing.capRequests) : "");
    setDraftPct(existing ? String(existing.thresholdPct) : "80");
    setEditing(true);
  };

  const save = async () => {
    const usd = parseFloat(draftUsd);
    const req = parseInt(draftReq, 10);
    const pct = parseFloat(draftPct);
    setBusy(true);
    try {
      await setUsageLimit(
        m.target,
        draftWindow,
        Number.isFinite(usd) && usd > 0 ? usd : null,
        null,
        Number.isFinite(req) && req > 0 ? req : null,
        Number.isFinite(pct) ? pct : null,
      );
      await refresh({ check: true });
      setEditing(false);
    } catch (err) {
      toastError("Failed to save the usage cap", err);
    } finally {
      setBusy(false);
    }
  };

  const clearCap = async (window: string) => {
    setBusy(true);
    try {
      await removeUsageLimit(m.target, window);
      await refresh({ check: true });
      setEditing(false);
    } catch (err) {
      toastError("Failed to remove the usage cap", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`usage-card usage-card-${tone}`} data-target={m.target}>
      <div className="usage-card-head">
        <span className="usage-card-label">{m.label}</span>
        {m.plan?.planName ? <span className="usage-chip">{m.plan.planName}</span> : null}
        {m.plan?.creditsRemaining != null ? (
          <span className="usage-chip usage-chip-money" title="Credits remaining this billing period">
            {fmtUsd(m.plan.creditsRemaining)} left
          </span>
        ) : null}
        <button className="usage-card-action ghost" onClick={startEdit} disabled={busy}>
          {existing ? "Edit cap" : "Set cap"}
        </button>
      </div>

      {accountBits.length > 0 ? (
        <div
          className="usage-account-line"
          data-testid="usage-account"
          title="Account-wide totals for the billing period, as reported by the provider"
        >
          <span className="usage-account-basis">account</span>
          <span>{accountBits.join(" · ")}</span>
        </div>
      ) : null}

      <div className="usage-stats" title="Measured by Relay on this machine (rolling windows)">
        {WINDOW_LABELS.map(([label, key]) => {
          const t = m.windows[key];
          const tokens = tokenTotal(t);
          return (
            <div className="usage-stat" key={label}>
              <span className="usage-stat-window">{label}</span>
              <span className="usage-stat-tokens">{tokens > 0 ? fmtTokens(tokens) : "—"}</span>
              <span className="usage-stat-cost">
                {t.costUsd > 0 ? fmtUsd(t.costUsd) : t.requests > 0 ? `${t.requests} req` : ""}
              </span>
            </div>
          );
        })}
      </div>

      {m.caps.map((c) => {
        const detail =
          c.capUsd != null
            ? `${fmtUsd(c.usedUsd ?? 0)} of ${fmtUsd(c.capUsd)}`
            : c.capTokens != null
              ? `${fmtTokens(c.usedTokens ?? 0)} of ${fmtTokens(c.capTokens)} tokens`
              : `${c.usedRequests ?? 0} of ${c.capRequests ?? 0} requests`;
        return (
          <Meter
            key={`cap-${c.window}`}
            label={`${c.window} cap`}
            detail={detail}
            tone={c.tier === "crit" ? "crit" : c.tier === "warn" ? "warn" : "ok"}
            pct={c.usedPct}
            threshold={c.thresholdPct}
            footLeft={`${c.usedPct.toFixed(0)}% used`}
            footRight={`warn at ${c.thresholdPct.toFixed(0)}%`}
          />
        );
      })}

      {m.reported.map((w) => {
        const { detail, footLeft, footRight } = reportedDetail(w);
        const exceeded = w.status === "exceeded" || (w.usedPct ?? 0) >= 100;
        return (
          <Meter
            key={`${w.source}-${w.window}`}
            label={w.label}
            detail={detail}
            tone={w.usedPct === null ? "ok" : toneFor(w.usedPct, 80, exceeded)}
            pct={w.usedPct}
            threshold={80}
            footLeft={footLeft}
            footRight={exceeded ? "limit reached" : footRight}
          />
        );
      })}

      {m.health ? <div className="usage-card-health">⚠ {m.health}</div> : null}

      {editing ? (
        <div className="usage-editor">
          <div className="usage-editor-row">
            <span className="usage-editor-label">Window</span>
            <div className="usage-seg" role="group" aria-label="Cap window">
              {(["hour", "day", "week", "month"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  className={draftWindow === w ? "is-active" : ""}
                  onClick={() => setDraftWindow(w)}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
          <div className="usage-editor-row">
            <span className="usage-editor-label">Caps</span>
            <input
              type="number"
              min={0}
              step={1}
              placeholder="$"
              value={draftUsd}
              onChange={(e) => setDraftUsd(e.target.value)}
            />
            <input
              type="number"
              min={0}
              step={1}
              placeholder="requests"
              value={draftReq}
              onChange={(e) => setDraftReq(e.target.value)}
            />
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              placeholder="warn %"
              value={draftPct}
              onChange={(e) => setDraftPct(e.target.value)}
              title="Warn at this percent of the cap"
            />
          </div>
          <div className="usage-editor-actions">
            <button className="ghost" onClick={() => void save()} disabled={busy}>
              Save
            </button>
            {existing ? (
              <button className="ghost" onClick={() => void clearCap(existing.window)} disabled={busy}>
                Remove
              </button>
            ) : null}
            <button className="ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function UsageLimitsPanel() {
  const meters = useUsageLimitsStore((s) => s.meters);
  const loading = useUsageLimitsStore((s) => s.loading);
  const error = useUsageLimitsStore((s) => s.error);
  const refresh = useUsageLimitsStore((s) => s.refresh);

  useEffect(() => {
    void refresh({ check: true });
  }, [refresh]);

  const rows = Object.values(meters).sort((a, b) => a.label.localeCompare(b.label));
  const apiRows = rows.filter((m) => m.target.startsWith("chat:"));
  const harnessRows = rows.filter((m) => !m.target.startsWith("chat:"));
  const nearLimit = rows.filter((m) => worstTone(m) !== "ok").length;

  return (
    <div className="usage-panel" data-testid="usage-limits-panel">
      <div className="usage-panel-head">
        <h4 className="usage-panel-title">Usage &amp; limits</h4>
        <div className="usage-panel-meta">
          {nearLimit > 0 ? (
            <span className="usage-chip usage-chip-warn">{nearLimit} near limit</span>
          ) : null}
          <span className="usage-chip">
            {rows.length} {rows.length === 1 ? "source" : "sources"}
          </span>
        </div>
      </div>
      <p className="usage-panel-note">
        Measured locally (1h / 24h / 7d / 30d); remaining quotas appear only when the provider or
        CLI reports them.
      </p>
      {error ? <p className="usage-panel-error">Last refresh failed: {error}</p> : null}

      {rows.length === 0 ? (
        <div className="usage-panel-empty">
          <span className="usage-panel-empty-icon" aria-hidden="true">
            📊
          </span>
          <span>
            {loading
              ? "Loading…"
              : "No metered sources yet — send a turn or set a cap to populate this panel."}
          </span>
        </div>
      ) : null}

      {apiRows.length > 0 ? (
        <section className="usage-group">
          <div className="usage-group-title">
            <span>API providers</span>
            <span className="usage-group-rule" aria-hidden="true" />
          </div>
          <div className="usage-cards">
            {apiRows.map((m) => (
              <MeterCard key={m.target} m={m} />
            ))}
          </div>
        </section>
      ) : null}
      {harnessRows.length > 0 ? (
        <section className="usage-group">
          <div className="usage-group-title">
            <span>Harness CLIs</span>
            <span className="usage-group-rule" aria-hidden="true" />
          </div>
          <div className="usage-cards">
            {harnessRows.map((m) => (
              <MeterCard key={m.target} m={m} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
