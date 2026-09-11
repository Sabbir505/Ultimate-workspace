// Resize-handle drag lifecycle.
//
// The bug these cover: the non-capture path subscribed on `window` but
// unsubscribed from the handle element, so releasing the mouse never actually
// ended the drag — the tool panel kept resizing itself on every later pointer
// move. Both directions are asserted here (the listener fires during the drag
// and is gone afterwards), because the failure mode was invisible to the
// in-drag assertions alone.
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPointerDrag } from "../lib/pointerDrag";

/** A pointerdown event good enough for the helper: it only reads
 *  `currentTarget` and `pointerId`. */
function downEvent(target: HTMLElement, pointerId = 1): ReactPointerEvent<Element> {
  return { currentTarget: target, pointerId } as unknown as ReactPointerEvent<Element>;
}

/** jsdom has no PointerEvent; MouseEvent carries the `clientX` the helper
 *  reads, and dispatching it exercises the same listener path. */
function moveEvent(x: number): Event {
  return new MouseEvent("pointermove", { clientX: x });
}

/** Pointer ids are read off the release event, so the test supplies one. */
function pointerUp(pointerId = 1): Event {
  const ev = new Event("pointerup");
  Object.defineProperty(ev, "pointerId", { value: pointerId });
  return ev;
}

/** jsdom has no pointer capture either — record the calls so the capture path
 *  can be asserted. */
function stubCapture(el: HTMLElement) {
  const calls = { set: [] as number[], release: [] as number[] };
  el.setPointerCapture = (id: number) => void calls.set.push(id);
  el.releasePointerCapture = (id: number) => void calls.release.push(id);
  el.hasPointerCapture = () => false;
  return calls;
}

const handles: HTMLElement[] = [];
function makeHandle(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  el.dataset.capture = "stubbed";
  stubCapture(el);
  handles.push(el);
  return el;
}

afterEach(() => {
  for (const h of handles.splice(0)) h.remove();
});

describe("startPointerDrag", () => {
  it("tracks on window and stops tracking once the pointer is released", () => {
    const handle = makeHandle();
    const moves: number[] = [];
    const onEnd = vi.fn();

    startPointerDrag(downEvent(handle), (x) => moves.push(x), onEnd);
    window.dispatchEvent(moveEvent(100));
    window.dispatchEvent(moveEvent(140));
    expect(moves).toEqual([100, 140]);
    expect(onEnd).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pointerup"));
    expect(onEnd).toHaveBeenCalledTimes(1);

    // The regression: these moves used to keep driving the resize forever.
    window.dispatchEvent(moveEvent(500));
    window.dispatchEvent(moveEvent(900));
    expect(moves).toEqual([100, 140]);

    // ...and a second release must not run the drag's end twice.
    window.dispatchEvent(new Event("pointerup"));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("captures the pointer and listens on the handle when asked, ending on release", () => {
    const handle = makeHandle();
    const moves: number[] = [];
    const onEnd = vi.fn();

    const capture = stubCapture(handle);
    startPointerDrag(downEvent(handle), (x) => moves.push(x), onEnd, { capture: true });
    expect(capture.set).toEqual([1]);

    // Captured drags are retargeted to the element by the browser; jsdom just
    // dispatches, which is enough to prove the subscription target.
    handle.dispatchEvent(moveEvent(60));
    expect(moves).toEqual([60]);
    window.dispatchEvent(moveEvent(70));
    expect(moves).toEqual([60]);

    handle.dispatchEvent(pointerUp());
    expect(onEnd).toHaveBeenCalledTimes(1);
    handle.dispatchEvent(moveEvent(80));
    expect(moves).toEqual([60]);
    expect(capture.release).toEqual([1]);
  });

  it("ends the drag when the captured pointer is lost", () => {
    const handle = makeHandle();
    const onEnd = vi.fn();
    startPointerDrag(downEvent(handle), () => {}, onEnd, { capture: true });

    // Capture can vanish without a pointerup (the handle re-mounting mid-drag).
    handle.dispatchEvent(new Event("lostpointercapture"));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
