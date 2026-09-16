// PetCarrier — the pet "in your hand". While the store is dragging, the home
// strips hide their actor and this portal copy follows the pointer: a rAF
// lerp gives it a soft trailing motion (direct style writes — no per-frame
// React renders), the caught pose wriggles, and a spirit-sparkle aura drifts
// off it. Purely visual: pointer-events none everywhere (drop targets are
// hit-tested from coordinates in lib/pets/carry) and the drag plumbing lives
// in PetStrip's window listeners.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { PetActor } from "./PetActor";
import { usePetStore } from "../../state/pet";

/** Fraction of the remaining gap the carried pet closes per frame — 1.0
 *  would pin it to the cursor; a soft trail reads as "alive, wriggling". */
const LERP = 0.28;
/** The pet hangs slightly above the cursor — carried by the scruff. */
const CARRY_LIFT_PX = 16;

export function PetCarrier() {
  const dragging = usePetStore((s) => s.dragging);
  const ref = useRef<HTMLDivElement>(null);
  const pos = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const el = ref.current;
      const p = usePetStore.getState().dragPointer;
      if (!el || !p) return;
      if (!pos.current) pos.current = { ...p }; // spawn at the grab point
      pos.current.x += (p.x - pos.current.x) * LERP;
      pos.current.y += (p.y - pos.current.y) * LERP;
      el.style.transform = `translate(${pos.current.x}px, ${pos.current.y - CARRY_LIFT_PX}px)`;
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      pos.current = null;
    };
  }, [dragging]);

  if (!dragging) return null;
  return createPortal(
    <div ref={ref} className="pet-carrier" aria-hidden>
      <div className="pet-carrier-wiggle">
        <PetActor />
        <span className="pet-carrier-sparkle">✦</span>
        <span className="pet-carrier-sparkle">✦</span>
        <span className="pet-carrier-sparkle">✦</span>
        <span className="pet-carrier-sparkle">✦</span>
        <span className="pet-carrier-sparkle">✦</span>
      </div>
    </div>,
    document.body,
  );
}
