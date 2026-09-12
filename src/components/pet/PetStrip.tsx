// PetStrip — one "home" of the companion pet (above the sidebar search, or
// above the chat composer). The pet lives in exactly ONE home at a time and
// teleports between them: the old home plays a vanish animation for the first
// half of the teleport window, the new home plays a materialise animation for
// the second half. Only the sidebar home carries the paw button (panel).
import { useCallback, useRef, useState } from "react";
import { PawPrint } from "lucide-react";

import { PetActor } from "./PetActor";
import { PetPanel } from "./PetPanel";
import { PET_TELEPORT_MS, usePetStore } from "../../state/pet";

const PANEL_CLOSE_MS = 170;

export function PetStrip({ myHome }: { myHome: "sidebar" | "composer" }) {
  const enabled = usePetStore((s) => s.enabled);
  const home = usePetStore((s) => s.home);
  const teleport = usePetStore((s) => s.teleport);
  const name = usePetStore((s) => s.name);
  const x = usePetStore((s) => s.core.x);
  const petThePet = usePetStore((s) => s.petThePet);
  const [panel, setPanel] = useState<"closed" | "open" | "closing">("closed");
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const pawRef = useRef<HTMLButtonElement>(null);

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

  // Only the active home renders the pet — except during the first half of a
  // teleport, when the home being left plays its vanish animation. The
  // sidebar strip itself always renders (it owns the paw button + panel no
  // matter where the pet currently is).
  const active = home === myHome;
  const vanishing = teleport !== null && teleport.from === myHome;
  const showPet = enabled && (active || vanishing);
  if (!enabled || (myHome === "composer" && !showPet)) return null;
  const teleporting = teleport !== null && Date.now() < teleport.until;
  const phase = vanishing ? "vanish" : teleporting ? "appear" : undefined;

  return (
    <div className={`pet-strip pet-strip-${myHome}`} data-home={myHome}>
      {/* Zero-width slot at the pet's x fraction; the 48px actor centres on
          it via its own negative margin. pointer-events stay on the small hit
          box around the art, so the pet can never swallow clicks meant for
          the paw button or the search. */}
      {showPet && (
        <div
          className={`pet-slot${phase ? ` pet-slot-${phase}` : ""}`}
          style={{ left: `${x * 100}%` }}
        >
          <div
            onClick={petThePet}
            role="button"
            aria-label={`Pet ${name}`}
            title={`${name} — click to pet`}
          >
            <PetActor />
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

export { PANEL_CLOSE_MS, PET_TELEPORT_MS };
