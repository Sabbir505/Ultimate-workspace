// Sidebar art — a background image for the sidebar's header block (Relay
// wordmark + search): either a bundled stock preset (public/sideart/<id>.png)
// or a user upload copied into the app data dir. See
// commands/appearance_cmds.rs.
import { safeInvoke } from "../ipcCore";

/** Import a picked image: validates, copies into the app data dir, and
 *  remembers it (replacing any preset). Returns the stored path. */
export const importSidebarArt = (sourcePath: string) =>
  safeInvoke<string>("import_sidebar_art", { sourcePath });
/** Select a bundled stock image by id (replaces any custom upload). */
export const setSidebarArtPreset = (id: string) =>
  safeInvoke<void>("set_sidebar_art_preset", { id });
/** The custom upload as a `data:` URL; null when unset. */
export const readSidebarArtData = () =>
  safeInvoke<string | null>("read_sidebar_art_data");
/** Remove ALL art (custom file + preset selection); the header goes plain. */
export const clearSidebarArt = () => safeInvoke<void>("clear_sidebar_art");
/** The stored custom-file path, for diagnostics. */
export const getSidebarArtPath = () =>
  safeInvoke<string | null>("get_sidebar_art_path");

/** Bundled stock images — ids validated by the backend; bytes live in the
 *  frontend's public/ assets (Unsplash, free license) so switching needs no
 *  IPC round-trip. Photo credits (Unsplash photo ids): aurora
 *  1579546929518, ember 1614850523459, violet 1618005182384, waves
 *  1518837695005, dusk 1620121692029, forest 1441974231531. */
export const SIDEBAR_ART_PRESETS: { id: string; label: string }[] = [
  { id: "aurora", label: "Aurora" },
  { id: "ember", label: "Ember" },
  { id: "violet", label: "Violet" },
  { id: "waves", label: "Waves" },
  { id: "dusk", label: "Dusk" },
  { id: "forest", label: "Forest" },
];

export const sidebarArtPresetUrl = (id: string) => `/sideart/${id}.jpg`;
