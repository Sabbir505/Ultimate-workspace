// PetStrip — one "home" of the companion pet (above the sidebar search, or
// above the chat composer). The pet lives in exactly ONE home at a time and
// teleports between them: the old home plays a scanline-dissolve (teleout
// sprite) for the first half of the teleport window, then the new home
// materialises (telein sprite) in the second half. Only the sidebar home
// carries the paw button (panel) — it renders even while the pet is elsewhere.
//
// The pet is draggable: press + move repositions it along the strip (and the
// new spot becomes its stroll home base, persisted); a press without movement
// is a pet.
import { useCallback, useEffect, useRef, useState } from "react";
import { PawPrint } from "lucide-react";

import { PetActor } from "./PetActor";
import { PetPanel } from "./PetPanel";
import { PET_TELEPORT_MS, usePetStore } from "../../state/pet";

const PANEL_CLOSE_MS = 170;
/** Pointer movement past this (px) turns a press into a drag. */
const DRAG_THRESHOLD_PX = 6;

export function PetStrip({ myHome }: { myHome: "sidebar" | "composer" }) {
  const enabled = usePetStore((s) => s.enabled);
  const home = usePetStore((s) => s.home);
  const teleport = usePetStore((s) => s.teleport);
  const dragging = usePetStore((s) => s.dragging);
  const name = usePetStore((s) => s.name);
  const x = usePetStore((s) => s.core.x);
  const beginDrag = usePetStore((s) => s.beginDrag);
  const dragTo = usePetStore((s) => s.dragTo);
  const endDrag = usePetStore((s) => s.endDrag);
  const petThePet = usePetStore((s) => s.petThePet);
  const [panel, setPanel] = useState<"closed" | "open" | "closing">("closed");
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [appearReady, setAppearReady] = useState(false);
  const pawRef = useRef<HTMLButtonElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; moved: boolean } | null>(null);

  // The arriving pet mounts in the SECOND half of the teleport window: the
  // vanish finishes before the materialise starts (sequential, not a
  // cross-fade).
  const active = home === myHome;
  const vanishing = teleport !== null && teleport.from === myHome;
  const teleporting = teleport !== null;
  const phase: "vanish" | "appear" | undefined = vanishing
    ? "vanish"
    : teleporting
      ? "appear"
      : undefined;
  useEffect(() => {
    if (phase !== "appear") {
      setAppearReady(false);
      return;
    }
    const t = window.setTimeout(() => setAppearReady(true), PET_TELEPORT_MS / 2);
    return () => window.clearTimeout(t);
  }, [phase]);

  const togglePanel = useCallback(() => {
    setPanel((state) => {
      if (state !== "closed") return state;
      const r = pawRef.current?.getBoundingClientRect();
      if (r) setAnchor({ x: r.right, y: r.bottom });
      return "open";
    });
  }, []);
  const closePanel = useCallback(() => {
    setPanel((state) => {
      if (state !== "open") return state;
      window.setTimeout(() => setPanel("closed"), PANEL_CLOSE_MS);
      return "closing";
    });
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      drag.current = { pointerId: e.pointerId, startX: e.clientX, moved: false };
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      if (!d.moved && Math.abs(e.clientX - d.startX) > DRAG_THRESHOLD_PX) {
        d.moved = true;
        beginDrag();
      }
      if (d.moved) {
        const rect = stripRef.current?.getBoundingClientRect();
        if (rect && rect.width > 0) dragTo((e.clientX - rect.left) / rect.width);
      }
    },
    [beginDrag, dragTo],
  );
  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      drag.current = null;
      if (d.moved) endDrag();
      else petThePet();
    },
    [endDrag, petThePet],
  );

  const showPet = enabled && (active || vanishing);
  if (!enabled || (myHome === "composer" && !showPet)) return null;
  const animOverride =
    phase === "vanish" ? ("teleout" as const) : phase === "appear" ? ("telein" as const) : undefined;
  const actorVisible = phase !== "appear" || appearReady;

  return (
    <div ref={stripRef} className={`pet-strip pet-strip-${myHome}`} data-home={myHome}>
      {/* Zero-width slot at the pet's x fraction; the 48px actor centres on it
          via its own negative margin. pointer events live on the small hit box
          around the art: press = pet, press+move = drag to a new spot. */}
      {showPet && actorVisible && (
        <div
          className={`pet-slot${phase ? ` pet-slot-${phase}` : ""}${dragging ? " pet-slot-dragging" : ""}`}
          style={{ left: `${x * 100}%` }}
        >
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            role="button"
            aria-label={`Pet ${name} — click to pet, drag to move`}
            title={`${name} — click to pet, drag to move`}
          >
            <PetActor animOverride={animOverride} />
          </div>
        </div>
      )}
      {myHome === "sidebar" && (
        <button
          ref={pawRef}
          type="button"
          className="pet-panel-btn"
          onClick={togglePanel}
          aria-label="Companion settings"
          aria-expanded={panel === "open"}
          title="Companion pet"
        >
          <PawPrint size={13} strokeWidth={1.8} />
        </button>
      )}
      {panel !== "closed" && myHome === "sidebar" && (
        <PetPanel
          anchor={anchor}
          toggleRef={pawRef}
          closing={panel === "closing"}
          onClose={closePanel}
        />
      )}
    </div>
  );
}

export { PANEL_CLOSE_MS };
