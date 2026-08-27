// Budget/spend alerts (roadmap #10): listens for `budget:alert` events and
// shows an in-app toast + OS notification. Also calls `checkBudgets()` on
// `cost:updated` events so thresholds are evaluated after every cost event.
import { useEffect } from "react";
import { checkBudgets, onBudgetAlert, safeListen } from "../lib/ipc";
import { osNotify } from "../lib/notify";
import { toastError } from "../lib/ipc";
import type { CostUpdatedPayload } from "../types";

export function useBudgetEvents(): void {
  useEffect(() => {
    let disposed = false;
    let unlistenAlert: (() => void) | undefined;
    let unlistenCost: (() => void) | undefined;

    // Listen for budget:alert events (fired by check_budgets backend).
    void onBudgetAlert((p) => {
      if (disposed) return;
      const pct = Math.round(p.usedPct);
      const msg = `${p.projectName}: $${p.spentUsd.toFixed(2)} spent (${pct}% of $${p.monthlyUsd.toFixed(2)} monthly budget)`;
      toastError("Budget alert", msg);
      void osNotify("Relay budget alert", msg);
    }).then((u) => {
      if (disposed) u();
      else unlistenAlert = u;
    });

    // On every cost:updated event, run the budget check.
    void safeListen<CostUpdatedPayload>("cost:updated", () => {
      if (disposed) return;
      void checkBudgets().catch(() => {});
    }).then((u) => {
      if (disposed) u();
      else unlistenCost = u;
    });

    return () => {
      disposed = true;
      unlistenAlert?.();
      unlistenCost?.();
    };
  }, []);
}