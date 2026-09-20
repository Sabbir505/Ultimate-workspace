// View classification shared by the ui store, the shell and the browser
// occlusion rule (kept dependency-free so non-React modules can import it).
//
// "Overlay" views (settings / skills / cost) don't replace the main grid —
// they float above it as modals, and the view underneath keeps rendering.
// The real views (chat / automations / vault) swap the grid's content.
import type { ActiveView } from "../state/ui";

export function isOverlayView(view: ActiveView): boolean {
  return view === "settings" || view === "skills" || view === "cost";
}
