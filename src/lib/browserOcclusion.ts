// Occlusion rule for native child-webview browser panes. A native webview is
// NOT composited with the DOM — it floats above it as an OS-level child
// window — so React's `display: none` / unmount does NOT actually hide it.
// This module computes whether the webview should be hidden at the OS level
// (Tauri `set_webview_visibility` / bounds move) given the app's UI state.
//
// Occlusion is TRUE when the user cannot meaningfully see or interact with
// the browser pane:
//  - the pane is collapsed (its own collapsed flag — not just the global UI),
//  - the pane's column/row slot is not currently visible (tool panel tab),
//  - the active view is not `chat` (the only view that shows browser panes),
//  - or a full-screen overlay (palette / peek / modal) is covering it.
//
// IMPORTANT: a pane's OWN `collapsed` state must participate in the check.
// Previously only global overlays were considered, so a collapsed browser
// pane kept painting its native webview on top of whatever replaced it.

import type { ActiveView } from "../state/ui";

export interface OcclusionInputs {
  paletteOpen: boolean;
  peekOpen: boolean;
  modalOpen: boolean;
  paneVisible: boolean;
  collapsed: boolean;
  activeView: ActiveView;
}

export function browserOccluded({
  paletteOpen,
  peekOpen,
  modalOpen,
  paneVisible,
  collapsed,
  activeView,
}: OcclusionInputs): boolean {
  return (
    collapsed ||
    !paneVisible ||
    activeView !== "chat" ||
    paletteOpen ||
    peekOpen ||
    modalOpen
  );
}
