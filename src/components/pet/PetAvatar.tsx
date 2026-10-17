// PetAvatar — a small, self-contained rendering of one pet: the bot's docked
// companion, the editor's picker, the rail's row marker.
//
// It hosts a real 3D pet (one shared stage, see src/lib/pets/stage.ts) inside
// its own element, and falls back to a CSS chip when 3D is unavailable (jsdom
// tests, no WebGL) so nothing that renders an avatar can crash a test or a
// machine without a GPU.

import { useEffect, useRef, useState } from "react";
import { mountPet, type PetHandle, type PetKind, type PetState } from "../../lib/pets/stage";
import { PET_EMOJI } from "../../lib/pets/manifest";

export interface PetAvatarProps {
  /** One of the six species. Unknown values render the fallback chip. */
  species: string;
  /** Square size in CSS pixels (used for height, and width unless `width` is set). */
  size?: number;
  /** Host width (px or any CSS length). Defaults to `size` (square). A wider
   *  host gives the 3D pet room to walk left/right — the stage draws the pet
   *  into this element's rectangle. */
  width?: number | string;
  /** What the pet is doing — bots map their state here (working / sleeping). */
  state?: PetState;
  /** Which way it faces: 1 (right) / -1 (left). Used by callers that move the
   *  pet themselves so it never walks backwards. */
  facing?: 1 | -1;
  className?: string;
  /** Extra inline styles (e.g. the dock's `left` stroll position), merged over
   *  the size box. */
  style?: React.CSSProperties;
  title?: string;
  /** Render the static in-DOM chip instead of the shared 3D stage. Needed
   *  inside frosted modals (Settings): the one shared stage canvas sits BELOW
   *  the glass (z-index 38 < the modal's 40/50), so a mounted pet would be
   *  smeared by the modal's backdrop-filter blur. The chip lives in the DOM,
   *  so it stays crisp on top of the glass. */
  flat?: boolean;
}

function isPetKind(species: string): species is PetKind {
  return species in PET_EMOJI;
}

export function PetAvatar({ species, size = 32, width, state = "idle", facing, className, style, title, flat = false }: PetAvatarProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<PetHandle | null>(null);
  const [live, setLive] = useState(false);
  // Latest facing, so a value set before the async mount lands still applies.
  const facingRef = useRef<1 | -1>(facing ?? 1);
  facingRef.current = facing ?? 1;

  useEffect(() => {
    let disposed = false;
    const el = host.current;
    // `flat` never touches the shared 3D stage — it draws the crisp in-DOM
    // chip, which is the only thing visible above a frosted modal.
    if (flat || !el || !isPetKind(species)) return;
    void mountPet(el, species, state).then((h) => {
      if (disposed || !h) {
        h?.remove();
        return;
      }
      handle.current = h;
      h.setFacing?.(facingRef.current);
      setLive(true);
    });
    return () => {
      disposed = true;
      handle.current?.remove();
      handle.current = null;
      setLive(false);
    };
    // `state` is applied by the effect below; re-mounting on every mood tick
    // would churn GL objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [species, flat]);

  useEffect(() => {
    handle.current?.setState(state);
  }, [state]);

  useEffect(() => {
    handle.current?.setFacing(facing ?? 1);
  }, [facing]);

  const label = title ?? species;
  const showChip = flat || !live;
  return (
    <span
      ref={host}
      className={`pet-avatar${flat ? " is-flat" : live ? " is-live" : " is-fallback"}${className ? ` ${className}` : ""}`}
      style={{ width: width ?? size, height: size, ...style }}
      title={label}
      aria-label={label}
      role="img"
    >
      {showChip && (
        <span
          className="pet-avatar-fallback"
          style={flat ? { fontSize: Math.max(12, Math.round(size * 0.72)) } : undefined}
        >
          {PET_EMOJI[species] ?? "🐾"}
        </span>
      )}
    </span>
  );
}
