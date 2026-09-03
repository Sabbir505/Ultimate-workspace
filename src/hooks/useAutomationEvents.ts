// Automation run-finished wiring: the backend emits `automation:run-finished`
// from the scheduler's finalize path (app-open runs only — headless runs go
// to the webhook/email channels). Every event lands in the notification
// center (bell) so runs are auditable later; failures additionally become OS
// toasts with the optional chime, DND-aware. Every event also refreshes the
// automations store so the view's status column and Past Runs list stay live.
import { useEffect } from "react";
import { listenAutomationRunFinished } from "../lib/ipc";
import { relayNotify } from "../lib/notifyCenter";
import { useAutomationsStore } from "../state/automations";

export function useAutomationEvents(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenAutomationRunFinished((p) => {
      // Refresh the list + status regardless of outcome.
      const store = useAutomationsStore.getState();
      // Promise.resolve wrapper: tolerate a sync/mock load() that returns
      // undefined while still swallowing real rejections (M9).
      if (store.loaded) void Promise.resolve(store.load()).catch(() => {});

      // Toast policy: failures only — a healthy */15 cron toasting every
      // success would be noise. "skipped" is informational, not a failure.
      // Successes/skips still land in the bell panel (no toast, no chime).
      if (p.status === "ok" || p.status === "skipped") {
        relayNotify({
          kind: "automation",
          title: `Automation ${p.name} ${p.status === "skipped" ? "skipped" : "finished"}`,
          body: p.summary,
          view: "automations",
          chatSessionId: p.chatSessionId || undefined,
        });
        return;
      }
      relayNotify({
        kind: "automation",
        title: "Relay automation failed",
        body: `${p.name}: ${p.summary}`,
        view: "automations",
        chatSessionId: p.chatSessionId || undefined,
        osToast: true,
        sound: "alert",
        // Failure chime is an alert, not a completion cue — it fires even
        // when Relay is focused (a cron failing in the background is exactly
        // what the user needs to hear about).
        soundOnlyUnfocused: false,
      });
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
