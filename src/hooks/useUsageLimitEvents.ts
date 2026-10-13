// Usage-limit alerts (commands/usage.rs): listens for `usage:limit-alert`
// tier escalations and surfaces them as a notification (bell + toast + OS),
// and re-checks the meters on every `cost:updated` event so the composer
// notch reflects the freshest numbers. An initial refresh at boot covers
// plan windows recorded by previous sessions.
import { useEffect } from "react";
import { onUsageLimitAlert, type UsageLimitAlert } from "../lib/ipc";
import type { CostUpdatedPayload } from "../types";
import { useEventSubscription, useTauriEvent } from "./useTauriEvent";
import { relayNotify } from "../lib/notifyCenter";
import { useUsageLimitsStore } from "../state/usageLimits";

export function useUsageLimitEvents(): void {
  useEventSubscription<UsageLimitAlert>(
    onUsageLimitAlert,
    (p) => {
      relayNotify({
        kind: "alert",
        title: p.tier === "crit" ? "Usage limit reached" : "Approaching a usage limit",
        body: p.message,
        view: "cost",
        osToast: true,
        inAppToast: true,
        sound: "alert",
        // Escalations are rare (once per tier per window) — a chime while
        // focused is informative, not noise.
        soundOnlyUnfocused: false,
      });
    },
    [],
  );

  useTauriEvent<CostUpdatedPayload>(
    "cost:updated",
    () => {
      void useUsageLimitsStore.getState().refresh({ check: true });
    },
    [],
  );

  // Boot refresh: plan windows and caps from previous sessions are in the DB,
  // so the notch can render before any new turn happens.
  useEffect(() => {
    void useUsageLimitsStore.getState().refresh({ check: true });
  }, []);
}
