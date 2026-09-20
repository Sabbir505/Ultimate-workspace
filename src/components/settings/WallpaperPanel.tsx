// Settings → Appearance → App wallpaper: a background image behind the whole
// UI. Pick one of the bundled stock images or upload your own, and tune how
// strongly the readability scrim dims it with the dim slider. Same flow as
// the sidebar art (backend owns the native file dialog; imports copy the
// file into the app data dir). See commands/appearance_cmds.rs +
// state/appearance.ts + hooks/useWallpaper.ts.
import { useState } from "react";
import { Check, Image as ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import {
  WALLPAPER_PRESETS,
  clearAppWallpaper,
  importAppWallpaper,
  readAppWallpaperData,
  setAppWallpaperPreset,
  sidebarArtPresetUrl,
  toastError,
  toastSuccess,
} from "../../lib/ipc";
import { useAppearanceStore } from "../../state/appearance";

export function WallpaperPanel() {
  const wallpaperData = useAppearanceStore((s) => s.wallpaperData);
  const wallpaperPreset = useAppearanceStore((s) => s.wallpaperPreset);
  const wallpaperDim = useAppearanceStore((s) => s.wallpaperDim);
  const setWallpaper = useAppearanceStore((s) => s.setWallpaper);
  const setWallpaperDim = useAppearanceStore((s) => s.setWallpaperDim);
  const [busy, setBusy] = useState(false);

  const choosePreset = async (id: string) => {
    if (busy || id === wallpaperPreset) return;
    setBusy(true);
    try {
      await setAppWallpaperPreset(id);
      // The bytes live in the frontend bundle — resolve the URL locally.
      setWallpaper({ data: sidebarArtPresetUrl(id), preset: id });
    } catch (e) {
      toastError("Couldn't set wallpaper", String(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async () => {
    setBusy(true);
    try {
      // The backend opens the native file dialog itself — the renderer never
      // supplies a path (exec-gate principle). Cancel surfaces as an error.
      const stored = await importAppWallpaper();
      if (stored) {
        // Read back the stored copy so the preview renders the exact bytes
        // later launches will load.
        const data = await readAppWallpaperData();
        setWallpaper({ data: data ?? null, preset: null });
        toastSuccess("Wallpaper updated");
      }
    } catch (e) {
      toastError("Couldn't set wallpaper", String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await clearAppWallpaper();
      setWallpaper({ data: null, preset: null });
      toastSuccess("Wallpaper removed");
    } catch (e) {
      toastError("Couldn't remove wallpaper", String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">App wallpaper</div>
      <p className="settings-section-hint">
        A background image behind the whole app. It's blurred and dimmed so
        text stays readable, and shows through the chat, sidebar and other
        glass surfaces.
      </p>

      {/* Live preview — the wallpaper + scrim exactly as the shell paints it,
          with a hint of glass content on top so the layering reads. */}
      <div className="wallpaper-preview" aria-hidden>
        {wallpaperData && (
          <div
            className="wallpaper-preview-layer"
            style={{
              backgroundImage: `linear-gradient(rgba(var(--wallpaper-scrim-rgb), ${wallpaperDim / 100}), rgba(var(--wallpaper-scrim-rgb), ${wallpaperDim / 100})), url(${wallpaperData})`,
              filter: "blur(10px) saturate(115%)",
            }}
          />
        )}
        <div className="wallpaper-preview-content">
          <span className="wallpaper-preview-card" />
          <span className="wallpaper-preview-card short" />
        </div>
      </div>

      {/* Dim slider — how strongly the scrim veils the image. */}
      {wallpaperData && (
        <div className="wallpaper-dim-row">
          <span className="wallpaper-dim-label">Dim</span>
          <input
            type="range"
            min={0}
            max={100}
            value={wallpaperDim}
            onChange={(e) => setWallpaperDim(Number(e.target.value))}
            style={{ flex: 1, accentColor: "var(--accent)" }}
          />
          <span className="wallpaper-dim-value">{wallpaperDim}%</span>
        </div>
      )}

      {/* Stock gallery — the same bundled images as the sidebar art. */}
      <div className="wallpaper-grid">
        {WALLPAPER_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`wallpaper-thumb${wallpaperPreset === p.id ? " active" : ""}`}
            onClick={() => void choosePreset(p.id)}
            disabled={busy}
            title={`Use ${p.label}`}
          >
            <img src={sidebarArtPresetUrl(p.id)} alt="" />
            <span className="wallpaper-thumb-label">
              {wallpaperPreset === p.id && <Check size={10} strokeWidth={3} className="inline mr-0.5 -mt-px" />}
              {p.label}
            </span>
          </button>
        ))}
      </div>

      {/* Custom upload + remove. */}
      <div className="sidebar-art-row">
        <div
          className="sidebar-art-preview"
          style={wallpaperData && !wallpaperPreset ? { backgroundImage: `url(${wallpaperData})` } : undefined}
          title={wallpaperData && !wallpaperPreset ? "Your uploaded wallpaper" : "No custom wallpaper uploaded"}
        >
          {(!wallpaperData || wallpaperPreset) && (
            <ImageIcon size={18} strokeWidth={1.5} className="opacity-50" />
          )}
        </div>
        <div className="sidebar-art-actions">
          <button type="button" onClick={() => void chooseFile()} disabled={busy}>
            {busy ? (
              <><Loader2 size={13} className="animate-spin" /> Working…</>
            ) : (
              <><Upload size={13} /> Upload your own</>
            )}
          </button>
          {wallpaperData && (
            <button
              type="button"
              className="ghost danger"
              onClick={() => void clear()}
              disabled={busy}
            >
              <Trash2 size={13} /> Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
