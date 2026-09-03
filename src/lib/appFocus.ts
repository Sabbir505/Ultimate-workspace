// App-level focus tracking (module singleton). Several notification surfaces
// need a synchronous "is Relay the foreground app right now?" check from
// non-React contexts (event hooks deciding whether to chime/OS-toast); a
// zustand selector can't be read from those call sites without a re-render
// loop, so the latest state lives in a module variable instead.
//
// Two signals are tracked because neither is complete on its own:
//  - window focus/blur covers the dev browser (no Tauri runtime).
//  - Tauri's onFocusChanged covers the packaged app, where clicking a NATIVE
//    child webview (browser panes) blurs the HTML window without a blur event.
import { getCurrentWindow } from "@tauri-apps/api/window";

let focused = typeof document !== "undefined" ? document.hasFocus() : true;
let initialized = false;

function setFocused(next: boolean): void {
  focused = next;
}

/** Start tracking. Idempotent — safe to call from every App mount (main
 *  window + pop-out chats each run this, listeners are cheap). */
export function initAppFocusTracking(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("focus", () => setFocused(true));
  window.addEventListener("blur", () => setFocused(false));
  // visibilitychange keeps the flag honest when the window is minimized:
  // minimizing a window fires blur on some platforms but not all.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") setFocused(false);
  });
  // Packaged-app signal. getCurrentWindow() is harmless in a plain browser —
  // the invoke underneath fails, so tolerate the rejection.
  try {
    void getCurrentWindow()
      .onFocusChanged(({ payload }) => setFocused(payload === true))
      .catch(() => {});
  } catch {
    /* not running under Tauri — window focus/blur above is enough */
  }
}

/** Synchronous focus probe for event handlers. Defaults to true when focus
 *  signals are unavailable so a false "unfocused" reading never spams. */
export function isAppFocused(): boolean {
  return focused;
}
