// Automation run lifecycle wiring. The backend emits `automation:run-started`
// when a run begins executing and `automation:run-finished` from the
// scheduler's finalize path (app-open runs only — headless runs go to the
// webhook/email channels). Start pre-creates the run-log chat's streaming
// entry so its tokens stream into the chat view; finish lands in the
// notification center (bell) so runs are auditable later, clears any
// streaming state the run still holds, and refreshes the automations store
// so the view's status column and Past Runs list stay live. Failures
// additionally become OS toasts with the optional chime, DND-aware.
import { useEffect } from "react";
import {
  listenAutomationRunFinished,
  listenAutomationRunStarted,
} from "../lib/ipc";
import { relayNotify } from "../lib/notifyCenter";
import { useAutomationsStore } from "../state/automations";
import { useChatStore } from "../state/chat";

export function useAutomationEvents(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenStart: (() => void) | undefined;
    void listenAutomationRunStarted(({ chatSessionId }) => {
      // Mark the run-log chat as streaming so onToken accepts the run's
      // tokens and an open (or opened mid-run) chat shows the live turn.
      useChatStore.getState().beginRemoteTurn(chatSessionId);
    }).then((u) => {
      if (disposed) u();
      else unlistenStart = u;
    });
    void listenAutomationRunFinished((p) => {
      // Refresh the list + status regardless of outcome.
      const store = useAutomationsStore.getState();
      // Promise.resolve wrapper: tolerate a sync/mock load() that returns
      // undefined while still swallowing real rejections (M9).
      if (store.loaded) void Promise.resolve(store.load()).catch(() => {});

      // Release the streaming entry the run began with. Providers' one-shot
      // path never emits chat:done, and failure paths can die before a
      // terminal event — without this the run-log chat would show a stuck
      // "working" bubble until restart. Also refetches the reply for an
      // active viewer.
      void useChatStore.getState().endRemoteTurn(p.chatSessionId);

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
      unlistenStart?.();
    };
  }, []);
}
