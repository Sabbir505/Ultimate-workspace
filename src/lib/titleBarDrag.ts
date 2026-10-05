// Title-bar dragging that works THROUGH child elements.
//
// Tauri's own drag-region handling only fires when the event TARGET itself
// carries `data-tauri-drag-region`. The full-page views port their headers
// into the caption (common/ToolbarHeader), and those headers are full of
// child elements — h1 text, icon paths, stats chips — so clicking them
// targeted a node WITHOUT the attribute and the window didn't drag (chat
// worked only because its toolbar slot is empty). This module restores the
// obvious behavior with one delegated handler: a press anywhere inside a
// `[data-tauri-drag-region]` starts the window drag, unless the press landed
// on something interactive (buttons, inputs, …), which keep their clicks.
// Double-click on a drag region toggles maximize, matching the native
// caption behavior. Where the target itself has the attribute, Tauri's
// injected handler also runs — startDragging twice is harmless (the first
// wins), but we still defer to it and skip, to keep one code path.
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Interactive targets that keep their click inside a drag region. */
const INTERACTIVE = "button, a, input, select, textarea, label, [role='button'], summary";

export function installTitleBarDrag(): () => void {
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target as Element | null;
    if (!t || !t.closest) return;
    if (t.closest(INTERACTIVE)) return;
    const region = t.closest("[data-tauri-drag-region]");
    if (!region) return;
    // The exact target carrying the attribute is Tauri's own path.
    if (t.hasAttribute("data-tauri-drag-region")) return;
    e.preventDefault();
    void getCurrentWindow()
      .startDragging()
      .catch(() => {
        /* plain browser (harness) — nothing to drag */
      });
  };
  const onDoubleClick = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (!t || !t.closest) return;
    if (t.closest(INTERACTIVE)) return;
    if (!t.closest("[data-tauri-drag-region]")) return;
    void getCurrentWindow()
      .toggleMaximize()
      .catch(() => {
        /* plain browser */
      });
  };
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("dblclick", onDoubleClick, true);
  return () => {
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("dblclick", onDoubleClick, true);
  };
}
