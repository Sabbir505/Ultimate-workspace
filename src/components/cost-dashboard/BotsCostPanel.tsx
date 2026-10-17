// Bot cost attribution (Usage page): what each bot costs over the selected
// range. A bot's spend is the sum over EVERY session bound to it — its
// conversations AND its headless runs (standing jobs, "Run now", ask_bot) —
// read from `chat_messages`. Answers "how much am I spending on bots?" in one
// place. Mounted inside CostDashboard below the artifact panel; renders nothing
// until at least one bot exists.
import { useEffect, useState } from "react";
import { getBotCosts, type BotCostRollup } from "../../lib/ipc/bots";
import { toastError } from "../../lib/ipc";

const fmtUsd = (v: number) =>
  v >= 0.01 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(4)}` : "$0";
const fmtTok = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}k` : `${v}`;

export function BotsCostPanel({ rangeDays }: { rangeDays: 7 | 30 | 90 }) {
  const [rows, setRows] = useState<BotCostRollup[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    void getBotCosts(rangeDays)
      .then((r) => {
        if (!cancelled) setRows(r ?? []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
        toastError("Could not load bot costs");
      });
    return () => {
      cancelled = true;
    };
  }, [rangeDays]);

  // No bots at all → no section. Bots with zero spend still show, so "$0" is
  // visible rather than an empty panel the user can't interpret.
  if (!rows || rows.length === 0) return null;

  const total = rows.reduce((sum, r) => sum + r.costUsd, 0);

  return (
    <section className="cost-artifact-panel" data-testid="bots-cost-panel">
      <div className="improve-section-head">
        <h4>Bots</h4>
        <span className="cost-footer-note">
          standing jobs, runs and conversations · {fmtUsd(total)} total
        </span>
      </div>
      <div className="cost-table-wrap">
        <table className="kv cost-artifact-table" data-testid="bots-cost-table">
          <thead>
            <tr>
              <th>Bot</th>
              <th>Status</th>
              <th className="num">Runs</th>
              <th className="num">Jobs</th>
              <th className="num">Tokens in</th>
              <th className="num">Tokens out</th>
              <th className="num">Cached</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.botId}>
                <td title={r.botId}>
                  {r.emoji ? `${r.emoji} ` : ""}
                  {r.name}
                </td>
                <td>{r.enabled ? "active" : "disabled"}</td>
                <td className="num">{r.runs}</td>
                <td className="num">{r.jobs}</td>
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
