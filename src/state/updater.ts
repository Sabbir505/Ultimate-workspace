// Auto-updater store. Holds the latest available update (if any), the
// download/install state, and progress. A user who dismisses an update is not
// re-prompted for that same version until the app restarts.
import { create } from "zustand";
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  listenUpdaterInstalled,
  listenUpdaterProgress,
  type UpdateInfo,
  type UpdateProgressPayload,
} from "../lib/ipc";

export type InstallState = "idle" | "downloading" | "installed" | "error";

interface UpdaterState {
  /** Non-null update info when a newer version exists and hasn't been dismissed. */
  update: UpdateInfo | null;
  install: InstallState;
  downloaded: number;
  total: number | null;
  error: string | null;
  /** True while a check is in flight (avoids overlapping timer checks). */
  checking: boolean;
  /** Version the user dismissed with "Later" — not re-prompted until restart.
   *  Without recording it, the next periodic check resurfaces the banner. */
  dismissedVersion: string | null;

  /** Query the endpoint. Called on startup + every 4h, and manually from Settings. */
  check: () => Promise<void>;
  /** Start the download + install flow. Progress arrives via events. */
  startInstall: () => Promise<void>;
  /** "Later" — hide the banner for this version until restart. */
  dismiss: () => void;
  reset: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  update: null,
  install: "idle",
  downloaded: 0,
  total: null,
  error: null,
  checking: false,
  dismissedVersion: null,

  check: async () => {
    if (get().checking) return;
    set({ checking: true });
    try {
      const info = await checkForUpdate();
      if (info && info.updateAvailable) {
        // If the user dismissed this exact version already, don't resurface it.
        if (get().dismissedVersion !== null && get().dismissedVersion === info.version) {
          // Dismissed with "Later" — keep the banner hidden until restart.
        } else if (get().install === "idle") {
          set({ update: info });
        }
      } else if (info && !info.updateAvailable) {
        // App is current — clear any stale banner (e.g. after an update).
        if (get().install === "idle") set({ update: null });
      }
    } catch {
      /* offline / endpoint error — stay quiet */
    } finally {
      set({ checking: false });
    }
  },

  startInstall: async () => {
    if (get().install === "downloading") return;
    set({ install: "downloading", downloaded: 0, total: null, error: null });
    try {
      await downloadAndInstallUpdate();
      // On success the plugin restarts the app; if it doesn't, the
      // `updater:installed` event flips state so the UI can prompt a restart.
    } catch (e: any) {
      set({ install: "error", error: e?.message || String(e) });
    }
  },

  dismiss: () =>
    set((s) => ({
      update: null,
      // Record WHICH version was dismissed so the next periodic check
      // doesn't resurface it (a null-version payload keeps the old value).
      dismissedVersion: s.update?.version ?? s.dismissedVersion,
    })),

  reset: () =>
    set({
      update: null,
      install: "idle",
      downloaded: 0,
      total: null,
      error: null,
    }),
}));

/** Register the download-progress + installed event listeners. Call once at the
 *  app root (next to the other event hooks). */
export function wireUpdaterEvents(): void {
  listenUpdaterProgress((p: UpdateProgressPayload) => {
    useUpdaterStore.setState({ downloaded: p.downloaded, total: p.total });
  });
  listenUpdaterInstalled(() => {
    useUpdaterStore.setState({ install: "installed" });
  });
}

// DEV-ONLY: seeds fake update data so the green Update button is visible for
// UI review without a real published update. Flip SHOW_FAKE_UPDATE to false
// (and remove the seed call in Sidebar.tsx) once the UI is signed off. When
// true, the real periodic check() is skipped so it doesn't clobber the mock
// with an "up to date" response.
export const SHOW_FAKE_UPDATE = import.meta.env.DEV && false;

/** Seed the store with a fake available update (dev review only). */
export function seedFakeUpdate(): void {
  useUpdaterStore.setState({
    update: {
      updateAvailable: true,
      version: "0.5.0",
      pubDate: new Date().toISOString(),
      notes: [
        "### Features",
        "- New green Update button in the sidebar header",
        "- Hover to preview release notes before updating",
        "",
        "### Bug Fixes",
        "- Browsing a project no longer rebinds the active chat to it",
        "- Fixed HTML artifact classification (diagrams vs webapps)",
      ].join("\n"),
    },
    install: "idle",
  });
}
