// PetStrip — one "home" of the companion pet. Mounted above the sidebar
// search and above the chat composer; both render the same store state so the
// pet is synchronized everywhere it appears. Clicking the pet pets it (happy
// mood + hearts); the paw button opens the companion panel (a fixed-position
// portal, so the sidebar header's overflow-hidden can't clip it).
import { useCallback, useRef, useState } from "react";
import { PawPrint } from "lucide-react";

import { PetActor } from "./PetActor";
import { PetPanel } from "./PetPanel";
import { usePetStore } from "../../state/pet";

export function PetStrip({ home }: { home: "sidebar" | "composer" }) {
  const enabled = usePetStore((s) => s.enabled);
  const show = usePetStore((s) => (home === "sidebar" ? s.showInSidebar : s.showInComposer));
  const name = usePetStore((s) => s.name);
  const x = usePetStore((s) => s.core.x);
  const petThePet = usePetStore((s) => s.petThePet);
  const [panelOpen, setPanelOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const pawRef = useRef<HTMLButtonElement>(null);

  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      if (!open) {
        const r = pawRef.current?.getBoundingClientRect();
        if (r) setAnchor({ x: r.right, y: r.bottom });
      }
      return !open;
    });
  }, []);
  const closePanel = useCallback(() => setPanelOpen(false), []);

  if (!enabled || !show) return null;

  return (
    <div className={`pet-strip pet-strip-${home}`} data-home={home}>
      {/* Zero-width slot at the pet's x fraction; the 48px actor centres on it
          via its own negative margin. pointer-events stay on the actor box. */}
      <div style={{ position: "absolute", left: `${x * 100}%`, bottom: 0, width: 0, height: "100%" }}>
        <div
          onClick={petThePet}
          role="button"
          aria-label={`Pet ${name}`}
          title={`${name} — click to pet`}
        >
          <PetActor />
        </div>
      </div>
      <button
        ref={pawRef}
        type="button"
        className="pet-panel-btn"
        onClick={togglePanel}
        aria-label="Companion settings"
        aria-expanded={panelOpen}
        title="Companion pet"
      >
        <PawPrint size={13} strokeWidth={1.8} />
      </button>
      {panelOpen && <PetPanel anchor={anchor} toggleRef={pawRef} onClose={closePanel} />}
    </div>
  );
}
