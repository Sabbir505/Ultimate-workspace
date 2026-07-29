// Dev-only live memory counter for pane headers. Polls the `pane_memory`
// backend command (PTY child RSS, or the app process RSS for browser panes)
// every 2s for the currently-visible panes, and exposes the latest value per
// paneId. No-op outside dev mode (import.meta.env.DEV) so production builds
// carry no polling overhead and no header chip renders.
//
// Usage: call usePaneMemory() once near the root; read paneMemory[paneId]
// from the store to render a small chip in each pane header.
import { useEffect } from "react";
import { paneMemory } from "../lib/ipc";
import { usePanesStore } from "../state/panes";

const POLL_MS = 2000;

export function usePaneMemory(): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (cancelled) return;
      const panes = usePanesStore.getState().panes;
      // Only poll panes that are actually mounted (visible). Minimized browser
      // panes are skipped — their webview isn't live-rendering anyway.
      const visible = panes.filter(
        (p) => !(p.data.kind === "browser" && p.data.collapsed),
      );
      await Promise.all(
        visible.map(async (p) => {
          try {
            const bytes = await paneMemory(p.paneId);
            if (cancelled) return;
            usePanesStore.getState().setPaneMemory(p.paneId, bytes ?? 0);
          } catch {
            // pane gone or command failed — leave the last value.
          }
        }),
      );
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
}
