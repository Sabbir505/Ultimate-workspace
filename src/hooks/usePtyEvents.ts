// Backend event wiring: pane state transitions (§7.3) + notifications (§7.13),
// process exits, harness session-id capture, and cost updates. Registered
// inside a React effect — never at module import time — so jsdom tests that
// import stores don't touch the Tauri event bridge.
import { useEffect } from "react";
import { safeListen, browserNavigateTab } from "../lib/ipc";
import { openSession } from "../lib/sessionLauncher";
import { isAppFocused } from "../lib/appFocus";
import { relayNotify } from "../lib/notifyCenter";
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

/** When each pane's current "working" stretch began (epoch ms). A freshly
 *  spawned pane prints its banner (any output → working) and flips to
 *  waiting after the first 1.5s of silence — notifying on that is what made
 *  "open a new chat, switch to another app" produce a stray waiting toast
 *  before the user sent anything. A pane must actually WORK for a while
 *  before its going-quiet is worth interrupting anyone. */
const workingSince = new Map<string, number>();
const minWorkingMs = 5_000;

function clearNotifyCooldown(paneId: string): void {
  lastNotifiedAt.delete(paneId);
  workingSince.delete(paneId);
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

        // Track the current working stretch (see workingSince). Cleared on
        // any non-working state so the next stretch starts fresh.
        const workingStart = workingSince.get(paneId);
        if (state === "working") {
          if (workingStart == null) workingSince.set(paneId, Date.now());
        } else {
          workingSince.delete(paneId);
        }

        // Focusing a pane clears its notify cooldown (the documented §7.13
        // behavior — the user has seen it, so the next completion should
        // notify again). Previously this was promised in the comment but
        // never wired (audit L3).
        if (panesStore.focusedPaneId === paneId) {
          clearNotifyCooldown(paneId);
        }
        // A closed pane's cooldown entry is dead weight — drop it.
        if (!pane && lastNotifiedAt.has(paneId)) {
          clearNotifyCooldown(paneId);
        }

        // §7.13: notify on working -> waiting/diff_ready for unfocused panes,
        // unless Do Not Disturb is on. Throttled per-pane so a flapping pane
        // (working→waiting→working→waiting) doesn't spam toasts + chimes.
        // The pane must also have genuinely worked for a while: a just-
        // spawned pane goes working→waiting on its first banner + silence
        // (nothing to notify about), while a real turn or command runs long
        // enough to clear minWorkingMs.
        if (prev === "working" && (state === "waiting" || state === "diff_ready")) {
          const paneIsFocused =
            panesStore.focusedPaneId === paneId && isAppFocused();
          const settings = useSettingsStore.getState();
          const workedLongEnough =
            workingStart != null && Date.now() - workingStart >= minWorkingMs;
          if (
            !paneIsFocused &&
            !settings.dnd &&
            pane &&
            pane.data.kind === "terminal" &&
            workedLongEnough
          ) {
            const now = Date.now();
            const last = lastNotifiedAt.get(paneId) ?? 0;
            if (now - last >= notifyCooldownMs) {
              lastNotifiedAt.set(paneId, now);
              const sessionId = pane.data.sessionId;
              const session = sessionId
                ? useProjectsStore.getState().sessions.find((s) => s.id === sessionId)
                : null;
              const name = session ? sessionDisplayTitle(session.title) : pane.data.label;
              const verb =
                state === "diff_ready"
                  ? "has changes ready for your review"
                  : session
                    ? "is waiting for you"
                    : "is ready for your next command";
              relayNotify({
                kind: "completed",
                title: "Relay",
                body: `${name} ${verb}`,
                paneId,
                chatSessionId: sessionId ?? undefined,
                // Relay may be focused (pane in the background) — an OS toast
                // would be intrusive; the calm chime is focus-gated anyway.
                osToast: !isAppFocused(),
                inAppToast: true,
                sound: "completion",
              });
            }
          }
        }
      }),
    );

    unlistens.push(
      safeListen<PtyExitPayload>("pty:exit", ({ paneId, code }) => {
        usePanesStore.getState().markPaneExited(paneId, code);
        workingSince.delete(paneId); // dead panes can't resume a working stretch
        // A nonzero exit while the user wasn't interacting with the pane is a
        // crash, not a completion — surface it in the bell + toast stack. The
        // user closing a pane kills its process (also a nonzero/None code), so
        // only notify when the pane still exists and wasn't intentionally
        // closed (markPaneExited runs before removal on user close; here the
        // pane remains mounted with exited:true).
        const pane = usePanesStore.getState().panes.find((p) => p.paneId === paneId);
        if (pane && pane.data.kind === "terminal" && code != null && code !== 0) {
          relayNotify({
            kind: "crash",
            title: "Agent process exited",
            body: `${pane.data.label} exited with code ${code}.`,
            paneId,
            chatSessionId: pane.data.sessionId ?? undefined,
            osToast: !isAppFocused(),
            inAppToast: true,
            sound: "alert",
          });
        }
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
