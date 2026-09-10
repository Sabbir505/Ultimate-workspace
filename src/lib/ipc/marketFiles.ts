// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke } from "../ipcCore";

// ---- Local Models market: file management + auto-sidecar download ----

export const deleteDownloadedModel = (path: string) =>
  safeInvoke<void>("delete_downloaded_model", { path });

export const downloadMmproj = (
  repoId: string,
  mmprojFilename?: string,
) =>
  safeInvoke<void>("download_mmproj", { repoId, mmprojFilename });
