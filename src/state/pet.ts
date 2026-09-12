// Companion-pet store — the pet's brain.
//
// The core is two PURE functions (`reducePet`, `tickPet`) over a small mood
// state: everything the pet does is either a reaction to an app event or the
// passage of time. The Zustand store wraps them, adds the cosmetic/persistent
// slice (species, name, hat, XP, settings) and localStorage persistence, the
// same way the notification center does (small, must be readable
// synchronously at boot).
//
// Design rules (docs/superpowers/specs/2026-09-12-companion-pet-design.md):
// the pet is presence, not a chore — no decay, no guilt, no notifications,
// no sound. Neglect only ever makes it nap.
import { create } from "zustand";

import { PET_SPECIES, type PetHatKey } from "../lib/pets/manifest";
import { petLine, type PetLineTrigger } from "../lib/pets/lines";

// ── Types ────────────────────────────────────────────────────────────────────

export type PetSpecies = "cat" | "axolotl" | "robot";
export type PetMood =
  | "idle"
  | "walk" // strolling within its strip
  | "watching" // built-in chat streaming — attentive
  | "work" // agent panes producing output — typing along
  | "celebrate" // turn / automation success
  | "concerned" // error / crash
  | "doze" // idle for a long time
  | "happy"; // petted

export type PetEvent =
  | { type: "chatToken" } // built-in chat streaming
  | { type: "agentOutput" } // PTY pane producing output
  | { type: "celebrate"; source: "turn" | "automation" }
  | { type: "concerned"; source: "error" | "crash" }
  | { type: "activity" } // any sign of life — refreshes idle timers only
  | { type: "pet" } // user clicked the pet
  | { type: "wake" }; // window became visible / user returned

export interface PetStats {
  turns: number;
  automations: number;
  errors: number;
  pets: number;
}

/** Everything the pure state machine reads or writes. */
export interface PetCore {
  mood: PetMood;
  /** Epoch ms when the current transient mood expires (0 for idle/walk/doze). */
  moodUntil: number;
  lastEventAt: number;
  facing: 1 | -1;
  /** Position within its strip, 0..1. Both pet homes render the same pet. */
  x: number;
  targetX: number | null;
  nextWalkAt: number;
  xp: number;
  stats: PetStats;
}

export interface PetSettings {
  species: PetSpecies;
  name: string;
  hat: PetHatKey | null;
  enabled: boolean;
  /** Which home the pet currently lives in — it teleports between them. */
  home: "sidebar" | "composer";
  /** Epoch ms of the last app session — powers the "while you were away"
   *  morning bubble. */
  lastSeen: number;
}

/** Active teleport: the pet is vanishing from `from` (first half of the
 *  window) and materialising in `home` (second half). Ephemeral. */
export interface PetTeleport {
  from: "sidebar" | "composer";
  until: number;
}

// ── Tuning constants ─────────────────────────────────────────────────────────

export const PET_WALK_SPEED = 0.09; // strip fraction per second
const CELEBRATE_MS = 4000;
const CONCERNED_MS = 6000;
const HAPPY_MS = 2600;
const WATCH_MS = 2500; // refreshed continuously while chat streams
const WORK_MS = 3000; // refreshed continuously while panes emit output
export const PET_DOZE_AFTER_MS = 4 * 60_000;
const WALK_MIN_MS = 9_000;
const WALK_RANGE_MS = 14_000;
/** Total vanish→appear window for a home-to-home teleport (390ms dissolve +
 *  400ms materialise, plus a little settle room). */
export const PET_TELEPORT_MS = 820;
const BUBBLE_MS = 3600;
const BUBBLE_GAP_MS = 50_000; // min spacing between speech bubbles
const BUBBLE_CHANCE = 0.35;

const MOOD_DURATION: Partial<Record<PetMood, number>> = {
  celebrate: CELEBRATE_MS,
  concerned: CONCERNED_MS,
  happy: HAPPY_MS,
  watching: WATCH_MS,
  work: WORK_MS,
};

/** Mood priority — higher-rank transient moods aren't downgraded by lower
 *  event streams (a celebration survives chat tokens still arriving). */
const MOOD_RANK: Record<PetMood, number> = {
  concerned: 5,
  celebrate: 4,
  happy: 3,
  work: 2,
  watching: 1,
  walk: 1,
  idle: 0,
  doze: 0,
};

// ── Progression ──────────────────────────────────────────────────────────────

/** XP needed to REACH level `l` (level 1 starts at 0): 50, 125, 225, 350… */
export function levelThreshold(l: number): number {
  if (l <= 1) return 0;
  const n = l - 1;
  return 50 * n + 25 * ((n * (n - 1)) / 2);
}
export function petLevel(xp: number): number {
  let l = 1;
  while (l < 30 && xp >= levelThreshold(l + 1)) l++;
  return l;
}
/** Cosmetic hats unlock with levels — the progression is dress-up, not
 *  evolution (re-drawing every animation per growth stage tripled the art
 *  surface for little delight). */
export const PET_HAT_UNLOCKS: { hat: PetHatKey; level: number }[] = [
  { hat: "party", level: 2 },
  { hat: "headphones", level: 3 },
  { hat: "wizard", level: 4 },
  { hat: "crown", level: 5 },
];
export function unlockedHats(xp: number): PetHatKey[] {
  const lvl = petLevel(xp);
  return PET_HAT_UNLOCKS.filter((u) => u.level <= lvl).map((u) => u.hat);
}

// ── Pure state machine ───────────────────────────────────────────────────────

let petReducedMotion = false;
/** Set from the hook via matchMedia — with reduced motion the pet still
 *  changes pose and mood, it just doesn't stroll. */
export function setPetReducedMotion(v: boolean): void {
  petReducedMotion = v;
}

export function initialPetCore(now: number): PetCore {
  return {
    mood: "idle",
    moodUntil: 0,
    lastEventAt: now,
    facing: 1,
    x: 0.85,
    targetX: null,
    nextWalkAt: now + WALK_MIN_MS,
    xp: 0,
    stats: { turns: 0, automations: 0, errors: 0, pets: 0 },
  };
}

/** Reward table — XP comes from real shipping events only. */
const XP_AWARD = { turn: 6, automation: 10, error: 1, pet: 1 } as const;

export function reducePet(core: PetCore, event: PetEvent, now: number): PetCore {
  const next: PetCore = { ...core, lastEventAt: now };
  const active = core.moodUntil > now; // transient mood still running
  const rank = MOOD_RANK[core.mood];

  switch (event.type) {
    case "chatToken": {
      // Watching = attentive. Never pulls the pet out of a stronger mood.
      if (!active || rank <= MOOD_RANK.watching) {
        next.mood = "watching";
        next.moodUntil = now + WATCH_MS;
      }
      return next;
    }
    case "agentOutput": {
      if (!active || rank <= MOOD_RANK.work) {
        next.mood = "work";
        next.moodUntil = now + WORK_MS;
        next.targetX = null;
      }
      return next;
    }
    case "celebrate": {
      next.mood = "celebrate";
      next.moodUntil = now + CELEBRATE_MS;
      next.xp = core.xp + (event.source === "automation" ? XP_AWARD.automation : XP_AWARD.turn);
      next.stats = {
        ...core.stats,
        turns: core.stats.turns + (event.source === "turn" ? 1 : 0),
        automations: core.stats.automations + (event.source === "automation" ? 1 : 0),
      };
      return next;
    }
    case "concerned": {
      // Errors outrank everything — the pet should react even mid-celebration
      // (a celebration followed by a crash is exactly when you want company).
      next.mood = "concerned";
      next.moodUntil = now + CONCERNED_MS;
      next.xp = core.xp + XP_AWARD.error;
      next.stats = { ...core.stats, errors: core.stats.errors + 1 };
      return next;
    }
    case "pet": {
      // Direct user intent always wins — even mid-celebration or an error
      // reaction, a pet must visibly respond (a pet that ignores you reads
      // as broken and takes "two clicks").
      next.mood = "happy";
      next.moodUntil = now + HAPPY_MS;
      next.stats = { ...core.stats, pets: core.stats.pets + 1 };
      next.xp = core.xp + XP_AWARD.pet;
      return next;
    }
    case "activity":
    case "wake": {
      if (core.mood === "doze") {
        next.mood = "idle";
        next.moodUntil = 0;
        next.nextWalkAt = now + WALK_MIN_MS;
      }
      return next;
    }
  }
}

/** Advance time: expire transient moods, nap when ignored, stroll when idle.
 *  `dtSec` is the seconds since the previous tick. */
export function tickPet(
  core: PetCore,
  now: number,
  dtSec: number,
  rng: () => number = Math.random,
): PetCore {
  // Transient mood still running — nothing ages.
  if (core.moodUntil > now) return core;

  const expiredTransient = core.mood !== "idle" && core.mood !== "walk" && core.mood !== "doze";
  if (expiredTransient) {
    return {
      ...core,
      mood: "idle",
      moodUntil: 0,
      nextWalkAt: now + WALK_MIN_MS + rng() * WALK_RANGE_MS,
    };
  }

  // Long silence → nap. Waking is handled by reducePet (any event).
  if (core.mood === "idle" && now - core.lastEventAt >= PET_DOZE_AFTER_MS) {
    return { ...core, mood: "doze", targetX: null };
  }

  // Stroll: pick a target and walk there. Targets favour the right side of
  // the strip — the pet's "spot" is next to the paw button — but stop short
  // enough that the 48px actor box stays inside the narrow sidebar.
  if (core.mood === "idle" && core.targetX === null && !petReducedMotion && now >= core.nextWalkAt) {
    return { ...core, mood: "walk", targetX: 0.4 + rng() * 0.48, moodUntil: 0 };
  }
  if (core.mood === "walk" && core.targetX !== null) {
    const dx = core.targetX - core.x;
    const step = PET_WALK_SPEED * Math.max(dtSec, 0);
    if (Math.abs(dx) <= step) {
      return {
        ...core,
        x: core.targetX,
        targetX: null,
        mood: "idle",
        nextWalkAt: now + WALK_MIN_MS + rng() * WALK_RANGE_MS,
      };
    }
    return { ...core, x: core.x + Math.sign(dx) * step, facing: dx > 0 ? 1 : -1 };
  }

  return core;
}

// ── Persistence ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "relay.pet.v1";

function loadPersistedSettings(): PetSettings {
  const fallback: PetSettings = {
    species: "cat",
    name: PET_SPECIES.cat.defaultName,
    hat: null,
    enabled: true,
    home: "sidebar",
    lastSeen: Date.now(),
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PetSettings>;
    const species: PetSpecies =
      parsed.species === "axolotl" || parsed.species === "robot" ? parsed.species : "cat";
    return {
      species,
      name:
        typeof parsed.name === "string" && parsed.name.trim()
          ? parsed.name
          : PET_SPECIES[species].defaultName,
      hat: typeof parsed.hat === "string" ? (parsed.hat as PetHatKey) : null,
      enabled: parsed.enabled !== false,
      home: parsed.home === "composer" ? "composer" : "sidebar",
      lastSeen: typeof parsed.lastSeen === "number" ? parsed.lastSeen : Date.now(),
    };
  } catch {
    return fallback;
  }
}

function loadPersistedCore(): PetCore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialPetCore(Date.now());
    const parsed = JSON.parse(raw) as { xp?: number; stats?: Partial<PetStats> };
    const base = initialPetCore(Date.now());
    return {
      ...base,
      xp: typeof parsed.xp === "number" && parsed.xp >= 0 ? parsed.xp : 0,
      stats: { ...base.stats, ...(parsed.stats ?? {}) },
    };
  } catch {
    return initialPetCore(Date.now());
  }
}

function persist(settings: PetSettings, core: PetCore): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        species: settings.species,
        name: settings.name,
        hat: settings.hat,
        enabled: settings.enabled,
        home: settings.home,
        lastSeen: settings.lastSeen,
        xp: core.xp,
        stats: core.stats,
      }),
    );
  } catch {
    // Storage unavailable — the pet lives in memory for this session.
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

interface PetStoreState extends PetSettings {
  core: PetCore;
  /** Ephemeral: active speech bubble, heart-burst timestamp, bubble pacing,
   *  in-flight teleport. Not persisted. */
  bubble: { text: string; until: number } | null;
  heartAt: number;
  lastBubbleAt: number;
  teleport: PetTeleport | null;
  nextTeleportAt: number;

  event: (e: PetEvent) => void;
  tick: (now: number, dtSec: number) => void;
  /** Move the pet to a home with the teleport animation (default: the other
   *  one). Called by the scheduler and when chat starts streaming. */
  teleportTo: (home: "sidebar" | "composer") => void;
  showBubble: (text: string) => void;
  /** Morning greeting: queues a "while you were away" bubble when the last
   *  session is >6h old and `hasUnseenNews`; returns the line or null. */
  morningReport: (hasUnseenNews: boolean) => string | null;
  setSpecies: (s: PetSpecies) => void;
  setName: (name: string) => void;
  setHat: (hat: PetHatKey | null) => void;
  setEnabled: (v: boolean) => void;
  petThePet: () => void;
  /** DEV-only mood forcing for live testing (window.__pet). */
  debugForceMood: (mood: PetMood) => void;
  forgetAll: () => void;
}

function queueBubble(get: () => PetStoreState, set: (p: Partial<PetStoreState>) => void, line: string): void {
  const now = Date.now();
  set({ bubble: { text: line, until: now + BUBBLE_MS }, lastBubbleAt: now });
}

/** After an event, maybe speak: bubble throttle + chance gate + per-trigger
 *  line pool. Speech is the first thing sacrificed when it would spam. */
function maybeBubble(get: () => PetStoreState, set: (p: Partial<PetStoreState>) => void, e: PetEvent): void {
  const s = get();
  const now = Date.now();
  if (s.bubble && s.bubble.until > now) return;
  if (now - s.lastBubbleAt < BUBBLE_GAP_MS) return;
  if (Math.random() > BUBBLE_CHANCE) return;

  const trigger: PetLineTrigger | null =
    e.type === "celebrate"
      ? "celebrate"
      : e.type === "concerned"
        ? "concerned"
        : e.type === "pet"
          ? "pet"
          : e.type === "agentOutput"
            ? "work"
            : null;
  if (!trigger) return;
  const line = petLine(s.species, trigger, s.name);
  if (line) queueBubble(get, set, line);
}

export const usePetStore = create<PetStoreState>((set, get) => ({
  ...loadPersistedSettings(),
  core: loadPersistedCore(),
  bubble: null,
  heartAt: 0,
  lastBubbleAt: 0,
  teleport: null,
  nextTeleportAt: Date.now() + 90_000,

  event: (e) => {
    const prev = get().core;
    const core = reducePet(prev, e, Date.now());
    set({ core });
    // Tokens/output can stream hundreds of times a minute — only durable
    // changes (xp, counters) hit localStorage.
    if (core.xp !== prev.xp || core.stats !== prev.stats) persist(get(), core);
    maybeBubble(get, set, e);
  },

  tick: (now, dtSec) => {
    const prev = get().core;
    const core = tickPet(prev, now, dtSec);
    const patch: Partial<PetStoreState> = {};
    let changed = false;
    if (core !== prev) {
      patch.core = core;
      changed = true;
    }
    const bubble = get().bubble;
    if (bubble && bubble.until <= now) {
      patch.bubble = null;
      changed = true;
    }
    // Teleport lifecycle: clear the window when it lapses, and schedule a new
    // hop when the timer fires (only while the pet is between activities —
    // vanishing mid-celebration reads wrong).
    const teleport = get().teleport;
    if (teleport && now >= teleport.until) {
      patch.teleport = null;
      changed = true;
    }
    if (!teleport && now >= get().nextTeleportAt) {
      const s = get();
      const calm = s.core.mood === "idle" || s.core.mood === "walk" || s.core.mood === "doze";
      if (calm) {
        const to = s.home === "sidebar" ? "composer" : "sidebar";
        patch.home = to;
        patch.teleport = { from: s.home, until: now + PET_TELEPORT_MS };
        patch.nextTeleportAt = now + 120_000 + Math.random() * 120_000;
        changed = true;
        persist({ ...s, home: to }, s.core);
      } else {
        // busy — try again shortly
        patch.nextTeleportAt = now + 15_000;
        changed = true;
      }
    }
    if (changed) set(patch);
  },

  teleportTo: (home) => {
    const s = get();
    if (s.home === home || !s.enabled) return;
    const now = Date.now();
    set({
      home,
      teleport: { from: s.home, until: now + PET_TELEPORT_MS },
      nextTeleportAt: now + 120_000 + Math.random() * 120_000,
    });
    persist(get(), s.core);
  },

  showBubble: (text) => queueBubble(get, set, text),

  morningReport: (hasUnseenNews) => {
    const s = get();
    const awayFor = Date.now() - s.lastSeen;
    set({ lastSeen: Date.now() });
    persist(get(), get().core);
    if (awayFor > 6 * 60 * 60_000 && hasUnseenNews) {
      const line = petLine(s.species, "morning", s.name);
      if (line) {
        queueBubble(get, set, line);
        return line;
      }
    }
    return null;
  },

  setSpecies: (species) => {
    const name = PET_SPECIES[species].defaultName;
    set({ species, name });
    persist(get(), get().core);
    const line = petLine(species, "adopt", name);
    if (line) get().showBubble(line);
  },
  setName: (name) => {
    set({ name: name.trim().slice(0, 24) || PET_SPECIES[get().species].defaultName });
    persist(get(), get().core);
  },
  setHat: (hat) => {
    if (hat !== null && !unlockedHats(get().core.xp).includes(hat)) return;
    set({ hat });
    persist(get(), get().core);
  },
  setEnabled: (enabled) => {
    set({ enabled });
    persist(get(), get().core);
  },
  petThePet: () => {
    get().event({ type: "pet" });
    set({ heartAt: Date.now() });
  },

  debugForceMood: (mood) => {
    const dur = MOOD_DURATION[mood] ?? 0;
    set({ core: { ...get().core, mood, moodUntil: dur ? Date.now() + dur : 0 } });
  },

  forgetAll: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    set({
      ...loadPersistedSettings(),
      core: initialPetCore(Date.now()),
      bubble: null,
      teleport: null,
      nextTeleportAt: Date.now() + 90_000,
    });
  },
}));

/** DEV-only console hook for live testing: `__pet.celebrate()`, `__pet.work()`,
 *  `__pet.concern()`, `__pet.watch()`, `__pet.wake()`, `__pet.debug("doze")`. */
export function installPetDebugHook(): void {
  if (!import.meta.env.DEV) return;
  (window as unknown as Record<string, unknown>).__pet = {
    celebrate: () => usePetStore.getState().event({ type: "celebrate", source: "turn" }),
    automate: () => usePetStore.getState().event({ type: "celebrate", source: "automation" }),
    concern: () => usePetStore.getState().event({ type: "concerned", source: "error" }),
    work: () => usePetStore.getState().event({ type: "agentOutput" }),
    watch: () => usePetStore.getState().event({ type: "chatToken" }),
    wake: () => usePetStore.getState().event({ type: "wake" }),
    debug: (mood: PetMood) => usePetStore.getState().debugForceMood(mood),
    pet: () => usePetStore.getState().petThePet(),
    state: () => usePetStore.getState(),
  };
}
