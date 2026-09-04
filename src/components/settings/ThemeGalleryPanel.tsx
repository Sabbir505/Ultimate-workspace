// Custom theme gallery (roadmap #19): import themes as JSON (a `name` +
// `colors` override map), preview them with swatches, apply one on top of the
// base light/dark theme, and export/delete. The active overlay persists in
// the settings store; useTheme() applies it to <html>.
import { useCallback, useRef, useState } from "react";
import { useSettingsStore } from "../../state/settings";
import {
  CORE_THEME_TOKENS,
  parseThemeJson,
  themeJson,
  themeSwatchColors,
  type CustomTheme,
} from "../../lib/themes";
import { toastError, toastSuccess } from "../../lib/ipc";
import { Plus, Download, Trash2, FileCode, Copy } from "lucide-react";
import { THEME_PRESETS } from "../../lib/themePresets";

const JSON_TEMPLATE = `{
  "name": "My Theme",
  "base": "dark",
  "colors": {
    "bg-tint": "#0d0d0d",
    "surface": "#161616",
    "surface-2": "#1e1e1e",
    "surface-3": "#2a2a2a",
    "text": "#e4e4e4",
    "text-dim": "#a0a0a0",
    "accent": "#6e706f",
    "accent-soft": "rgba(110,112,111,0.16)",
    "border": "#2a2a2a",
    "border-strong": "#3a3a3a",
    "state-working": "#4caf50",
    "state-waiting": "#ff9800",
    "state-error": "#f44336"
  }
}`;

export function ThemeGalleryPanel() {
  const customThemes = useSettingsStore((s) => s.customThemes);
  const customThemeId = useSettingsStore((s) => s.customThemeId);
  const setCustomTheme = useSettingsStore((s) => s.setCustomTheme);
  const importCustomTheme = useSettingsStore((s) => s.importCustomTheme);
  const deleteCustomTheme = useSettingsStore((s) => s.deleteCustomTheme);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTokenDocs, setShowTokenDocs] = useState(false);
  const [copiedTemplate, setCopiedTemplate] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importTheme = useCallback(async () => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      let raw = "";
      await new Promise<void>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          raw = String(event.target?.result ?? "");
          resolve();
        };
        reader.onerror = (e) => reject(new Error(`File read failed`));
        reader.readAsText(file);
      });
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
      if (e.target) e.target.value = "";
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

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(JSON_TEMPLATE);
      setCopiedTemplate(true);
      setTimeout(() => setCopiedTemplate(false), 2000);
    } catch {
      toastError("Failed to copy template");
    }
  };

  const openTokensCss = () => {
    window.open("https://github.com/your-repo/blob/main/src/styles/tokens.css", "_blank");
  };

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Custom themes</h3>
        <span className="panel-count">{customThemes.length} theme{customThemes.length !== 1 ? "s" : ""}</span>
      </div>

      <p className="settings-section-hint" style={{ marginBottom: 16 }}>
        A theme is a JSON file with a <code>name</code>, optional <code>base: "light" | "dark"</code>, and a <code>colors</code> map that restyles the app on top of the built-in palette. Tokens you don't set fall back to the built-in theme.
      </p>

      {error && (
        <div className="settings-note" style={{ color: "var(--danger, #f85149)", marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Built-in presets — one click applies. Applying copies the preset into
          the gallery (importCustomTheme dedupes by id), so it persists like an
          imported theme and shows as active in the grid below. */}
      <div className="theme-presets-title">Built-in presets</div>
      <div className="theme-gallery-grid" style={{ marginBottom: 20 }}>
        {THEME_PRESETS.map((p) => {
          const active = customThemeId === p.id;
          const sw = themeSwatchColors(p);
          return (
            <div
              key={p.id}
              className={`theme-card${active ? " active" : ""}`}
              onClick={() => {
                importCustomTheme(p);
                setCustomTheme(active ? null : p.id);
              }}
              title={active ? "Click to deselect" : "Apply this theme"}
            >
              <div className="theme-card-swatches">
                <span style={{ background: sw.bg }} title="bg-tint" />
                <span style={{ background: sw.surface }} title="surface" />
                <span style={{ background: sw.text }} title="text" />
                <span style={{ background: sw.accent }} title="accent" />
              </div>
              <div className="theme-card-name">
                {p.name}
                {p.base && <span className="theme-card-base">{p.base}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Import dropzone card */}
      <div className="theme-gallery-grid">
        <label className="theme-import-card" htmlFor="theme-import">
          <input
            id="theme-import"
            ref={fileInputRef}
            type="file"
            accept=".json"
            hidden
            onChange={handleFileSelect}
          />
          <div className="theme-import-icon">
            <Plus size={24} strokeWidth={1.5} />
          </div>
          <div className="theme-import-text">
            <strong>Import JSON theme</strong>
            <span>Drag & drop or click to select a .json file</span>
          </div>
        </label>

        {/* Preset-derived copies render in the Built-in grid above. */}
        {customThemes
          .filter((t) => !t.id.startsWith("preset:"))
          .map((t) => {
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
                <span style={{ background: sw.bg }} title="bg-tint" />
                <span style={{ background: sw.surface }} title="surface" />
                <span style={{ background: sw.text }} title="text" />
                <span style={{ background: sw.accent }} title="accent" />
              </div>
              <div className="theme-card-name">
                {t.name}
                {t.base && <span className="theme-card-base">{t.base}</span>}
              </div>
              <div className="theme-card-actions">
                <button
                  className="ghost"
                  onClick={(e) => { e.stopPropagation(); void exportTheme(t); }}
                  title="Export theme"
                >
                  <Download size={14} strokeWidth={1.8} />
                </button>
                <button
                  className="ghost"
                  style={{ color: "var(--danger, #f85149)" }}
                  onClick={(e) => { e.stopPropagation(); removeTheme(t); }}
                  title="Delete theme"
                >
                  <Trash2 size={14} strokeWidth={1.8} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Token documentation accordion */}
      <details className="theme-token-docs" open={showTokenDocs}>
        <summary className="theme-token-docs-summary" onClick={() => setShowTokenDocs((v) => !v)}>
          <span className="theme-token-docs-icon">ℹ️</span>
          <span>How custom themes work</span>
          <span className="theme-token-docs-chevron" />
        </summary>
        <div className="theme-token-docs-content">
          <div className="theme-token-docs-header">
            <p>
              Themes override a subset of the <strong>core CSS variables</strong> defined in
              <code>src/styles/tokens.css</code>. Any token you omit falls back to the
              built-in Light/Dark palette (whichever matches your <code>base</code> mode).
            </p>
            <div className="theme-token-docs-actions">
              <button className="ghost" onClick={copyTemplate} title="Copy JSON template to clipboard">
                <Copy size={14} strokeWidth={1.8} />
                {copiedTemplate ? "Copied!" : "Copy template"}
              </button>
              <button className="ghost" onClick={openTokensCss} title="View all tokens on GitHub">
                <FileCode size={14} strokeWidth={1.8} />
                View tokens.css
              </button>
            </div>
          </div>

          <div className="theme-token-grid">
            {CORE_THEME_TOKENS.map(({ token, label }) => (
              <code key={token} className="theme-token-chip" title={label}>
                <span className="theme-token-name">--{token}</span>
                <span className="theme-token-label">{label}</span>
              </code>
            ))}
          </div>

          <p className="theme-token-note">
            The full surface also includes the editor, sidebar, activity/status bar, tab,
            input, button, scrollbar, tooltip and <code>syntax-*</code> token families —
            see <code>src/styles/tokens.css</code>. Unknown keys in an imported file are ignored.
          </p>
        </div>
      </details>
    </div>
  );
}