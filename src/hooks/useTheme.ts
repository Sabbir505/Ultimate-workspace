// Applies the theme setting (§7.2) to the document root via data-theme, with
// "system" following the OS appearance through matchMedia. A custom theme
// (roadmap #19) layers inline CSS custom-property overrides on top of the
// resolved base mode; switching base mode or deselecting the custom theme
// clears those overrides so the built-in palette shows through again.
import { useEffect } from "react";
import { useSettingsStore } from "../state/settings";
import { KNOWN_THEME_TOKENS } from "../lib/themes";

export function useTheme(): void {
  const theme = useSettingsStore((s) => s.theme);
  const customThemeId = useSettingsStore((s) => s.customThemeId);
  const customThemes = useSettingsStore((s) => s.customThemes);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const active = customThemeId ? customThemes.find((t) => t.id === customThemeId) ?? null : null;

    const apply = () => {
      // A custom theme with an explicit `base` forces its light/dark scope;
      // otherwise the base follows the mode setting exactly as before.
      const resolved = active?.base ?? (theme === "system" ? (media.matches ? "dark" : "light") : theme);
      root.dataset.theme = resolved;

      if (active) {
        for (const [k, v] of Object.entries(active.colors)) {
          root.style.setProperty(`--${k}`, v);
        }
      } else {
        // Clear any inline overrides left by a previously active custom theme
        // (inline style props shadow the stylesheet, so they must be removed
        // rather than just left alone). Only touches keys we set — the base
        // palette lives in stylesheets, not inline styles.
        for (const k of KNOWN_THEME_TOKENS) {
          root.style.removeProperty(`--${k}`);
        }
      }
    };
    apply();

    // Follow OS appearance changes only when the base mode is "system" AND no
    // custom theme pins its own scope.
    if (theme === "system" && !active?.base) {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
  }, [theme, customThemeId, customThemes]);
}
