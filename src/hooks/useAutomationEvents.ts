// Automation run-finished wiring: the backend emits `automation:run-finished`
// from the scheduler's finalize path (app-open runs only — headless runs go
// to the webhook/email channels). Failures become OS toasts (DND-aware, with
// the optional chime); every event refreshes the automations store so the
// view's status column and Past Runs list stay live.
import { useEffect } from "react";
import { listenAutomationRunFinished } from "../lib/ipc";
import { osNotify } from "../lib/notify";
import { playNotifyChime } from "../lib/sound";
import { useAutomationsStore } from "../state/automations";
import { useSettingsStore } from "../state/settings";

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
      if (p.status === "ok" || p.status === "skipped") return;
      const settings = useSettingsStore.getState();
      if (settings.dnd) return;
      void osNotify("Relay automation failed", `${p.name}: ${p.summary}`);
      if (settings.notifySound) playNotifyChime();
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
