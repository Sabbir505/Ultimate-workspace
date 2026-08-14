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
import { safeListen, browserNavigateTab } from "../lib/ipc";
import { openSession } from "../lib/sessionLauncher";
import { playNotifyChime } from "../lib/sound";
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

/** Per-pane notification cooldown: once a pane has notified, suppress further
 *  notifications for it until the cooldown elapses OR the user focuses it
 *  (focusing clears the cooldown so the next completion re-notifies). Stops a
 *  pane that flaps working→waiting→working→waiting from firing a toast + chime
 *  on every transition. Maps paneId -> last-notified epoch ms. */
const notifyCooldownMs = 30_000;
const lastNotifiedAt = new Map<string, number>();

function clearNotifyCooldown(paneId: string): void {
  lastNotifiedAt.delete(paneId);
}

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

/** Sessions currently being opened on behalf of the phone app. The relay emits
 *  `mobile:session-open-requested` on BOTH create and spawn, which can arrive
 *  back-to-back for the same session — this guard serializes the refresh-then-
 *  open sequence so the session doesn't get two panes / two PTYs. */
const mobileOpening = new Set<string>();

async function openSessionFromMobile(sessionId: string): Promise<void> {
  if (mobileOpening.has(sessionId)) return;
  mobileOpening.add(sessionId);
  try {
    // The session row may have been created seconds ago on the phone — pull a
    // fresh list before looking it up, then open it through the normal
    // launcher path (terminal tab in the ToolPanel + PTY spawn).
    await useProjectsStore.getState().refreshSessions();
    const session = useProjectsStore.getState().sessions.find((s) => s.id === sessionId);
    if (session) await openSession(session);
  } finally {
    mobileOpening.delete(sessionId);
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
        // unless Do Not Disturb is on. Throttled per-pane so a flapping pane
        // (working→waiting→working→waiting) doesn't spam toasts + chimes.
        if (prev === "working" && (state === "waiting" || state === "diff_ready")) {
          const paneIsFocused =
            panesStore.focusedPaneId === paneId && typeof document !== "undefined" && document.hasFocus();
          const settings = useSettingsStore.getState();
          if (!paneIsFocused && !settings.dnd && pane && pane.data.kind === "terminal") {
            const now = Date.now();
            const last = lastNotifiedAt.get(paneId) ?? 0;
            if (now - last >= notifyCooldownMs) {
              lastNotifiedAt.set(paneId, now);
              const sessionId = pane.data.sessionId;
              const session = sessionId
                ? useProjectsStore.getState().sessions.find((s) => s.id === sessionId)
                : null;
              const name = session ? sessionDisplayTitle(session.title) : pane.data.label;
              const verb = state === "diff_ready" ? "has a diff ready for review" : "is waiting for input";
              void notify("Conduit", `${name} ${verb}`);
              if (settings.notifySound) playNotifyChime();
            }
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

    // Phone-started sessions: the mobile relay asks the desktop to open the
    // session in a ToolPanel terminal tab (create + spawn both funnel through here).
    unlistens.push(
      safeListen<{ sessionId: string }>("mobile:session-open-requested", ({ sessionId }) => {
        void openSessionFromMobile(sessionId);
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
        if (existing && existing.data.kind === "browser") {
          // If the browser was minimized, restore it so the user sees the
          // navigation. Then navigate the existing browser to the detected URL.
          if (existing.data.collapsed) {
            panesStore.toggleBrowserCollapsed(existing.paneId);
          }
          const tab = existing.data.tabs[existing.data.activeTabIndex];
          if (tab) {
            panesStore.setBrowserUrl(existing.paneId, url, tab.tabId);
            // The native webview (Windows) does NOT watch the zustand store —
            // without this explicit navigate it keeps showing the old page
            // while the address bar claims we're already at the new URL.
            void browserNavigateTab(existing.paneId, tab.tabId, url).catch(() => {});
          }
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
