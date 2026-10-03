// Notification funnel — one call sites use to surface an important event.
//
// Every event goes through three layers, each independently gated:
//   1. Notification center (state/notifications.ts) — ALWAYS recorded. The
//      bell badge + panel are the durable record; nothing here is ever lost
//      because the user wasn't looking.
//   2. OS toast — only when DND is off (DND means "don't interrupt me", not
//      "don't keep a record").
//   3. In-app toast + sound — sound only when the relevant focus condition
//      holds (completion chimes only fire when Relay is NOT the focused app;
//      alerts can chime regardless) and the notifySound setting is on.
//
// DND silences layers 2–3 entirely. The center keeps recording so the user
// can catch up from the bell panel afterwards.
import { osNotify } from "./notify";
import { playCompletionChime, playNotifyChime } from "./sound";
import { isAppFocused } from "./appFocus";
import { toastError, toastInfo, toastSuccess } from "./ipc";
import { useNotificationsStore, type RelayNotificationKind } from "../state/notifications";
import { useSettingsStore } from "../state/settings";

/** Which chime to pair with the event. "completion" = the calm falling
 *  two-tone (Relay unfocused only); "alert" = the sharper notify chime. */
type SoundChoice = "completion" | "alert";

export interface RelayNotifyOptions {
  kind: RelayNotificationKind;
  title: string;
  body: string;
  /** Chat session to jump to from the bell panel. */
  chatSessionId?: string;
  /** Terminal pane to focus from the bell panel. */
  paneId?: string;
  /** Overlay view to open from the bell panel. */
  view?: "automations" | "cost" | "settings";
  /** Settings category to preselect when `view` is "settings". */
  settingsCategory?: string;
  /** Show an OS toast (DND-gated). Default false — completions only toast
   *  when the app is unfocused; callers decide. */
  osToast?: boolean;
  /** Also raise the in-app toast stack (bottom-right). */
  inAppToast?: boolean;
  /** Chime choice; omit for silent. */
  sound?: SoundChoice;
  /** Require Relay to be UNFOCUSED for the chime (completion semantics).
   *  Default true when `sound` is set. */
  soundOnlyUnfocused?: boolean;
}

/**
 * True in a pop-out chat window (`?popout=chat`), computed once at module
 * load so it is settled before the event hooks run (audit H37).
 *
 * The pop-out's early return sits AFTER all the event-wiring hooks in App, so
 * `chat:done` / `chat:error` / `chat:approval-request` — broadcast by Tauri to
 * EVERY webview — are handled in BOTH windows. `isViewingSession` is a
 * per-window module singleton: when the main window is focused, the blurred
 * pop-out evaluated its session as "not being viewed" and fired `relayNotify`
 * a second time for the same event (and vice versa for background chats,
 * which neither window was "viewing") — every completion landed twice: two
 * bell rows, a possible double OS toast, and concurrent read-modify-write of
 * the shared `relay.notifications.v1` localStorage key. The pop-out window
 * renders NO notification bell, so its copy of the events is noise by
 * definition: it records nothing and toasts nothing.
 */
const IS_POPOUT_WINDOW = (() => {
  try {
    return new URLSearchParams(window.location.search).get("popout") === "chat";
  } catch {
    return false;
  }
})();

export function relayNotify(opts: RelayNotifyOptions): void {
  if (IS_POPOUT_WINDOW) return;

  // Layer 1: durable record — always.
  useNotificationsStore.getState().push({
    kind: opts.kind,
    title: opts.title,
    body: opts.body,
    chatSessionId: opts.chatSessionId,
    paneId: opts.paneId,
    view: opts.view,
    settingsCategory: opts.settingsCategory,
  });

  const settings = useSettingsStore.getState();
  if (settings.dnd) return; // record-only under Do Not Disturb

  // Layer 2: OS toast.
  if (opts.osToast) void osNotify(opts.title, opts.body);

  // Layer 3: in-app toast + sound.
  if (opts.inAppToast) {
    if (opts.kind === "error" || opts.kind === "crash") toastError(opts.title, opts.body);
    else if (opts.kind === "completed") toastSuccess(opts.title, opts.body);
    else toastInfo(`${opts.title} — ${opts.body}`);
  }
  if (opts.sound && settings.notifySound) {
    const onlyUnfocused = opts.soundOnlyUnfocused ?? true;
    if (!onlyUnfocused || !isAppFocused()) {
      if (opts.sound === "completion") playCompletionChime();
      else playNotifyChime();
    }
  }
}
