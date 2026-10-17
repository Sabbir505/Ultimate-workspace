// Bot event wiring — mounted exactly ONCE (App). Three jobs:
//
//   1. keep the shared bots store live from the backend's `bots:changed`
//      event (created/updated/deleted/run/approval) — the listener lives here
//      so the several `useBots` consumers share one subscription instead of
//      each registering its own;
//   2. poll `botsRunning` while any run is in flight, so the rail's pulse
//      stays honest between the run's start and its (event-only, at-the-end)
//      completion;
//   3. funnel `bot:run-finished` through `relayNotify` — the bell panel always
//      records it and a failure also raises an OS toast + chime, the same
//      policy `useAutomationEvents` applies to scheduled runs.
import { useEffect } from "react";
import {
  botsRunning,
  onBotsChanged,
  onBotRunFinished,
  type BotRunFinishedPayload,
  type BotsChangedPayload,
} from "../lib/ipc/bots";
import { relayNotify } from "../lib/notifyCenter";
import { useEventSubscription } from "./useTauriEvent";
import { STOPPED_STATUS } from "../components/automations/shared";
import { BOTS_POLL_MS, ensureBotsLoaded, useBotsStore } from "../state/bots";

export function useBotEvents(): void {
  // First load, once per app run.
  useEffect(() => {
    ensureBotsLoaded();
  }, []);

  // Every mutation and every run/approval transition comes back as
  // `bots:changed`; one subscription keeps the whole surface live.
  useEventSubscription<BotsChangedPayload>(
    onBotsChanged,
    () => {
      void useBotsStore.getState().refresh();
    },
    [],
  );

  // Keep the "working now" dots honest between events: a run takes minutes,
  // and its own `bots:changed` only lands at the end. Poll while any bot is
  // busy, stop as soon as none is.
  const runningCount = useBotsStore((s) => s.runningBots.length);
  useEffect(() => {
    if (runningCount === 0) return;
    const t = window.setInterval(() => {
      void botsRunning().then((ids) => useBotsStore.setState({ runningBots: ids ?? [] }));
    }, BOTS_POLL_MS);
    return () => window.clearInterval(t);
  }, [runningCount]);

  // A manual "Run now" / `ask_bot` run finished.
  useEventSubscription<BotRunFinishedPayload>(
    onBotRunFinished,
    (p) => {
      const isError = p.status !== "ok" && p.status !== STOPPED_STATUS;
      const title =
        p.status === STOPPED_STATUS
          ? `${p.botName} stopped`
          : isError
            ? `${p.botName} hit an error`
            : `${p.botName} finished a run`;
      relayNotify({
        kind: isError ? "error" : "automation",
        title,
        body: p.summary,
        view: "bots",
        chatSessionId: p.sessionId || undefined,
        // Successes are quiet (bell only); failures toast + chime even when
        // Relay is focused — a standing job failing in the background is
        // exactly what the user needs to hear about.
        osToast: isError,
        sound: isError ? "alert" : undefined,
        soundOnlyUnfocused: isError ? false : undefined,
      });
    },
    [],
  );
}
