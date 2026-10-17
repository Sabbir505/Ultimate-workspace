// PetActor — renders the companion pet: a real 3D animal (src/lib/pets) in
// the six species the pets ship with, with the active speech bubble, dozing
// Zzz, petting hearts and level-up confetti layered around it.
//
// The sprite-sheet renderer is still here as the FALLBACK: jsdom (tests) and
// machines without WebGL get the 2D sprite exactly as before, and the three
// species without a sheet (fox / panda / dragon) draw an emoji chip there.
// Hats are a sprite cosmetic — they render in the fallback only.
//
// Frame timing for the fallback runs on a 100ms local clock (well under the
// slowest sheet fps) so both pet homes and the panel preview stay in sync off
// store state alone. `prefers-reduced-motion` freezes the fallback's frame at
// 0 — moods still change poses.
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
import { PET_EMOJI } from "../../lib/pets/manifest";
import { PetAvatar } from "./PetAvatar";
import { webglAvailable } from "../../lib/pets/stage";
import type { PetState as EnginePetState } from "../../lib/pets/stage";

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
  zoomies: "zoomies",
  focus: "idle",
  caught: "happy", // dangling in the hand — the paws-up row + the carrier's wriggle
};

/** Mood → what the 3D pet should be doing. `watching`/`focus` read as idle
 *  (the engine's idle already glances around); `concerned` sits close to
 *  idle too — there is no worried state in the engine. */
const MOOD_STATE: Record<PetMood, EnginePetState> = {
  idle: "idle",
  walk: "strolling",
  watching: "idle",
  work: "working",
  celebrate: "celebrating",
  concerned: "idle",
  doze: "sleeping",
  happy: "celebrating",
  zoomies: "strolling",
  focus: "idle",
  caught: "strolling",
};

/** Whether the 3D renderer is live for this webview. Computed once per module
 *  load: a webview that has WebGL today will have it for the session, and the
 *  probe is cheap but not free. */
let cached3d: boolean | null = null;
function use3d(): boolean {
  const [ok] = useState(() => {
    if (cached3d === null) cached3d = webglAvailable();
    return cached3d;
  });
  return ok;
}

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

export function PetActor({ animOverride }: { animOverride?: "teleout" | "telein" }) {
  const species = usePetStore((s) => s.species);
  const name = usePetStore((s) => s.name);
  const hat = usePetStore((s) => s.hat);
  const mood = usePetStore((s) => s.core.mood);
  const bubble = usePetStore((s) => s.bubble);
  const heartAt = usePetStore((s) => s.heartAt);
  const levelUpAt = usePetStore((s) => s.levelUpAt);
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

  const threeD = use3d();
  const def = PET_SPECIES[species];
  const anim = PET_ANIMS[animOverride ?? MOOD_ANIM[mood]];
  const elapsed = now - phase.current.at;
  const rawFrame = Math.floor(elapsed / (1000 / anim.fps));
  // Teleport animations play ONCE and hold their last frame (a scanline
  // dissolve that loops would never finish vanishing); moods loop forever —
  // except under reduced motion, where they hold a single pose. Focus is the
  // standing pose frozen on its closed-eyes frame: meditation.
  const frame = animOverride
    ? Math.min(rawFrame, anim.frames - 1)
    : mood === "focus"
      ? 1
      : reduced
        ? 0
        : rawFrame % anim.frames;
  const facing = usePetStore((s) => s.core.facing);

  // Sheet slicing uses PERCENTAGES, not pixels: pixel offsets accumulate
  // rounding error whenever the effective scale isn't an integer (app zoom,
  // Windows display scaling), which tears a frame into offset slices — the
  // "head detached from body" rendering bug. Percent positions are resolved
  // by the compositor at device precision and can't drift.
  // X spans the FULL sheet width (4 columns) even when an animation uses
  // fewer frames — frame N lives in column N, so the denominator is
  // COLS-1, not the animation's frame count.
  const posX = (frame / (PET_SHEET_COLS - 1)) * 100;
  const posY = (anim.row / (PET_SHEET_ROWS - 1)) * 100;

  // Hat overlay: same 16×16 box, anchored to whichever pose is playing —
  // the curled doze and crouched celebrate silhouettes carry the head much
  // lower than standing, so they get their own anchors. While teleporting
  // the hat is hidden (the pet dissolves without it); while dozing the
  // headphones come off.
  let hatStyle: React.CSSProperties | undefined;
  const anchor = animOverride
    ? null
    : mood === "doze"
      ? def.hatAnchorDoze
      : mood === "celebrate"
        ? def.hatAnchorCelebrate
        : def.hatAnchor;
  if (hat && anchor && !(mood === "doze" && hat === "headphones")) {
    const hatIndex = PET_HATS.keys.indexOf(hat as PetHatKey);
    const raiseRows = hat === "headphones" ? 0 : anchor.y - PET_HAT_BOTTOM[hat];
    hatStyle = {
      backgroundImage: `url(${PET_HATS.sheet})`,
      backgroundSize: `${PET_HATS.frame * PET_SCALE * PET_HATS.keys.length}px ${PET_HATS.frame * PET_SCALE}px`,
      backgroundPosition: `-${hatIndex * PET_HATS.frame * PET_SCALE}px 0px`,
      transform: `translateY(${raiseRows * PET_SCALE}px)`,
      transformOrigin: "center bottom",
    };
  }

  const heartsActive = now - heartAt < 1300 && heartAt > 0;
  const levelUpActive = now - levelUpAt < 1800 && levelUpAt > 0;
  const bubbleVisible = bubble !== null && bubble.until > now;

  return (
    <div className="pet-actor" data-mood={mood} title={name}>
      {threeD ? (
        /* The living pet. Size matches the sprite box so every layout that
           ever measured the actor keeps measuring the same box. */
        <PetAvatar
          species={species}
          size={SIZE}
          state={animOverride === "teleout" ? "sleeping" : MOOD_STATE[mood]}
          className="pet-actor-3d"
        />
      ) : def.sheet ? (
        <div
          className="pet-sprite"
          data-mood={mood}
          style={{
            width: SIZE,
            height: SIZE,
            backgroundImage: `url(${def.sheet})`,
            backgroundSize: `${PET_SHEET_COLS * 100}% ${PET_SHEET_ROWS * 100}%`,
            backgroundPosition: `${posX}% ${posY}%`,
            transform: facing === -1 ? "scaleX(-1)" : undefined,
          }}
        />
      ) : (
        /* A sheetless species on the fallback renderer: an emoji chip in the
           same box (fox / panda / dragon have no sprite sheet). */
        <div
          className="pet-sprite pet-sprite-emoji"
          data-mood={mood}
          style={{ width: SIZE, height: SIZE, fontSize: SIZE * 0.62 }}
          aria-hidden
        >
          {PET_EMOJI[species] ?? "🐾"}
        </div>
      )}
      {!threeD && hatStyle && <div className="pet-hat" style={hatStyle} />}
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
      {levelUpActive && (
        <span className="pet-confetti" key={`c${levelUpAt}`} aria-hidden>
          {["#ff8fae", "#ffd166", "#5fd4c4", "#7b68d9", "#ff8fae", "#ffd166", "#5fd4c4", "#7b68d9"].map(
            (c, i) => (
              <i key={i} style={{ background: c, left: 2 + i * 6 }} />
            ),
          )}
        </span>
      )}
      {bubbleVisible && (
        <div className="pet-bubble" role="status">{bubble!.text}</div>
      )}
    </div>
  );
}

/** A still miniature for panel pickers: the real 3D pet when the stage is up
 *  (it is, on every desktop with WebGL), an emoji chip when it is not. */
export function PetActorMini({ species, size = 32 }: { species: PetActorSpecies; size?: number }) {
  return (
    <div className="pet-actor" style={{ width: size, height: size }}>
      <PetAvatar species={species} size={size} className="pet-actor-mini-3d" />
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
  const threeD = use3d();
  if (threeD) {
    return (
      <PetAvatar
        species={species}
        size={size}
        state={MOOD_STATE[mood]}
        className="pet-actor-animated-3d"
      />
    );
  }
  if (!def.sheet) {
    return (
      <span
        className="pet-sprite pet-sprite-emoji"
        style={{ position: "relative", inset: "auto", width: size, height: size, fontSize: size * 0.62 }}
        aria-hidden
      >
        {PET_EMOJI[species] ?? "🐾"}
      </span>
    );
  }
  return (
    <div
      className="pet-sprite"
      style={{
        position: "relative",
        inset: "auto",
        width: size,
        height: size,
        backgroundImage: `url(${def.sheet})`,
        backgroundSize: `${PET_SHEET_COLS * 100}% ${PET_SHEET_ROWS * 100}%`,
        backgroundPosition: `${(frame / (PET_SHEET_COLS - 1)) * 100}% ${(anim.row / (PET_SHEET_ROWS - 1)) * 100}%`,
      }}
    />
  );
}
