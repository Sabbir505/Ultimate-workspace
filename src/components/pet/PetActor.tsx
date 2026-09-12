// PetActor — renders the companion pet: one mood-driven animation frame of
// the species sprite sheet, facing left/right, with the cosmetic hat overlay,
// the active speech bubble, dozing Zzz and petting hearts.
//
// Frame timing runs on a 100ms local clock (well under the slowest sheet fps)
// so both pet homes and the panel preview stay in sync off store state alone.
// `prefers-reduced-motion` freezes the frame at 0 — moods still change poses.
import { useEffect, useRef, useState } from "react";

import {
  PET_ANIMS,
  PET_FRAME,
  PET_HATS,
  PET_HAT_BOTTOM,
  PET_SHEET_COLS,
  PET_SHEET_ROWS,
  PET_SPECIES,
  type PetAnimKey,
  type PetHatKey,
} from "../../lib/pets/manifest";
import { usePetStore, type PetMood } from "../../state/pet";

export const PET_SCALE = 3;
const SIZE = PET_FRAME * PET_SCALE;

/** Sprite-sheet row per mood. `watching` shares the idle row (the blink
 *  already reads as attentive at 48px). */
const MOOD_ANIM: Record<PetMood, PetAnimKey> = {
  idle: "idle",
  walk: "walk",
  watching: "idle",
  work: "work",
  celebrate: "celebrate",
  concerned: "concerned",
  doze: "doze",
  happy: "happy",
};

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try {
      return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    } catch {
      return false; // environments without matchMedia (jsdom)
    }
  });
  useEffect(() => {
    let mq: MediaQueryList | undefined;
    try {
      mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    } catch {
      return; // jsdom & co.
    }
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function PetActor() {
  const species = usePetStore((s) => s.species);
  const name = usePetStore((s) => s.name);
  const hat = usePetStore((s) => s.hat);
  const mood = usePetStore((s) => s.core.mood);
  const bubble = usePetStore((s) => s.bubble);
  const heartAt = usePetStore((s) => s.heartAt);
  const reduced = useReducedMotion();

  // Free-running 10fps clock for frame selection + particle lifetime.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);

  // Phase anchor: restart the animation whenever the mood changes.
  const phase = useRef({ mood, at: now });
  if (phase.current.mood !== mood) phase.current = { mood, at: now };

  const def = PET_SPECIES[species];
  const anim = PET_ANIMS[MOOD_ANIM[mood]];
  const elapsed = now - phase.current.at;
  const frame = reduced ? 0 : Math.floor(elapsed / (1000 / anim.fps)) % anim.frames;
  const facing = usePetStore((s) => s.core.facing);

  const sheetW = PET_SHEET_COLS * SIZE;
  const sheetH = PET_SHEET_ROWS * SIZE;

  // Hat overlay: same 16×16 box, raised so the hat's lowest art row lands on
  // the species' hat anchor (its head top). Headphones stay unmoved — their
  // pads wrap the face at frame rows 4-7 for every species.
  let hatStyle: React.CSSProperties | undefined;
  if (hat) {
    const hatIndex = PET_HATS.keys.indexOf(hat as PetHatKey);
    const raise = PET_HAT_BOTTOM[hat] - def.hatAnchor.y;
    hatStyle = {
      backgroundImage: `url(${PET_HATS.sheet})`,
      backgroundSize: `${PET_HATS.frame * PET_SCALE * PET_HATS.keys.length}px ${PET_HATS.frame * PET_SCALE}px`,
      backgroundPosition: `-${hatIndex * PET_HATS.frame * PET_SCALE}px 0px`,
      transform: `translateY(${raise * PET_SCALE}px)`,
      transformOrigin: "center bottom",
    };
  }

  const heartsActive = now - heartAt < 1300 && heartAt > 0;
  const bubbleVisible = bubble !== null && bubble.until > now;

  return (
    <div className="pet-actor" title={name}>
      <div
        className="pet-sprite"
        data-mood={mood}
        style={{
          width: SIZE,
          height: SIZE,
          backgroundImage: `url(${def.sheet})`,
          backgroundSize: `${sheetW}px ${sheetH}px`,
          backgroundPosition: `-${frame * SIZE}px -${anim.row * SIZE}px`,
          transform: facing === -1 ? "scaleX(-1)" : undefined,
        }}
      />
      {hatStyle && <div className="pet-hat" style={hatStyle} />}
      {/* Hit box hugs the art, not the 16×16 frame — so the pet never swallows
          clicks meant for things it overlaps (the paw button, the search). */}
      <div className="pet-hit" />
      {mood === "doze" && !reduced && (
        <>
          <span className="pet-zzz">z</span>
          <span className="pet-zzz">z</span>
          <span className="pet-zzz">z</span>
        </>
      )}
      {heartsActive && (
        <>
          <span className="pet-heart" key={`h${heartAt}`} style={{ left: 14 }}>♥</span>
          <span className="pet-heart" key={`h2${heartAt}`}>♥</span>
          <span className="pet-heart" key={`h3${heartAt}`}>♥</span>
        </>
      )}
      {bubbleVisible && (
        <div className="pet-bubble" role="status">{bubble!.text}</div>
      )}
    </div>
  );
}

/** A static (frame 0, facing right) miniature for panel pickers. */
export function PetActorMini({ species, size = 32 }: { species: PetActorSpecies; size?: number }) {
  const def = PET_SPECIES[species];
  return (
    <div className="pet-actor" style={{ width: size, height: size }}>
      <div
        className="pet-sprite"
        style={{
          width: size,
          height: size,
          backgroundImage: `url(${def.sheet})`,
          backgroundSize: `${PET_SHEET_COLS * size}px ${PET_SHEET_ROWS * size}px`,
          backgroundPosition: "0 0",
        }}
      />
    </div>
  );
}
type PetActorSpecies = keyof typeof PET_SPECIES;

/** A looping, mood-driven sprite for preview rows (Settings, harness). */
export function AnimatedSprite({
  species,
  mood,
  size = PET_FRAME * PET_SCALE,
}: {
  species: PetActorSpecies;
  mood: PetMood;
  size?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  const phase = useRef({ mood, at: now });
  if (phase.current.mood !== mood) phase.current = { mood, at: now };
  const def = PET_SPECIES[species];
  const anim = PET_ANIMS[MOOD_ANIM[mood]];
  const frame = Math.floor((now - phase.current.at) / (1000 / anim.fps)) % anim.frames;
  return (
    <div
      className="pet-sprite"
      style={{
        position: "relative",
        inset: "auto",
        width: size,
        height: size,
        backgroundImage: `url(${def.sheet})`,
        backgroundSize: `${PET_SHEET_COLS * size}px ${PET_SHEET_ROWS * size}px`,
        backgroundPosition: `-${frame * size}px -${anim.row * size}px`,
      }}
    />
  );
}
