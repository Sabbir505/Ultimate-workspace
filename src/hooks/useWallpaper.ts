// Applies the app wallpaper (Settings → Appearance → App wallpaper) to the
// document root: the image lands in --app-wallpaper, a data-wallpaper
// attribute switches the shell CSS over to the translucent-canvas mode, and
// --wallpaper-scrim-a carries the user's dim level. Mirrors useTheme()'s
// apply-tokens-to-:root approach; called alongside it in App.tsx so both
// app windows (main + pop-out chat) pick it up.
import { useEffect } from "react";
import { useAppearanceStore } from "../state/appearance";

export function useWallpaper(): void {
  const wallpaperData = useAppearanceStore((s) => s.wallpaperData);
  const wallpaperDim = useAppearanceStore((s) => s.wallpaperDim);
  const loaded = useAppearanceStore((s) => s.loaded);
  const refresh = useAppearanceStore((s) => s.refresh);

  // The appearance store is refreshed by the sidebar in the main window; in
  // any other window (pop-out chat) this hook is the only loader.
  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  useEffect(() => {
    const root = document.documentElement;
    if (wallpaperData) {
      root.dataset.wallpaper = "on";
      root.style.setProperty("--app-wallpaper", `url("${wallpaperData}")`);
    } else {
      delete root.dataset.wallpaper;
      root.style.removeProperty("--app-wallpaper");
    }
  }, [wallpaperData]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--wallpaper-scrim-a",
      (wallpaperDim / 100).toFixed(2),
    );
  }, [wallpaperDim]);
}
