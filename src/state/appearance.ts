// Sidebar art + app wallpaper state. Each is an image — either a bundled
// stock preset (URL into public/sideart) or a user upload (data URL from
// read_sidebar_art_data / read_app_wallpaper_data). Loaded once per boot;
// the Appearance panel refreshes after every import/pick/clear so the UI
// follows instantly. The wallpaper additionally carries a dim level
// (0–100) that scales the readability scrim painted over the image.
import { create } from "zustand";
import {
  getSetting,
  readAppWallpaperData,
  readSidebarArtData,
  setSetting,
  sidebarArtPresetUrl,
} from "../lib/ipc";

interface AppearanceState {
  /** Resolved image URL for the sidebar header (preset path or data URL). */
  artData: string | null;
  /** Selected sidebar preset id, when the art is a stock image. */
  artPreset: string | null;
  /** Resolved image URL for the app wallpaper (preset path or data URL). */
  wallpaperData: string | null;
  /** Selected wallpaper preset id, when the wallpaper is a stock image. */
  wallpaperPreset: string | null;
  /** Wallpaper scrim strength, 0–100 (50 = default readability dim). */
  wallpaperDim: number;
  loaded: boolean;
  refresh: () => Promise<void>;
  /** Optimistic set so the sidebar updates the instant a pick lands. */
  setArt: (art: { data: string | null; preset: string | null }) => void;
  /** Optimistic set so the wallpaper updates the instant a pick lands. */
  setWallpaper: (wallpaper: { data: string | null; preset: string | null }) => void;
  /** Set + persist the wallpaper dim level. */
  setWallpaperDim: (dim: number) => void;
}

const WALLPAPER_DIM_SETTING = "app.wallpaperDim";
const DEFAULT_WALLPAPER_DIM = 50;

/** Dim (0-100) → the app canvas's veil over the wallpaper, as a percentage
 *  for `color-mix(--bg-tint N%, transparent)`.
 *
 *  The slider drives TWO layers: the scrim painted on the image, and this
 *  canvas tint the content surfaces add on top. The tint used to be a fixed
 *  76%, so 0% dim still buried the image under a permanent veil — the slider
 *  appeared to do nothing and the app could never show the wallpaper clearly.
 *  Now 0% leaves a light veil (image plainly visible) and 100% is a heavy one
 *  (text comfortably readable). Kept here so the shell and the settings
 *  preview cannot disagree about what a given dim looks like. */
export function wallpaperCanvasTint(dim: number): number {
  const clamped = Math.max(0, Math.min(100, Math.round(dim)));
  return Math.round(20 + (clamped / 100) * 65);
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  artData: null,
  artPreset: null,
  wallpaperData: null,
  wallpaperPreset: null,
  wallpaperDim: DEFAULT_WALLPAPER_DIM,
  loaded: false,
  refresh: async () => {
    try {
      const preset = (await getSetting("sidebar.artPreset"))?.trim() || null;
      if (preset) {
        set({ artData: sidebarArtPresetUrl(preset), artPreset: preset, loaded: true });
      } else {
        const data = await readSidebarArtData();
        set({ artData: data ?? null, artPreset: null, loaded: true });
      }
    } catch {
      set({ loaded: true });
    }
    try {
      const wpPreset = (await getSetting("app.wallpaperPreset"))?.trim() || null;
      if (wpPreset) {
        set({ wallpaperData: sidebarArtPresetUrl(wpPreset), wallpaperPreset: wpPreset });
      } else {
        const data = await readAppWallpaperData();
        set({ wallpaperData: data ?? null, wallpaperPreset: null });
      }
      // Only adopt a stored dim when one is actually there. `getSetting`
      // returns null when unset, and `Number(null)` is 0 — so a fresh install
      // (or any session before the slider is first touched) coerced the
      // missing value to 0% and overwrote DEFAULT_WALLPAPER_DIM, leaving the
      // wallpaper with NO scrim at all: bright, unreadable text over the
      // image, and a slider sitting at 0 instead of 50.
      const dimStored = await getSetting(WALLPAPER_DIM_SETTING);
      const dimRaw = dimStored == null ? Number.NaN : Number(dimStored);
      if (Number.isFinite(dimRaw) && dimRaw >= 0 && dimRaw <= 100) {
        set({ wallpaperDim: dimRaw });
      }
    } catch {
      // Wallpaper stays unset; the flat palette shows through.
    }
  },
  setArt: ({ data, preset }) =>
    set({
      artData: preset ? sidebarArtPresetUrl(preset) : data,
      artPreset: preset,
      loaded: true,
    }),
  setWallpaper: ({ data, preset }) =>
    set({
      wallpaperData: preset ? sidebarArtPresetUrl(preset) : data,
      wallpaperPreset: preset,
    }),
  setWallpaperDim: (dim) => {
    const clamped = Math.max(0, Math.min(100, Math.round(dim)));
    set({ wallpaperDim: clamped });
    void setSetting(WALLPAPER_DIM_SETTING, String(clamped)).catch(() => {});
  },
}));
