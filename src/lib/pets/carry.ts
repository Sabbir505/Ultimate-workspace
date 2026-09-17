// Catch-and-carry drop targeting — pure DOM hit-testing against the home
// strips currently in the document. Kept out of the store (which stays a
// pure state machine) and out of React (the strip handlers call these
// directly on pointer events).
//
// Drop bands are forgiving: the sidebar strip is a 44px row, and pane strips
// are zero-height overlays on the composer's top edge — so a pane's band
// extends UPWARD from the seam, covering the air where the 48px actor stands.
import { usePetStore } from "../../state/pet";

export interface PetDropHit {
  home: string;
  /** Pointer x as a fraction of the target strip (the landing spot). */
  fraction: number;
}

interface DropBand {
  home: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function dropBand(el: Element): DropBand {
  const home = el.getAttribute("data-home") ?? "";
  const r = el.getBoundingClientRect();
  const sidebar = el.classList.contains("pet-strip-sidebar");
  return {
    home,
    left: r.left,
    right: r.right,
    top: sidebar ? r.top - 12 : r.top - 36,
    bottom: sidebar ? r.bottom + 14 : r.top + 14,
  };
}

/** Which home's landing band contains the point? When bands overlap (they
 *  normally don't) the one whose centre the point is closest to wins. */
export function petDropTargetAt(x: number, y: number): PetDropHit | null {
  let best: PetDropHit | null = null;
  let bestDist = Infinity;
  const strips = document.querySelectorAll(".pet-strip[data-home]");
  for (const el of Array.from(strips)) {
    const band = dropBand(el);
    if (x < band.left || x > band.right || y < band.top || y > band.bottom) continue;
    const r = el.getBoundingClientRect();
    const fraction = Math.min(0.96, Math.max(0.04, r.width > 0 ? (x - r.left) / r.width : 0.5));
    const dist = Math.abs(y - (band.top + band.bottom) / 2);
    if (dist < bestDist) {
      bestDist = dist;
      best = { home: band.home, fraction };
    }
  }
  return best;
}

/** Track a pointermove during a carry: hit-test the hovered home and publish
 *  it with the pointer position. Every armed strip attaches this to its
 *  window listener, so it dedupes by event timeStamp — N strips produce
 *  exactly ONE store update per pointer event. */
let lastMoveStamp = -1;
export function trackPetCarry(e: PointerEvent): void {
  const s = usePetStore.getState();
  if (!s.dragging) return;
  if (e.timeStamp === lastMoveStamp) return;
  lastMoveStamp = e.timeStamp;
  s.dragMove(e.clientX, e.clientY, petDropTargetAt(e.clientX, e.clientY)?.home ?? null);
}

/** Release the carried pet: drop it into the hovered home, or fall back
 *  gently into its current one at the pointer's fraction. Safe to call twice
 *  (the strip handler and the window safety net both do) — the store guards
 *  on `dragging`. */
export function finalizePetDrop(clientX: number, clientY: number): void {
  const s = usePetStore.getState();
  if (!s.dragging) return;
  const hit = petDropTargetAt(clientX, clientY);
  if (hit && hit.home !== s.home) {
    s.dropInto(hit.home, hit.fraction);
    return;
  }
  // Same home (or dead space): settle back where the pointer is, clamped.
  const el = document.querySelector(`.pet-strip[data-home="${CSS.escape(s.home)}"]`);
  const r = el?.getBoundingClientRect();
  const fraction = r && r.width > 0 ? (clientX - r.left) / r.width : s.core.x;
  s.endDrag(fraction);
}
