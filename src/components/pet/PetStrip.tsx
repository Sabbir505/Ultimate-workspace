// PetStrip — one "home" of the companion pet. Mounted above the sidebar
// search and above the chat composer; both render the same store state so the
// pet is synchronized everywhere it appears. Clicking the pet pets it (happy
// mood + hearts); the paw button opens the companion panel.
import { useCallback, useEffect, useRef, useState } from "react";
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
  const rootRef = useRef<HTMLDivElement>(null);

  const closePanel = useCallback(() => setPanelOpen(false), []);

  // Dismiss the panel on any outside click (panel stays inside the strip's
  // DOM so it scrolls with its home; no portal, no occlusion registration).
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPanelOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [panelOpen]);

  if (!enabled || !show) return null;

  return (
    <div ref={rootRef} className={`pet-strip pet-strip-${home}`} data-home={home}>
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
        type="button"
        className="pet-panel-btn"
        onClick={() => setPanelOpen((o) => !o)}
        aria-label="Companion settings"
        aria-expanded={panelOpen}
        title="Companion pet"
      >
        <PawPrint size={13} strokeWidth={1.8} />
      </button>
      {panelOpen && <PetPanel onClose={closePanel} />}
    </div>
  );
}
