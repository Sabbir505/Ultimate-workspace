// Applies the app wallpaper (Settings → Appearance → App wallpaper) to the
// document root: the image lands in --app-wallpaper, a data-wallpaper
// attribute switches the shell CSS over to the translucent-canvas mode, and
// --wallpaper-scrim-a carries the user's dim level. Mirrors useTheme()'s
// apply-tokens-to-:root approach; called alongside it in App.tsx so both
// app windows (main + pop-out chat) pick it up.
import { useEffect } from "react";
import { useAppearanceStore, wallpaperCanvasTint } from "../state/appearance";
import { useObjectUrl } from "./useObjectUrl";

export function useWallpaper(): void {
  const wallpaperData = useAppearanceStore((s) => s.wallpaperData);
  const wallpaperDim = useAppearanceStore((s) => s.wallpaperDim);
  const loaded = useAppearanceStore((s) => s.loaded);
  const refresh = useAppearanceStore((s) => s.refresh);
  // Hand CSS a blob: URL, not the raw data: URL — a CSS custom property
  // silently stops accepting values past ~1.3MB, so a real photo (megabytes
  // of base64) was dropped on the floor and never appeared. The blob URL is
  // ~50 chars at any size; CSP already allows blob: in img-src.
  const wallpaperUrl = useObjectUrl(wallpaperData);

  // The appearance store is refreshed by the sidebar in the main window; in
  // any other window (pop-out chat) this hook is the only loader.
  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  useEffect(() => {
    const root = document.documentElement;
    if (wallpaperUrl) {
      root.dataset.wallpaper = "on";
      root.style.setProperty("--app-wallpaper", `url("${wallpaperUrl}")`);
    } else {
      delete root.dataset.wallpaper;
      root.style.removeProperty("--app-wallpaper");
    }
    // Clear on unmount. `useObjectUrl` revokes the blob when the last holder
    // releases it, and a revoked blob: URL still sitting in the custom
    // property paints as NO image — so a window that unmounted this hook (or
    // a wallpaper that was cleared while a stale URL remained) would blank the
    // background while the store still claimed a wallpaper was set.
    return () => {
      delete root.dataset.wallpaper;
      root.style.removeProperty("--app-wallpaper");
    };
  }, [wallpaperUrl]);

  useEffect(() => {
    const root = document.documentElement;
    // The Dim slider drives BOTH layers: the scrim on the image AND the veil
    // the content surfaces add over it. Driving only the scrim left the canvas
    // tint pinned at 76%, so 0% dim still looked buried and the slider read as
    // broken. See wallpaperCanvasTint for the range.
    root.style.setProperty("--wallpaper-scrim-a", (wallpaperDim / 100).toFixed(2));
    root.style.setProperty(
      "--wallpaper-canvas-tint",
      `${wallpaperCanvasTint(wallpaperDim)}%`,
    );
  }, [wallpaperDim]);
}
