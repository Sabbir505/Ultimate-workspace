// Budget/spend alerts panel (roadmap #10): shows per-project monthly spend
// against configured budgets, with an inline editor to set/remove budgets.
// Mounted inside the CostDashboard below the stats row.
import { useCallback, useEffect, useState } from "react";
import {
  listBudgets,
  setBudget,
  removeBudget,
  listProjects,
  toastError,
  type BudgetConfig,
} from "../../lib/ipc";
import type { ProjectCostRollup } from "../../types";

interface Props {
  perProject: ProjectCostRollup[];
}

export function BudgetPanel({ perProject }: Props) {
  const [budgets, setBudgets] = useState<BudgetConfig[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftUsd, setDraftUsd] = useState("");
  // Project id → name. `perProject` only carries the UUID; without this
  // lookup the panel renders raw UUIDs where a name is expected.
  const [projectNames, setProjectNames] = useState<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const b = await listBudgets();
      if (b) setBudgets(b);
    } catch {
      toastError("Could not refresh budgets");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ps = await listProjects();
        if (!cancelled && ps) setProjectNames(new Map(ps.map((p) => [p.id, p.name])));
      } catch {
        if (!cancelled) toastError("Could not load project names");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const displayName = (id: string) => projectNames.get(id) ?? id.slice(0, 8);

  const handleSet = async (projectId: string) => {
    const val = parseFloat(draftUsd);
    if (isNaN(val) || val <= 0) return;
    setBusy(projectId);
    try {
      await setBudget(projectId, val);
      await refresh();
      setEditing(null);
    } catch (err) {
      toastError("Failed to set budget", err);
    } finally { setBusy(null); }
  };

  const handleRemove = async (projectId: string) => {
    setBusy(projectId);
    try {
      await removeBudget(projectId);
      await refresh();
    } finally { setBusy(null); }
  };

  if (perProject.length === 0) return null;

  return (
    <div className="budget-panel">
      <h4 className="budget-panel-title">Project budgets</h4>
      <div className="budget-rows">
        {perProject.map((p) => {
          const cfg = budgets.find((b) => b.projectId === p.projectId);
          const pct = cfg && cfg.monthlyUsd > 0
            ? (p.totalCostUsd / cfg.monthlyUsd * 100).toFixed(1)
            : null;
          const over = pct && parseFloat(pct) >= (cfg?.thresholdPct ?? 100);
          return (
            <div key={p.projectId} className="budget-row">
              <span className="budget-row-name">{displayName(p.projectId)}</span>
              <span className="budget-row-spend">${p.totalCostUsd.toFixed(2)}</span>
              {editing === p.projectId ? (
                <div className="budget-row-edit">
                  <input
                    type="number"
                    min={0.01}
                    step={1}
                    value={draftUsd}
                    placeholder="Monthly $"
                    onChange={(e) => setDraftUsd(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void handleSet(p.projectId)}
                    autoFocus
                  />
                  <button className="ghost" onClick={() => void handleSet(p.projectId)} disabled={busy === p.projectId}>
                    Save
                  </button>
                  <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              ) : cfg ? (
                <>
                  <span className={`budget-row-pct${over ? " over" : ""}`}>
                    {pct}% of ${cfg.monthlyUsd.toFixed(0)}
                  </span>
                  <button className="ghost" onClick={() => handleRemove(p.projectId)} disabled={busy === p.projectId}>
                    Remove
                  </button>
                </>
              ) : (
                <button className="ghost" onClick={() => { setEditing(p.projectId); setDraftUsd(""); }}>
                  Set budget
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}