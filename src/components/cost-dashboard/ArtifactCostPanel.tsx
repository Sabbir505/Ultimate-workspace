// Artifact cost attribution (improvements engine P3): what the
// self-improvement loop COSTS per artifact — the live-traffic runs it
// tracks plus the engine's own throwaway proposer/judge/eval sessions
// (recorded on improve_eval_runs since P3). Mounted inside CostDashboard
// below BudgetPanel; empty when no tracked artifact has spend in range.
import { useEffect, useState } from "react";
import { getArtifactCosts, toastError, type ArtifactCostRollup } from "../../lib/ipc";

const KIND_LABEL: Record<string, string> = {
  skill: "Skill",
  loop: "Loop",
  prompt_template: "Template",
  automation: "Automation",
};

const fmtUsd = (v: number) =>
  v >= 0.01 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(4)}` : "$0";
const fmtTok = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}k` : `${v}`;

export function ArtifactCostPanel({ rangeDays }: { rangeDays: 7 | 30 | 90 }) {
  const [rows, setRows] = useState<ArtifactCostRollup[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getArtifactCosts(rangeDays)
      .then((r) => {
        if (!cancelled && r) setRows(r.filter((x) => x.liveRuns > 0 || x.evalRuns > 0 || x.costUsd > 0));
      })
      .catch(() => toastError("Could not load artifact costs"));
    return () => {
      cancelled = true;
    };
  }, [rangeDays]);

  if (rows.length === 0) return null;

  return (
    <section className="cost-artifact-panel" data-testid="artifact-cost-panel">
      <div className="improve-section-head">
        <h4>Artifact attribution</h4>
        <span className="cost-footer-note">
          live runs + the improvement engine's own eval turns, per artifact
        </span>
      </div>
      <div className="cost-table-wrap">
        <table className="kv cost-artifact-table" data-testid="artifact-cost-table">
          <thead>
            <tr>
              <th>Artifact</th>
              <th>Kind</th>
              <th className="num">Live runs</th>
              <th className="num">Eval runs</th>
              <th className="num">Tokens in</th>
              <th className="num">Tokens out</th>
              <th className="num">Cached</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.artifactId}>
                <td title={r.artifactId}>{r.name}</td>
                <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                <td className="num">{r.liveRuns}</td>
                <td className="num">{r.evalRuns}</td>
                <td className="num">{fmtTok(r.inputTokens)}</td>
                <td className="num">{fmtTok(r.outputTokens)}</td>
                <td className="num">{fmtTok(r.cacheReadTokens)}</td>
                <td className="num">{fmtUsd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
