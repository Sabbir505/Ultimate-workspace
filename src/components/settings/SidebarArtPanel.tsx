// Settings → Appearance → Sidebar art: pick a bundled stock image or upload
// your own, with a live mini preview of the sidebar header (same masked-layer
// CSS the real header uses, so what you see is what you get). Imports copy the
// picked file into the app data dir (original untouched). See
// commands/appearance_cmds.rs + state/appearance.ts.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, Image as ImageIcon, Loader2, Search, Trash2, Upload } from "lucide-react";
import {
  SIDEBAR_ART_PRESETS,
  clearSidebarArt,
  importSidebarArt,
  readSidebarArtData,
  setSidebarArtPreset,
  sidebarArtPresetUrl,
  toastError,
  toastSuccess,
} from "../../lib/ipc";
import { useAppearanceStore } from "../../state/appearance";

/** The scrim gradient the real header paints over the art — kept in sync with
 *  SidebarHeader so the mini preview is faithful. */
const SCRIM =
  "linear-gradient(180deg, rgba(8, 10, 14, 0.5), rgba(8, 10, 14, 0.72))";

export function SidebarArtPanel() {
  const artData = useAppearanceStore((s) => s.artData);
  const artPreset = useAppearanceStore((s) => s.artPreset);
  const setArt = useAppearanceStore((s) => s.setArt);
  const [busy, setBusy] = useState(false);

  const choosePreset = async (id: string) => {
    if (busy || id === artPreset) return;
    setBusy(true);
    try {
      await setSidebarArtPreset(id);
      // The bytes live in the frontend bundle — resolve the URL locally.
      setArt({ data: sidebarArtPresetUrl(id), preset: id });
    } catch (e) {
      toastError("Couldn't set sidebar art", String(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async () => {
    setBusy(true);
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"] },
        ],
      });
      if (!picked || Array.isArray(picked)) return;
      const stored = await importSidebarArt(picked);
      if (stored) {
        // Read back the stored copy so preview and sidebar render the exact
        // bytes later launches will load.
        const data = await readSidebarArtData();
        setArt({ data: data ?? null, preset: null });
        toastSuccess("Sidebar art updated");
      }
    } catch (e) {
      toastError("Couldn't set sidebar art", String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await clearSidebarArt();
      setArt({ data: null, preset: null });
      toastSuccess("Sidebar art removed");
    } catch (e) {
      toastError("Couldn't remove sidebar art", String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">Sidebar art</div>
      <p className="settings-section-hint">
        A background image behind the sidebar header. It fades out toward the
        bottom, and a dark shade keeps the text readable.
      </p>

      {/* Live mini preview — the real header's markup, miniaturized. */}
      <div className="sidebar-art-preview-header">
        {artData && (
          <div
            aria-hidden
            className="sidebar-art-mini-scrim"
            style={{ backgroundImage: `${SCRIM}, url(${artData})` }}
          />
        )}
        <div className="sidebar-art-mini-content">
          <span className="sidebar-art-mini-wordmark">Relay</span>
          <span className="sidebar-art-mini-search">
            <Search size={12} strokeWidth={1.8} /> Search
          </span>
        </div>
      </div>

      {/* Stock art gallery. */}
      <div className="sidebar-art-grid">
        {SIDEBAR_ART_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`sidebar-art-thumb${artPreset === p.id ? " active" : ""}`}
            onClick={() => void choosePreset(p.id)}
            disabled={busy}
            title={`Use ${p.label}`}
          >
            <img src={sidebarArtPresetUrl(p.id)} alt="" />
            <span className="sidebar-art-thumb-label">
              {artPreset === p.id && <Check size={10} strokeWidth={3} className="inline mr-0.5 -mt-px" />}
              {p.label}
            </span>
          </button>
        ))}
      </div>

      {/* Custom upload + remove. */}
      <div className="sidebar-art-row">
        <div
          className="sidebar-art-preview"
          style={artData && !artPreset ? { backgroundImage: `url(${artData})` } : undefined}
          title={artData && !artPreset ? "Your uploaded art" : "No custom art uploaded"}
        >
          {(!artData || artPreset) && (
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
          {(artData || artPreset) && (
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
