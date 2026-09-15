// Update availability per managed native build (whisper CPU/CUDA builds, TTS
// GPU runtime) — the harness-updater's store slice applied to pinned
// binaries. The boot check seeds it (lib/buildUpdates.ts); the Settings
// speech panel reads it for its Update buttons.
import { create } from "zustand";
import { checkBuildUpdates, type BuildUpdateStatus } from "../lib/ipc";

interface BuildUpdatesState {
  /** Row per build id ("stt-whisper", "stt-whisper-cuda", "tts-gpu"). Empty
   *  until the first check resolves. */
  buildUpdates: Record<string, BuildUpdateStatus>;
  refreshBuildUpdates: () => Promise<void>;
  /** Immediate optimistic flip of one build's row to "current" after a
   *  successful install/update (mirrors markHarnessUpdated): the installer
   *  verified the download and stamped the version marker, so the row is
   *  current the moment the toast fires — a re-check would only lag behind. */
  markBuildUpdated: (id: string) => void;
}

export const useBuildUpdatesStore = create<BuildUpdatesState>((set) => ({
  buildUpdates: {},
  refreshBuildUpdates: async () => {
    const updates = await checkBuildUpdates();
    if (updates) {
      set({ buildUpdates: Object.fromEntries(updates.map((u) => [u.id, u])) });
    }
  },
  markBuildUpdated: (id) =>
    set((s) => {
      const u = s.buildUpdates[id];
      if (!u || !u.updateAvailable) return s; // nothing to flip — keep state
      return {
        buildUpdates: {
          ...s.buildUpdates,
          [id]: { ...u, installedVersion: u.latestVersion ?? u.installedVersion, updateAvailable: false },
        },
      };
    }),
}));
