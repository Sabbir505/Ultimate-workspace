// Global listener for model download progress events from the Hugging Face
// model market. Writes every progress snapshot into the UI store so the
// toolbar indicator (and any other component) can show live download state
// even when the user navigates away from the Model Market tab.
//
// Terminal states (done / error) also land in the notification center — a
// multi-GB download finishing (or failing) while the user is elsewhere in the
// app is exactly the kind of thing they want to find in the bell.
import { useEffect } from "react";
import { onModelDownloadProgress } from "../lib/ipc";
import { relayNotify } from "../lib/notifyCenter";
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
      if (p.state === "done") {
        relayNotify({
          kind: "completed",
          title: "Model download finished",
          body: `${p.id.split("::")[0] ?? p.id} is ready to run.`,
          view: "settings",
          osToast: false,
        });
      } else if (p.state === "error") {
        relayNotify({
          kind: "error",
          title: "Model download failed",
          body: p.error || `${p.id} could not be downloaded.`,
          view: "settings",
          osToast: true,
          inAppToast: true,
          sound: "alert",
          soundOnlyUnfocused: false,
        });
      }
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
