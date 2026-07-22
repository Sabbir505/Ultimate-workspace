// Backend event wiring: pane state transitions (§7.3) + notifications (§7.13),
// process exits, harness session-id capture, and cost updates. Registered
// inside a React effect — never at module import time — so jsdom tests that
// import stores don't touch the Tauri event bridge.
import { useEffect } from "react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { safeListen } from "../lib/ipc";
import { sessionDisplayTitle } from "../lib/sessionTitle";
import { usePanesStore } from "../state/panes";
import { useProjectsStore } from "../state/projects";
import { useSettingsStore } from "../state/settings";
import type {
  BrowserUrlDetectedPayload,
  CostUpdatedPayload,
  HarnessIdPayload,
  PtyExitPayload,
  PtyStatePayload,
} from "../types";

async function notify(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === "granted";
    }
    if (granted) sendNotification({ title, body });
  } catch {
    // Notification plugin unavailable (e.g. dev browser) — badges still update.
  }
}

export function usePtyEvents(): void {
  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(
      safeListen<PtyStatePayload>("pty:state", ({ paneId, state }) => {
        const panesStore = usePanesStore.getState();
        const pane = panesStore.panes.find((p) => p.paneId === paneId);
        const prev = pane?.state;
        panesStore.setPaneState(paneId, state);

        // §7.13: notify on working -> waiting/diff_ready for unfocused panes,
        // unless Do Not Disturb is on.
        if (prev === "working" && (state === "waiting" || state === "diff_ready")) {
          const paneIsFocused =
            panesStore.focusedPaneId === paneId && typeof document !== "undefined" && document.hasFocus();
          if (!paneIsFocused && !useSettingsStore.getState().dnd && pane && pane.data.kind === "terminal") {
            const sessionId = pane.data.sessionId;
            const session = sessionId
              ? useProjectsStore.getState().sessions.find((s) => s.id === sessionId)
              : null;
            const name = session ? sessionDisplayTitle(session.title) : pane.data.label;
            const verb = state === "diff_ready" ? "has a diff ready for review" : "is waiting for input";
            void notify("Conduit", `${name} ${verb}`);
          }
        }
      }),
    );

    unlistens.push(
      safeListen<PtyExitPayload>("pty:exit", ({ paneId, code }) => {
        usePanesStore.getState().markPaneExited(paneId, code);
      }),
    );

    unlistens.push(
      safeListen<HarnessIdPayload>("session:harness-id", ({ sessionId, harnessSessionId }) => {
        useProjectsStore.getState().setHarnessSessionId(sessionId, harnessSessionId);
      }),
    );

    unlistens.push(
      safeListen<CostUpdatedPayload>("cost:updated", () => {
        // The cost dashboard refetches on its own listener; nothing global to do.
      }),
    );

    unlistens.push(
      safeListen<BrowserUrlDetectedPayload>("browser:url_detected", ({ paneId, url }) => {
        // The backend only emits this for LOCAL dev-server / preview URLs
        // (localhost, 127.x, 0.0.0.0, *.local) — remote URLs printed by CLIs
        // no longer hijack the browser. Open the preview in the built-in
        // browser pane, reusing an existing one or creating one if none.
        const panesStore = usePanesStore.getState();
        const existing = panesStore.panes.find((p) => p.data.kind === "browser");
        if (existing) {
          // Navigate existing browser pane to the detected URL
          panesStore.setBrowserUrl(existing.paneId, url);
        } else {
          // Open a new browser pane with the detected URL
          panesStore.addPane({ kind: "browser", url, projectId: null });
        }
      }),
    );

    return () => {
      for (const u of unlistens) void u.then((fn) => fn());
    };
  }, []);
}
