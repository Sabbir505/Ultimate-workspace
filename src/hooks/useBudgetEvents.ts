// Budget/spend alerts (roadmap #10): listens for `budget:alert` events and
// surfaces them as a bell notification + in-app toast + OS notification.
// Also calls `checkBudgets()` on `cost:updated` events so thresholds are
// evaluated after every cost event.
import { checkBudgets, onBudgetAlert, type BudgetAlertPayload } from "../lib/ipc";
import type { CostUpdatedPayload } from "../types";
import { useEventSubscription, useTauriEvent } from "./useTauriEvent";
import { relayNotify } from "../lib/notifyCenter";

export function useBudgetEvents(): void {
  // Listen for budget:alert events (fired by check_budgets backend).
  useEventSubscription<BudgetAlertPayload>(onBudgetAlert, (p) => {
    const pct = Math.round(p.usedPct);
    const msg = `${p.projectName}: $${p.spentUsd.toFixed(2)} spent (${pct}% of $${p.monthlyUsd.toFixed(2)} monthly budget)`;
    relayNotify({
      kind: "alert",
      title: "Relay budget alert",
      body: msg,
      view: "cost",
      osToast: true,
      inAppToast: true,
      sound: "alert",
      // Alerts interrupt by design; budget thresholds are rare enough that
      // a chime while focused isn't noise.
      soundOnlyUnfocused: false,
    });
  }, []);

  // On every cost:updated event, run the budget check.
  useTauriEvent<CostUpdatedPayload>(
    "cost:updated",
    () => {
      void checkBudgets().catch(() => {});
    },
    [],
  );
}
