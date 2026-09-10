import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { safeListen } from "../lib/ipc";

/** Subscribe for the lifetime of one effect run via any `safeListen`-shaped
 *  subscriber — the raw event form `useTauriEvent`, or one of the named
 *  per-domain wrappers in lib/ipc.ts (`onBudgetAlert`,
 *  `listenBrowserNavigatedTab`, …) that pin the event name and payload type.
 *
 *  Handles the listen()-promise race the same way everywhere: if the effect
 *  cleans up before the subscription resolves, the real unlisten is invoked
 *  late instead of dropped (a dropped unlisten leaks the handler — and its
 *  closure — for the app's lifetime), and an event delivered to the stale
 *  closure after cleanup is ignored.
 *
 *  `handler` is re-captured on every `deps` change; pass every value it
 *  closes over. */
export function useEventSubscription<T>(
  subscribe: (handler: (payload: T) => void) => Promise<UnlistenFn>,
  handler: (payload: T) => void,
  deps: readonly unknown[] = [],
): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const listenReady = subscribe((payload) => {
      if (!disposed) handler(payload);
    });
    void listenReady.then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** `useEventSubscription` for a raw Tauri event name. */
export function useTauriEvent<T>(
  event: string,
  handler: (payload: T) => void,
  deps: readonly unknown[] = [],
): void {
  useEventSubscription<T>((h) => safeListen<T>(event, h), handler, [event, ...deps]);
}
