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
  // Subscribe and UNSUBSCRIBE on the same target. Cleaning up on `handle` while
  // listening on `window` removed nothing: the released drag kept its
  // pointermove listener for the life of the window, so the panel resized
  // itself on every later mouse move — the "keeps moving after I let go" bug.
  const target: EventTarget = opts?.capture ? handle : window;
  // Typed as the widest listener so one pair of handlers serves both targets
  // (window's overloads and the element's differ).
  const onMoveEv: EventListener = (ev) => onMove((ev as PointerEvent).clientX);
  // A drag ends once. The capture path can see two endings in a row (a release
  // that also emits lostpointercapture), and `onEnd` must not run twice.
  let done = false;
  const end: EventListener = (ev) => {
    if (done) return;
    done = true;
    if (opts?.capture) {
      try {
        handle.releasePointerCapture((ev as PointerEvent).pointerId);
      } catch {
        // Already released (e.g. a pointercancel raced the pointerup).
      }
    }
    target.removeEventListener("pointermove", onMoveEv);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    handle.removeEventListener("lostpointercapture", end);
    onEnd?.();
  };
  if (opts?.capture) {
    handle.setPointerCapture(e.pointerId);
    // Capture can be lost without a pointerup — the handle re-mounting
    // mid-drag, or the browser dropping it. Ending there keeps the drag's
    // listeners from outliving it when the element they live on is gone.
    handle.addEventListener("lostpointercapture", end);
  }
  target.addEventListener("pointermove", onMoveEv);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}
