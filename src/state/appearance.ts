// Sidebar art state — the image for the sidebar header's background, either a
// bundled stock preset (URL into public/sideart) or a user upload (data URL
// from read_sidebar_art_data). Loaded once per boot; the Appearance panel
// refreshes after every import/pick/clear so the header follows instantly.
import { create } from "zustand";
import {
  getSetting,
  readSidebarArtData,
  sidebarArtPresetUrl,
} from "../lib/ipc";

interface AppearanceState {
  /** Resolved image URL for the header (preset path or data URL). */
  artData: string | null;
  /** Selected preset id, when the art is a stock image. */
  artPreset: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
  /** Optimistic set so the sidebar updates the instant a pick lands. */
  setArt: (art: { data: string | null; preset: string | null }) => void;
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  artData: null,
  artPreset: null,
  loaded: false,
  refresh: async () => {
    try {
      const preset = (await getSetting("sidebar.artPreset"))?.trim() || null;
      if (preset) {
        set({ artData: sidebarArtPresetUrl(preset), artPreset: preset, loaded: true });
        return;
      }
      const data = await readSidebarArtData();
      set({ artData: data ?? null, artPreset: null, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  setArt: ({ data, preset }) =>
    set({
      artData: preset ? sidebarArtPresetUrl(preset) : data,
      artPreset: preset,
      loaded: true,
    }),
}));
