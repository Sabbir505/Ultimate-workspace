// Core transport for the Tauri IPC wrappers (CONTRACT.md): the runtime
// guard, safeInvoke/safeListen, and the global toast helpers. Domain wrapper
// modules (src/lib/ipc/*.ts) build on this; src/lib/ipc.ts re-exports
// everything so consumers keep a single import site.
//
// Every invoke is routed through `safeInvoke`, which rejects quietly (with a
// console warning) when the Tauri runtime is absent — e.g. inside jsdom tests
// or a plain `vite dev` browser session. Event listeners go through
// `safeListen` for the same reason: they are registered lazily (React
// effects / bootstrap), never at module import time.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useUiStore } from "../state/ui";

function tauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Exported so components can pick a non-Tauri fallback (e.g. the browser
 *  pane's iframe mode under jsdom / plain vite dev). */
export const tauriRuntimeAvailable = tauriAvailable;

export async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!tauriAvailable()) {
    // Outside Tauri there is no backend; resolve with a benign empty value so
    // bootstrap code and tests don't explode. Callers treat null as "empty".
    console.warn(`[relay] invoke("${cmd}") skipped — Tauri runtime not available`);
    return null as T;
  }
  return invoke<T>(cmd, args);
}

export async function safeListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!tauriAvailable()) return () => {};
  try {
    return await listen<T>(event, (e) => handler(e.payload));
  } catch (err) {
    console.warn(`[relay] listen("${event}") failed`, err);
    return () => {};
  }
}

// --- Global toast helpers (the app's error surface) ---
// Use these at IPC call sites instead of bare console.warn/console.error so
// failures (git push, downloads, connector calls, …) are visible to the user
// in the bottom-right toast stack, not just in devtools.

function errorDetail(err: unknown): string | undefined {
  if (err == null) return undefined;
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

export function toastError(message: string, err?: unknown): void {
  const detail = errorDetail(err);
  if (detail) console.warn(`[relay] ${message}:`, detail);
  useUiStore.getState().pushToast("error", message, detail);
}

export function toastInfo(message: string): void {
  useUiStore.getState().pushToast("info", message);
}

export function toastSuccess(message: string, detail?: string): void {
  useUiStore.getState().pushToast("success", message, detail);
}

