// Occlusion rule for native child-webview browser panes. A native webview is
// NOT composited with the DOM — it floats above everything in the window,
// including React overlays (settings/skills/cost views, command palette,
// peek panel, modals) and display:none'd split-mode panes. The only way to
// keep it from punching through an overlay is to hide it explicitly.
// Pure and unit-tested; BrowserPane subscribes to the stores and feeds the
// values in.

import type { ActiveView } from "../state/ui";

export interface OcclusionInputs {
  /** ui.activeView — anything but "grid"/"chat" is a full-window overlay
   *  view. Chat mode hosts browser panes in its own split layout. */
  activeView: ActiveView;
  paletteOpen: boolean;
  peekOpen: boolean;
  /** A modal is up (replace-LRU confirmation or project settings panel). */
  modalOpen: boolean;
  /** Whether this pane is the visible one in split mode (PaneGrid decides). */
  paneVisible: boolean;
  /** Whether this browser pane is minimized to its header bar. A collapsed
   *  pane keeps its <BrowserPane> mounted (so the webview and its URL/history
   *  tracking stay alive) but hides the native webview via browser_set_visible
   *  — minimizing hides instead of destroys, so expand restores the live page
   *  (scroll position, form state, history) instead of recreating it. */
  collapsed: boolean;
}

/** true = the native webview must be hidden (browser_set_visible(false)). */
export function browserOccluded({
  activeView,
  paletteOpen,
  peekOpen,
  modalOpen,
  paneVisible,
  collapsed,
}: OcclusionInputs): boolean {
  return (
    collapsed ||
    !paneVisible ||
    (activeView !== "grid" && activeView !== "chat") ||
    paletteOpen ||
    peekOpen ||
    modalOpen
  );
}
