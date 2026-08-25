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
  /** An HTML popup that must paint where the webview is (e.g. the context
   *  meter's hover breakdown) is showing. Native webviews sit above ALL DOM,
   *  so the only way an HTML tooltip can be seen is to hide the webview while
   *  the popup is up. Optional so existing callers/tests stay valid. */
  htmlOverlayOpen?: boolean;
}

export function browserOccluded({
  paletteOpen,
  peekOpen,
  modalOpen,
  paneVisible,
  collapsed,
  activeView,
  htmlOverlayOpen,
}: OcclusionInputs): boolean {
  return (
    collapsed ||
    !paneVisible ||
    activeView !== "chat" ||
    paletteOpen ||
    peekOpen ||
    modalOpen ||
    !!htmlOverlayOpen
  );
}
