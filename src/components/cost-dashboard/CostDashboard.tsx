import { useEffect, useState } from "react";
import { useUiStore } from "../../state/ui";
import { useCostRollups } from "../../hooks/useCostRollups";
import { getPriceInfo, pricesRefreshNow, toastError } from "../../lib/ipc";
import { RangeToggle } from "./RangeToggle";
import { CostHero } from "./CostHero";
import { DailyChart } from "./DailyChart";
import { StatsRow } from "./StatsRow";
import { ModelBreakdownTable } from "./ModelBreakdownTable";
import { CostQualityPanel } from "./CostQualityPanel";
import { BudgetPanel } from "./BudgetPanel";
import { ArtifactCostPanel } from "./ArtifactCostPanel";

export function CostDashboard() {
  const closeOverlay = useUiStore(s => s.closeOverlay);
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(30);
  const { rollups, loading, stale, error, refresh } = useCostRollups(rangeDays);
  // Live price table (LiteLLM): age of the stored blob + a manual re-fetch,
  // so the user can see (and fix) stale rates without leaving the dashboard.
  const [priceFetchedAt, setPriceFetchedAt] = useState<number | null>(null);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getPriceInfo()
      .then(info => { if (!cancelled) setPriceFetchedAt(info.fetchedAt); })
      .catch(() => { /* non-fatal — the footer just shows no age */ });
    return () => { cancelled = true; };
  }, []);
  const refreshPrices = async () => {
    setRefreshingPrices(true);
    try {
      const report = await pricesRefreshNow();
      if (report) setPriceFetchedAt(report.fetchedAt);
    } catch (err) {
      toastError("Couldn't refresh model prices", err);
    } finally {
      setRefreshingPrices(false);
    }
  };

  return (
    <div className="view-overlay modal-centered"
         onPointerDown={(e) => e.target === e.currentTarget && closeOverlay()}>
      <div className="view-panel">
        <div className="view-header">
          <h2>Usage</h2>
          <div className="view-header-right">
            {/* Visible whenever a range switch is in flight, including the
                window where the previous range's numbers are still on screen
                — otherwise the dimmed data reads as the new range's. */}
            {stale && <span className="cost-refreshing-note">Updating…</span>}
            <RangeToggle value={rangeDays} onChange={setRangeDays} />
            <button className="ghost" onClick={closeOverlay}>✕</button>
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
            <div
              className={stale ? "cost-rollups-body cost-refreshing" : "cost-rollups-body"}
              aria-busy={stale || undefined}
              data-testid="cost-rollups"
            >
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
              {/* Improvements engine P3: what each self-improving artifact
                  costs (live runs + the engine's own eval turns). Renders
                  nothing until an artifact has attributed spend. */}
              <ArtifactCostPanel rangeDays={rangeDays} />
              {/* Footer: manual refresh of the live LiteLLM price table plus
                  the age of the currently stored rates. */}
              <div className="cost-footer">
                <button className="ghost" onClick={refreshPrices} disabled={refreshingPrices}>
                  {refreshingPrices ? "Refreshing…" : "↻ Refresh model prices"}
                </button>
                <span className="cost-footer-note">
                  {priceFetchedAt
                    ? `Live prices updated ${new Date(priceFetchedAt * 1000).toLocaleString()}`
                    : "Live prices not fetched yet — using the built-in rate table"}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
