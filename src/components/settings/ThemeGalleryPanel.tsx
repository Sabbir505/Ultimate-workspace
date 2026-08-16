// Custom theme gallery (roadmap #19): import themes as JSON (a `name` +
// `colors` override map), preview them with swatches, apply one on top of the
// base light/dark theme, and export/delete. The active overlay persists in
// the settings store; useTheme() applies it to <html>.
import { useState } from "react";
import { useSettingsStore } from "../../state/settings";
import {
  CORE_THEME_TOKENS,
  parseThemeJson,
  themeJson,
  themeSwatchColors,
  type CustomTheme,
} from "../../lib/themes";
import { readFileText, toastError, toastSuccess } from "../../lib/ipc";

export function ThemeGalleryPanel() {
  const customThemes = useSettingsStore((s) => s.customThemes);
  const customThemeId = useSettingsStore((s) => s.customThemeId);
  const setCustomTheme = useSettingsStore((s) => s.setCustomTheme);
  const importCustomTheme = useSettingsStore((s) => s.importCustomTheme);
  const deleteCustomTheme = useSettingsStore((s) => s.deleteCustomTheme);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importTheme = async () => {
    setError(null);
    setBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        filters: [{ name: "Theme JSON", extensions: ["json"] }],
        multiple: false,
      });
      // `open` resolves null on cancel (or an array when multiple: true).
      if (!picked || typeof picked !== "string") return;
      const raw = await readFileText(picked);
      if (!raw) {
        setError("Could not read the selected file.");
        return;
      }
      const result = parseThemeJson(raw);
      if (!result.ok) {
        setError(result.errors.join(" "));
        return;
      }
      importCustomTheme(result.theme);
      toastSuccess(`Imported theme "${result.theme.name}"`);
    } catch (err) {
      setError(`Import failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const exportTheme = async (theme: CustomTheme) => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        defaultPath: `${theme.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "theme"}.json`,
        filters: [{ name: "Theme JSON", extensions: ["json"] }],
      });
      if (!dest) return;
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(dest, themeJson(theme));
      toastSuccess(`Exported "${theme.name}"`);
    } catch (err) {
      toastError("Export failed", err);
    }
  };

  const removeTheme = (theme: CustomTheme) => {
    if (!window.confirm(`Delete theme "${theme.name}"?`)) return;
    deleteCustomTheme(theme.id);
  };

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Custom themes</h3>
      </div>
      <p className="settings-note">
        A theme is a JSON file with a <code>name</code> and a <code>colors</code> map that
        restyles the app on top of the built-in Light/Dark palette. Tokens you don't set
        fall back to the built-in theme; an optional <code>base: "light" | "dark"</code>{" "}
        pins which scope it sits on. Pick the base mode above, then click a card to apply it.
      </p>

      {error && (
        <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "10px 0" }}>
        <button className="primary" onClick={() => void importTheme()} disabled={busy}>
          Import theme…
        </button>
      </div>

      {customThemes.length === 0 ? (
        <div className="empty-reserved">
          <div className="empty-text">No custom themes yet. Import a JSON file to add one.</div>
        </div>
      ) : (
        <div className="theme-gallery">
          {customThemes.map((t) => {
            const active = t.id === customThemeId;
            const sw = themeSwatchColors(t);
            return (
              <div
                key={t.id}
                className={`theme-card${active ? " active" : ""}`}
                onClick={() => setCustomTheme(active ? null : t.id)}
                title={active ? "Click to deselect" : "Apply this theme"}
              >
                <div className="theme-card-swatches">
                  <span style={{ background: sw.bg }} />
                  <span style={{ background: sw.surface }} />
                  <span style={{ background: sw.text }} />
                  <span style={{ background: sw.accent }} />
                </div>
                <div className="theme-card-name">
                  {t.name}
                  {t.base && <span className="theme-card-base">{t.base}</span>}
                </div>
                <div className="theme-card-actions">
                  <button
                    className="ghost"
                    onClick={(e) => { e.stopPropagation(); void exportTheme(t); }}
                  >
                    Export
                  </button>
                  <button
                    className="ghost"
                    style={{ color: "var(--danger, #f85149)" }}
                    onClick={(e) => { e.stopPropagation(); removeTheme(t); }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <details className="theme-token-hint">
        <summary>Which tokens can a theme set?</summary>
        <div className="theme-token-list">
          {CORE_THEME_TOKENS.map(({ token, label }) => (
            <code key={token} className="theme-token-chip">
              {token} <span>{label}</span>
            </code>
          ))}
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 11 }}>
          The full surface also includes the editor, sidebar, activity/status bar, tab,
          input, button, scrollbar, tooltip and <code>syntax-*</code> token families —
          see <code>src/styles/tokens.css</code>. Unknown keys in an imported file are ignored.
        </p>
      </details>
    </div>
  );
}
