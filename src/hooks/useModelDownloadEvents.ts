// Global listener for model download progress events from the Hugging Face
// model market. Writes every progress snapshot into the UI store so the
// toolbar indicator (and any other component) can show live download state
// even when the user navigates away from the Model Market tab.
import { useEffect } from "react";
import { onModelDownloadProgress } from "../lib/ipc";
import { useUiStore } from "../state/ui";

export function useModelDownloadEvents() {
  const updateModelDownload = useUiStore((s) => s.updateModelDownload);

  useEffect(() => {
    let stale = false;
    let unlisten: (() => void) | null = null;
    void onModelDownloadProgress((p) => {
      if (stale) return;
      updateModelDownload({
        id: p.id,
        state: p.state,
        downloaded: p.downloadedBytes,
        total: p.totalBytes ?? null,
        bps: p.bytesPerSecond,
        finalPath: p.finalPath ?? null,
        error: p.error ?? null,
      });
    }).then((u) => {
      if (stale) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      stale = true;
      unlisten?.();
    };
  }, [updateModelDownload]);
}
