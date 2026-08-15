import { useState } from "react";
import { useUiStore } from "../../state/ui";
import { useCostRollups } from "../../hooks/useCostRollups";
import { RangeToggle } from "./RangeToggle";
import { CostHero } from "./CostHero";
import { DailyChart } from "./DailyChart";
import { StatsRow } from "./StatsRow";
import { ModelBreakdownTable } from "./ModelBreakdownTable";
import { CostQualityPanel } from "./CostQualityPanel";
import { BudgetPanel } from "./BudgetPanel";

export function CostDashboard() {
  const setActiveView = useUiStore(s => s.setActiveView);
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(30);
  const { rollups, loading, error, refresh } = useCostRollups(rangeDays);

  return (
    <div className="view-overlay modal-centered"
         onPointerDown={(e) => e.target === e.currentTarget && setActiveView("chat")}>
      <div className="view-panel">
        <div className="view-header">
          <h2>Usage</h2>
          <div className="view-header-right">
            <RangeToggle value={rangeDays} onChange={setRangeDays} />
            <button className="ghost" onClick={() => setActiveView("chat")}>✕</button>
          </div>
        </div>
        <div className="view-body">
          {error && (
            <div className="cost-error">
              Failed to load: {error}
              <button className="ghost" onClick={refresh}>Retry</button>
            </div>
          )}
          {loading && !rollups ? (
            <div className="cost-loading">Loading…</div>
          ) : rollups && rollups.totals.rawTokenCostUsd === 0 && rollups.daily.length === 0 ? (
            <div className="empty-reserved">
              <span className="empty-icon">📊</span>
              <span className="empty-text">No usage in this range.</span>
            </div>
          ) : rollups ? (
            <>
              {/* T3 Code layout: hero + per-tool breakdown LEFT, daily chart
                  RIGHT, side by side; stats row spans below. */}
              <div className="cost-top-grid">
                <CostHero rollups={rollups} />
                <DailyChart rollups={rollups} />
              </div>
              <StatsRow byKind={rollups.byKind} cacheSavingsUsd={rollups.costQuality.cacheSavingsUsd} />
              {/* T3 Code layout: model breakdown table LEFT, cost quality
                  panel RIGHT, side by side. */}
              <div className="cost-bottom-grid">
                <ModelBreakdownTable rows={rollups.perModel} />
                <CostQualityPanel q={rollups.costQuality} cacheSavingsUsd={rollups.costQuality.cacheSavingsUsd} />
              </div>
              <BudgetPanel perProject={rollups.perProject} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
