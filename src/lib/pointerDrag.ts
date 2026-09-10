import type { PointerEvent as ReactPointerEvent } from "react";

/** Shared pointer-drag lifecycle for resize handles: subscribe pointermove /
 *  pointerup / pointercancel for the duration of the drag and tear down
 *  cleanly on release. `onMove` receives the pointer's clientX; `onEnd`
 *  (optional) fires once on release.
 *
 *  With `capture`, the pointer is captured on the initiating element so the
 *  drag keeps tracking when the cursor leaves the handle's hit area, and
 *  pointercancel also terminates the drag. Without it, listeners go on
 *  `window` (the original window-listener resize pattern). */
export function startPointerDrag(
  e: ReactPointerEvent<Element>,
  onMove: (clientX: number) => void,
  onEnd?: () => void,
  opts?: { capture?: boolean },
): void {
  const handle = e.currentTarget as HTMLElement;
  const onMoveEv = (ev: PointerEvent) => onMove(ev.clientX);
  const end = (ev: PointerEvent) => {
    if (opts?.capture) {
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        // Already released (e.g. a pointercancel raced the pointerup).
      }
    }
    handle.removeEventListener("pointermove", onMoveEv);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    onEnd?.();
  };
  if (opts?.capture) {
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener("pointermove", onMoveEv);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  } else {
    window.addEventListener("pointermove", onMoveEv);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }
}
