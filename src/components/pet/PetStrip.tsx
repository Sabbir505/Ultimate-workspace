// PetStrip — one "home" of the companion pet (the sidebar strip, or the
// top edge of ONE chat pane's composer — "main" or "pane-N"). The pet lives
// in exactly ONE home at a time and
// teleports between them: the old home plays a scanline-dissolve (teleout
// sprite) for the first half of the teleport window, then the new home
// materialises (telein sprite) in the second half. Only the sidebar home
// carries the paw button (panel) — it renders even while the pet is elsewhere.
//
// The pet is catch-and-carry: press + move LIFTS it out of the strip (the
// PetCarrier portal copy follows the cursor) and every existing home arms as
// a landing pad — release over another home drops it there; release over its
// own home (or dead space) settles it back. A press without movement is a
// pet. Dropping into a new home counts a teleport (Globetrotter) and plays a
// landing plop + sparkle burst.
import { useCallback, useEffect, useRef, useState } from "react";
import { PawPrint } from "lucide-react";

import { PetActor } from "./PetActor";
import { PetPanel } from "./PetPanel";
import { finalizePetDrop, trackPetCarry } from "../../lib/pets/carry";
import { PET_TELEPORT_MS, usePetStore } from "../../state/pet";

const PANEL_CLOSE_MS = 170;
/** Pointer movement past this (px) turns a press into a catch. */
const DRAG_THRESHOLD_PX = 6;
/** How long the landing plop/burst plays after a drop. */
const LAND_MS = 700;

export function PetStrip({ myHome }: { myHome: string }) {
  const enabled = usePetStore((s) => s.enabled);
  const home = usePetStore((s) => s.home);
  const teleport = usePetStore((s) => s.teleport);
  const dragging = usePetStore((s) => s.dragging);
  const dragOver = usePetStore((s) => s.dragOver);
  const landedAt = usePetStore((s) => s.landedAt);
  const name = usePetStore((s) => s.name);
  const x = usePetStore((s) => s.core.x);
  const beginDrag = usePetStore((s) => s.beginDrag);
  const petThePet = usePetStore((s) => s.petThePet);
  const [panel, setPanel] = useState<"closed" | "open" | "closing">("closed");
  // Mirror of `panel` for event handlers (the outside-click closer and the
  // paw toggle both need the live value without going through setState).
  const panelRef = useRef<"closed" | "open" | "closing">("closed");
  const setPanelBoth = useCallback((state: "closed" | "open" | "closing") => {
    panelRef.current = state;
    setPanel(state);
  }, []);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [appearReady, setAppearReady] = useState(false);
  const pawRef = useRef<HTMLButtonElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);

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

  const closePanel = useCallback(() => {
    if (panelRef.current === "closing" || panelRef.current === "closed") return;
    panelRef.current = "closing";
    setPanel("closing");
    window.setTimeout(() => {
      panelRef.current = "closed";
      setPanel("closed");
    }, PANEL_CLOSE_MS);
  }, []);
  // The paw genuinely toggles: open when closed, close when open (the paw is
  // excluded from the panel's outside-click closer, so this is its job).
  const togglePanel = useCallback(() => {
    if (panelRef.current === "open") {
      closePanel();
      return;
    }
    if (panelRef.current === "closing") return;
    const r = pawRef.current?.getBoundingClientRect();
    if (r) setAnchor({ x: r.right, y: r.bottom });
    setPanelBoth("open");
  }, [closePanel, setPanelBoth]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      if (!d.moved) {
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
        d.moved = true;
        beginDrag(e.clientX, e.clientY); // caught!
        // Tracking continues in the window listeners below — the actor moves
        // into the PetCarrier portal on commit, and pointer capture dies with
        // the unmounted hit box.
      }
    },
    [beginDrag],
  );
  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      drag.current = null;
      if (d.moved) finalizePetDrop(e.clientX, e.clientY);
      else petThePet();
    },
    [petThePet],
  );

  // Window-level drag plumbing, attached by EVERY armed strip (the store
  // guards make duplicates harmless; carry.ts dedupes the move events). After
  // beginDrag the hit box unmounts — the actor moves into the PetCarrier
  // portal and pointer capture dies with it — so the drag continues from
  // these listeners: move tracks cursor + hovered landing home, up/cancel/
  // Escape release the pet.
  const armed = enabled && dragging;
  useEffect(() => {
    if (!armed) return;
    const onMove = (e: PointerEvent) => trackPetCarry(e);
    const onUp = (e: PointerEvent) => finalizePetDrop(e.clientX, e.clientY);
    const onCancel = () => usePetStore.getState().endDrag();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") usePetStore.getState().endDrag(); // squirm free
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };
  }, [armed]);

  const showPet = enabled && (active || vanishing);
  // While carrying, every existing home stays mounted as an armed landing
  // pad (pane strips normally unmount when the pet lives elsewhere).
  if (!enabled || (myHome !== "sidebar" && !showPet && !armed)) return null;
  const animOverride =
    phase === "vanish" ? ("teleout" as const) : phase === "appear" ? ("telein" as const) : undefined;
  const actorVisible = phase !== "appear" || appearReady;
  const justLanded = enabled && landedAt > 0 && Date.now() - landedAt < LAND_MS && home === myHome;

  return (
    <div
      ref={stripRef}
      className={[
        "pet-strip",
        myHome === "sidebar" ? "pet-strip-sidebar" : "pet-strip-pane",
        armed ? "pet-strip-armed" : "",
        armed && dragOver === myHome ? "pet-strip-drop-hover" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-home={myHome}
    >
      {/* Zero-width slot at the pet's x fraction; the 48px actor centres on it
          via its own negative margin. pointer events live on the small hit box
          around the art: press = pet, press+move = catch and carry. */}
      {showPet && actorVisible && !dragging && (
        <div
          className={`pet-slot${phase ? ` pet-slot-${phase}` : ""}${justLanded ? " pet-slot-landed" : ""}`}
          style={{ left: `${x * 100}%` }}
        >
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            role="button"
            aria-label={`Pet ${name} — click to pet, drag to move`}
            title={`${name} — click to pet, drag to carry`}
          >
            <PetActor animOverride={animOverride} />
          </div>
          {/* Spirit burst on landing — keyed by landedAt so a re-drop restarts
              it; the animation ends at opacity 0 and the stale span stays
              invisible until then. */}
          {justLanded && (
            <span className="pet-burst" key={landedAt} aria-hidden>
              {[0, 45, 90, 135, 180, 225, 270, 315].map((ang) => (
                <i key={ang} style={{ "--ang": `${ang}deg` } as React.CSSProperties} />
              ))}
            </span>
          )}
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
