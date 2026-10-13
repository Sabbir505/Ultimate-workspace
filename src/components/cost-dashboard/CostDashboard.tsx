import { useEffect, useState } from "react";
import { useUiStore } from "../../state/ui";
import { useCostRollups } from "../../hooks/useCostRollups";
import { getPriceInfo, pricesRefreshNow, toastError } from "../../lib/ipc";
import { useUsageLimitsStore } from "../../state/usageLimits";
import { RangeToggle } from "./RangeToggle";
import { CostHero } from "./CostHero";
import { DailyChart } from "./DailyChart";
import { StatsRow } from "./StatsRow";
import { ModelBreakdownTable } from "./ModelBreakdownTable";
import { CostQualityPanel } from "./CostQualityPanel";
import { BudgetPanel } from "./BudgetPanel";
import { UsageLimitsPanel } from "./UsageLimitsPanel";
import { ArtifactCostPanel } from "./ArtifactCostPanel";

export function CostDashboard() {
  const closeOverlay = useUiStore(s => s.closeOverlay);
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(30);
  const { rollups, loading, stale, error, refresh } = useCostRollups(rangeDays);
  // Live price table (LiteLLM): age of the stored blob + a manual re-fetch,
  // so the user can see (and fix) stale rates without leaving the dashboard.
  const [priceFetchedAt, setPriceFetchedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getPriceInfo()
      .then(info => { if (!cancelled) setPriceFetchedAt(info.fetchedAt); })
      .catch(() => { /* non-fatal — the price bar just shows no age */ });
    return () => { cancelled = true; };
  }, []);
  // OPEN pulls a fresh-ish snapshot instead of only re-reading local caches:
  // the rollups recompute from the DB (useCostRollups), and the provider plan
  // windows refresh under the backend's 10-minute throttle — so the open-time
  // spinner actually means data is being refreshed, without hammering the
  // providers on every visit. The explicit Refresh button forces everything.
  useEffect(() => {
    void useUsageLimitsStore.getState().refreshProviderData({ force: false });
  }, []);
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const [report] = await Promise.all([
        pricesRefreshNow(),
        refresh(),
        useUsageLimitsStore.getState().refreshProviderData({ force: true }),
      ]);
      if (report) setPriceFetchedAt(report.fetchedAt);
    } catch (err) {
      // Reaching here means the PRICE fetch failed: the rollup refresh and
      // the provider refresh record their own errors (banner / panel line)
      // and never reject, so this toast names the actual failure.
      toastError("Usage refreshed, but the model price table couldn't update", err);
    } finally {
      setRefreshing(false);
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
            {/* One Refresh for the whole dashboard: usage rollups, model
                prices, and the provider plan windows (forced past the
                backend throttle). */}
            <button className="ghost" onClick={refreshAll} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "↻ Refresh"}
            </button>
            <RangeToggle value={rangeDays} onChange={setRangeDays} />
            <button className="ghost" onClick={closeOverlay}>✕</button>
          </div>
        </div>
        <div className="view-body">
          {/* Freshness of the stored LiteLLM rates. No button here — the
              header's Refresh re-fetches prices along with everything else;
              this line just reports the age. */}
          <div className="cost-price-bar">
            <span className="cost-footer-note">
              {priceFetchedAt
                ? `Live prices updated ${new Date(priceFetchedAt * 1000).toLocaleString()}`
                : "Live prices not fetched yet — using the built-in rate table"}
            </span>
          </div>
          {error && (
            <div className="cost-error">
              Failed to load: {error}
              <button className="ghost" onClick={refresh}>Retry</button>
            </div>
          )}
          {loading && !rollups ? (
            // Full-height loading state: the modal must keep the dashboard's
            // size while the first rollup lands — a bare one-line loader
            // collapsed the panel to a sliver and then snapped open.
            <div className="cost-loading" role="status">
              <span className="cost-loading-spinner" aria-hidden="true" />
              <span>Loading usage…</span>
            </div>
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
              {/* Per-provider/harness usage windows + reported plan limits +
                  configured caps, ahead of the per-model tables (the composer
                  notch reads the same store). */}
              <UsageLimitsPanel />
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
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
