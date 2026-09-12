// PetPanel — the companion's control popover: rename, species, level/XP,
// cosmetic hats (level-locked), per-home visibility, lifetime stats, and the
// all-important "pet the pet" button. Everything here is also how you turn
// the pet off entirely (one click — the guardrail from the design doc).
//
// Rendered through a portal to document.body with fixed positioning, for the
// same reason as the pairing QR modal: the sidebar header's overflow-hidden
// (and its backdrop-filter containing block) would clip/trap an in-flow
// popover anchored inside the pet strip.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Heart, Lock, X } from "lucide-react";

import { PetActorMini } from "./PetActor";
import {
  PET_HATS,
  PET_SHEET_COLS,
  type PetHatKey,
} from "../../lib/pets/manifest";
import {
  levelThreshold,
  petLevel,
  PET_HAT_UNLOCKS,
  unlockedHats,
  usePetStore,
  type PetSpecies,
} from "../../state/pet";

const SPECIES: PetSpecies[] = ["cat", "axolotl", "robot"];
const PANEL_W = 264;

function HatChip({ hat }: { hat: PetHatKey }) {
  const index = PET_HATS.keys.indexOf(hat);
  const px = 22;
  return (
    <div
      className="pet-panel-hat-chip"
      style={{
        backgroundImage: `url(${PET_HATS.sheet})`,
        backgroundSize: `${PET_SHEET_COLS * px}px ${px}px`,
        backgroundPosition: `-${index * px}px 0`,
      }}
    />
  );
}

export function PetPanel({
  anchor,
  toggleRef,
  onClose,
}: {
  /** viewport-space point the panel hangs from (paw button's bottom-right) */
  anchor: { x: number; y: number };
  /** the strip's paw button — clicks on it must not count as "outside" */
  toggleRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const species = usePetStore((s) => s.species);
  const name = usePetStore((s) => s.name);
  const hat = usePetStore((s) => s.hat);
  const enabled = usePetStore((s) => s.enabled);
  const xp = usePetStore((s) => s.core.xp);
  const stats = usePetStore((s) => s.core.stats);
  const showInSidebar = usePetStore((s) => s.showInSidebar);
  const showInComposer = usePetStore((s) => s.showInComposer);
  const setSpecies = usePetStore((s) => s.setSpecies);
  const setName = usePetStore((s) => s.setName);
  const setHat = usePetStore((s) => s.setHat);
  const setEnabled = usePetStore((s) => s.setEnabled);
  const setShowHome = usePetStore((s) => s.setShowHome);
  const petThePet = usePetStore((s) => s.petThePet);
  const [nameDraft, setNameDraft] = useState(name);
  // Adopting a different species renames the pet (to that species' default) —
  // keep the input draft in sync so it doesn't show the previous name.
  useEffect(() => setNameDraft(name), [name]);

  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss on any mousedown outside the card or the paw toggle, and on
  // Escape. The toggle is excluded so its own click can toggle us closed.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (toggleRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, toggleRef]);

  const commitName = useCallback(() => setName(nameDraft), [setName, nameDraft]);

  const level = petLevel(xp);
  const cur = levelThreshold(level);
  const next = levelThreshold(level + 1);
  const progress = next > cur ? Math.min(100, Math.round(((xp - cur) / (next - cur)) * 100)) : 100;
  const unlocked = unlockedHats(xp);
  const unlockLevel = (h: PetHatKey) => PET_HAT_UNLOCKS.find((u) => u.hat === h)?.level ?? 99;

  return createPortal(
    <div
      ref={rootRef}
      className="pet-panel"
      role="dialog"
      aria-label={`Companion pet ${name}`}
      style={{
        position: "fixed",
        top: anchor.y + 6,
        left: Math.max(8, Math.min(anchor.x - PANEL_W, window.innerWidth - PANEL_W - 8)),
      }}
    >
      <div className="pet-panel-head">
        <input
          className="pet-panel-name"
          value={nameDraft}
          maxLength={24}
          aria-label="Pet name"
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <span className="pet-panel-level">LV {level}</span>
        <button type="button" className="pet-panel-close" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <div className="pet-panel-stage">
        <PetActorMini species={species} size={64} />
      </div>

      <div className="pet-panel-body">
        <div className="pet-panel-xp-label">
          {xp} XP{next > xp ? ` · ${next - xp} to level ${level + 1}` : " · max level"}
        </div>
        <div className="pet-panel-xp">
          <div className="pet-panel-xp-fill" style={{ width: `${progress}%` }} />
        </div>

        <div className="pet-panel-section">Species</div>
        <div className="pet-panel-species">
          {SPECIES.map((sp) => (
            <button
              key={sp}
              type="button"
              className={`pet-panel-species-btn${sp === species ? " is-active" : ""}`}
              onClick={() => setSpecies(sp)}
              title={`Adopt the ${sp}`}
            >
              <PetActorMini species={sp} size={32} />
            </button>
          ))}
        </div>

        <div className="pet-panel-section">Hats</div>
        <div className="pet-panel-hats">
          <button
            type="button"
            className={`pet-panel-hat-btn${hat === null ? " is-active" : ""}`}
            onClick={() => setHat(null)}
            title="No hat"
          >
            <span style={{ fontSize: 13, opacity: 0.6 }}>—</span>
          </button>
          {PET_HATS.keys.map((h) => {
            const isUnlocked = unlocked.includes(h);
            return (
              <button
                key={h}
                type="button"
                className={`pet-panel-hat-btn${hat === h ? " is-active" : ""}`}
                disabled={!isUnlocked}
                onClick={() => setHat(h)}
                title={isUnlocked ? h : `${h} — unlocks at level ${unlockLevel(h)}`}
              >
                {isUnlocked ? <HatChip hat={h} /> : <Lock size={12} />}
              </button>
            );
          })}
        </div>

        <div className="pet-panel-section">Show pet</div>
        <div className="pet-panel-toggles">
          <label className="pet-panel-toggle">
            <input
              type="checkbox"
              checked={showInSidebar}
              onChange={(e) => setShowHome("sidebar", e.target.checked)}
            />
            In the sidebar
          </label>
          <label className="pet-panel-toggle">
            <input
              type="checkbox"
              checked={showInComposer}
              onChange={(e) => setShowHome("composer", e.target.checked)}
            />
            Above the composer
          </label>
          <label className="pet-panel-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
        </div>

        <div className="pet-panel-stats">
          <span><b>{stats.turns}</b> turns</span>
          <span><b>{stats.automations}</b> runs</span>
          <span><b>{stats.errors}</b> survived</span>
          <span><b>{stats.pets}</b> pets</span>
        </div>
      </div>

      <div className="pet-panel-foot">
        <button type="button" className="pet-panel-pet-btn" onClick={petThePet}>
          <Heart size={11} style={{ display: "inline", verticalAlign: "-1px", marginRight: 4 }} />
          Pet the pet
        </button>
        <button
          type="button"
          className="pet-panel-close"
          onClick={() => {
            setEnabled(false);
            onClose();
          }}
          title="Turn the companion off"
        >
          dismiss pet
        </button>
      </div>
    </div>,
    document.body,
  );
}
