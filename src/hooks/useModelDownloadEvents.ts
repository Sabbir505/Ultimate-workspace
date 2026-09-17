// Global listener for model download progress events from the Hugging Face
// model market. Writes every progress snapshot into the UI store so the
// toolbar indicator (and any other component) can show live download state
// even when the user navigates away from the Model Market tab.
//
// Terminal states (done / error) also land in the notification center — a
// multi-GB download finishing (or failing) while the user is elsewhere in the
// app is exactly the kind of thing they want to find in the bell.
import { onModelDownloadProgress, type DownloadProgress } from "../lib/ipc";
import { relayNotify } from "../lib/notifyCenter";
import { useEventSubscription } from "./useTauriEvent";
import { useUiStore } from "../state/ui";

// Runtime builds ride the SAME download stream as Hugging Face models but are
// not models — llama.cpp / whisper.cpp are pinned, SHA-verified exe/DLL
// bundles. Progress ids: LLAMA_CUDA_INSTALL_ID (`llama_build.rs`) and the stt
// install ids (`stt.rs`); titles mirror the Server builds card
// (`build_updates.rs`). "Model download finished" for a CUDA zip read wrong.
const BUILD_NAMES: Record<string, string> = {
  "llama-cuda-server": "Llama server (CUDA build)",
  "stt-whisper-server": "Whisper server (CPU build)",
  "stt-whisper-cuda": "Whisper server (CUDA build)",
};

/** Friendly display name for a download-stream id, or null when the id is a
 *  plain model id (`repo::file`) and the caller keeps its own derivation. */
export function downloadDisplayName(id: string): string | null {
  const name = id.split("::")[0] ?? id;
  return BUILD_NAMES[name] ?? null;
}

export function useModelDownloadEvents() {
  const updateModelDownload = useUiStore((s) => s.updateModelDownload);

  useEventSubscription<DownloadProgress>(
    onModelDownloadProgress,
    (p) => {
      updateModelDownload({
        id: p.id,
        state: p.state,
        downloaded: p.downloadedBytes,
        total: p.totalBytes ?? null,
        bps: p.bytesPerSecond,
        finalPath: p.finalPath ?? null,
        error: p.error ?? null,
      });
      const buildName = downloadDisplayName(p.id);
      if (p.state === "done") {
        relayNotify({
          kind: "completed",
          title: buildName ? "Build download finished" : "Model download finished",
          body: `${buildName ?? p.id.split("::")[0] ?? p.id} is ready to run.`,
          view: "settings",
          osToast: false,
        });
      } else if (p.state === "error") {
        relayNotify({
          kind: "error",
          title: buildName ? "Build download failed" : "Model download failed",
          body: p.error || `${buildName ?? p.id} could not be downloaded.`,
          view: "settings",
          osToast: true,
          inAppToast: true,
          sound: "alert",
          soundOnlyUnfocused: false,
        });
      }
    },
    [updateModelDownload],
  );
}
