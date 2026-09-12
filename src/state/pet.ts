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
  | "happy" // petted
  | "zoomies" // rare sprint across the strip
  | "focus"; // opt-in focus-buddy meditation

export type PetEvent =
  | { type: "chatToken" } // built-in chat streaming
  | { type: "agentOutput" } // PTY pane producing output
  | { type: "celebrate"; source: "turn" | "automation" }
  | {
      type: "concerned";
      source: "error" | "crash" | "budget"; // budget = threshold alert, not an error
    }
  | { type: "activity" } // any sign of life — refreshes idle timers only
  | { type: "pet" } // user clicked the pet
  | { type: "zoomies" } // sprint! (combo reward / rare random)
  | { type: "wake" }; // window became visible / user returned

export interface PetStats {
  turns: number;
  automations: number;
  errors: number;
  pets: number;
  teleports: number;
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
  /** The pet's chosen spot (drag target) — strolls wander around it. */
  spotX: number;
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
  /** Epoch ms the opt-in focus session ends (0 = not focusing). */
  focusUntil: number;
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
/** Zoomies: 4× stroll speed for ~2.6s. */
export const PET_ZOOMIES_MS = 2_600;
/** Petting this many times inside the window triggers zoomies. */
export const PET_PET_COMBO = 3;
const PET_COMBO_WINDOW_MS = 4_000;
/** Opt-in focus-buddy session length. */
export const PET_FOCUS_MS = 25 * 60_000;
const BUBBLE_MS = 3600;
const BUBBLE_GAP_MS = 50_000; // min spacing between speech bubbles
const BUBBLE_CHANCE = 0.35;

const MOOD_DURATION: Partial<Record<PetMood, number>> = {
  celebrate: CELEBRATE_MS,
  concerned: CONCERNED_MS,
  happy: HAPPY_MS,
  watching: WATCH_MS,
  work: WORK_MS,
  zoomies: PET_ZOOMIES_MS,
};

/** Mood priority — higher-rank transient moods aren't downgraded by lower
 *  event streams (a celebration survives chat tokens still arriving). */
const MOOD_RANK: Record<PetMood, number> = {
  concerned: 5,
  celebrate: 4,
  happy: 3,
  focus: 3,
  work: 2,
  watching: 1,
  walk: 1,
  zoomies: 1,
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

/** Milestone badges — pure memory lane, zero pressure: they can only be
 *  earned, never lost, and nothing nags about the unearned ones. */
export interface PetMilestone {
  key: string;
  label: string;
  hint: string;
  met: (s: PetStats) => boolean;
}
export const PET_MILESTONES: PetMilestone[] = [
  { key: "globe", label: "Globetrotter", hint: "teleported once", met: (s) => s.teleports >= 1 },
  { key: "friend", label: "Best friend", hint: "petted 50 times", met: (s) => s.pets >= 50 },
  { key: "solid", label: "Unbreakable", hint: "survived 10 errors", met: (s) => s.errors >= 10 },
  { key: "crew", label: "Overnight crew", hint: "10 automation runs", met: (s) => s.automations >= 10 },
  { key: "regular", label: "Regular", hint: "25 turns together", met: (s) => s.turns >= 25 },
];

// ── Pure state machine ───────────────────────────────────────────────────────

let petReducedMotion = false;
/** Set from the hook via matchMedia — with reduced motion the pet still
 *  changes pose and mood, it just doesn't stroll. */
export function setPetReducedMotion(v: boolean): void {
  petReducedMotion = v;
}

/** Epoch ms the opt-in focus session ends (0 = none). Mirrors the store's
 *  focusUntil so the pure reducer can suppress ambient streams while the
 *  user is meditating. */
let petFocusUntil = 0;
export function setPetFocusUntil(ms: number): void {
  petFocusUntil = ms;
}

export function initialPetCore(now: number): PetCore {
  return {
    mood: "idle",
    moodUntil: 0,
    lastEventAt: now,
    facing: 1,
    x: 0.85,
    spotX: 0.85,
    targetX: null,
    nextWalkAt: now + WALK_MIN_MS,
    xp: 0,
    stats: { turns: 0, automations: 0, errors: 0, pets: 0, teleports: 0 },
  };
}

/** Reward table — XP comes from real shipping events only. */
const XP_AWARD = { turn: 6, automation: 10, error: 1, pet: 1, focus: 8 } as const;

export function reducePet(core: PetCore, event: PetEvent, now: number): PetCore {
  const next: PetCore = { ...core, lastEventAt: now };
  const active = core.moodUntil > now; // transient mood still running
  const rank = MOOD_RANK[core.mood];

  switch (event.type) {
    case "chatToken": {
      // Watching = attentive. Never pulls the pet out of a stronger mood,
      // and never breaks the focus meditation.
      if (now >= petFocusUntil && (!active || rank <= MOOD_RANK.watching)) {
        next.mood = "watching";
        next.moodUntil = now + WATCH_MS;
      }
      return next;
    }
    case "agentOutput": {
      if (now >= petFocusUntil && (!active || rank <= MOOD_RANK.work)) {
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
      // A budget alert shares the look but isn't a failure: no error count,
      // no XP.
      const isFailure = event.source === "error" || event.source === "crash";
      next.mood = "concerned";
      next.moodUntil = now + CONCERNED_MS;
      if (isFailure) {
        next.xp = core.xp + XP_AWARD.error;
        next.stats = { ...core.stats, errors: core.stats.errors + 1 };
      }
      return next;
    }
    case "zoomies": {
      // Sprint to the far side of the strip. Pure delight, no stats.
      const target = core.x < 0.5 ? 0.92 : 0.08;
      next.mood = "zoomies";
      next.moodUntil = now + PET_ZOOMIES_MS;
      next.targetX = target;
      next.facing = target > core.x ? 1 : -1;
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
  // Transient mood still running — nothing ages. Zoomies are the exception:
  // they carry a duration AND a sprint target that must keep moving.
  if (core.moodUntil > now && core.mood !== "zoomies") return core;

  const expiredTransient =
    core.mood !== "idle" &&
    core.mood !== "walk" &&
    core.mood !== "doze" &&
    !(core.mood === "zoomies" && core.moodUntil > now);
  if (expiredTransient) {
    // A transient that interrupted a stroll keeps its target — RESUME the
    // walk instead of idling with a stale target (which would deadlock the
    // stroll starter, freezing the pet mid-strip forever).
    const resumeWalk = core.targetX !== null;
    return {
      ...core,
      mood: resumeWalk ? "walk" : "idle",
      moodUntil: 0,
      nextWalkAt: resumeWalk ? core.nextWalkAt : now + WALK_MIN_MS + rng() * WALK_RANGE_MS,
    };
  }

  // Long silence → nap. Waking is handled by reducePet (any event). The
  // focus session defers naps — the pet is meditating, not idle.
  if (
    core.mood === "idle" &&
    now >= petFocusUntil &&
    now - core.lastEventAt >= PET_DOZE_AFTER_MS
  ) {
    return { ...core, mood: "doze", targetX: null };
  }

  // Stroll: wander around the pet's chosen spot. Targets favour the right
  // side — its spot is next to the paw button — but stop short enough that
  // the 48px actor box stays inside the narrow sidebar.
  if (core.mood === "idle" && core.targetX === null && !petReducedMotion && now >= core.nextWalkAt) {
    const centre = core.spotX;
    const lo = Math.max(0.4, centre - 0.12);
    const hi = Math.min(0.88, centre + 0.12);
    const target = hi > lo ? lo + rng() * (hi - lo) : centre;
    return { ...core, mood: "walk", targetX: target, moodUntil: 0 };
  }
  if ((core.mood === "walk" || core.mood === "zoomies") && core.targetX !== null) {
    const dx = core.targetX - core.x;
    const speed = core.mood === "zoomies" ? PET_WALK_SPEED * 4 : PET_WALK_SPEED;
    const step = speed * Math.max(dtSec, 0);
    if (Math.abs(dx) <= step) {
      return {
        ...core,
        x: core.targetX,
        targetX: null,
        mood: "idle",
        // Arriving from a zoomies sprint at the strip edge, head home soon —
        // settling at the far edge looks lost.
        nextWalkAt:
          core.mood === "zoomies" ? now + 2_000 + rng() * 2_000 : now + WALK_MIN_MS + rng() * WALK_RANGE_MS,
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
    focusUntil: 0,
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
      focusUntil:
        typeof parsed.focusUntil === "number" && parsed.focusUntil > Date.now() ? parsed.focusUntil : 0,
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
    const parsed = JSON.parse(raw) as { xp?: number; spotX?: number; stats?: Partial<PetStats> };
    const base = initialPetCore(Date.now());
    return {
      ...base,
      x:
        typeof parsed.spotX === "number" && parsed.spotX >= 0.03 && parsed.spotX <= 0.97
          ? parsed.spotX
          : base.x,
      spotX:
        typeof parsed.spotX === "number" && parsed.spotX >= 0.03 && parsed.spotX <= 0.97
          ? parsed.spotX
          : base.spotX,
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
        focusUntil: settings.focusUntil,
        lastSeen: settings.lastSeen,
        spotX: core.spotX,
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
   *  in-flight teleport, level-up party timestamp, drag state. Not persisted. */
  bubble: { text: string; until: number } | null;
  heartAt: number;
  lastBubbleAt: number;
  teleport: PetTeleport | null;
  nextTeleportAt: number;
  nextZoomiesAt: number;
  levelUpAt: number;
  dragging: boolean;
  /** Timestamps of recent pet clicks — the combo that triggers zoomies. */
  petTimes: number[];

  event: (e: PetEvent) => void;
  tick: (now: number, dtSec: number) => void;
  /** Move the pet to a home with the teleport animation (default: the other
   *  one). Called by the scheduler and when chat starts streaming. */
  teleportTo: (home: "sidebar" | "composer") => void;
  /** Drag session: begin clears walks, dragTo moves, end drops the pet at
   *  its new spot (persisted as its stroll home base). */
  beginDrag: () => void;
  dragTo: (x: number) => void;
  endDrag: () => void;
  /** Opt-in focus buddy: 25 minutes of meditation, then a celebration. */
  startFocus: () => void;
  stopFocus: () => void;
  /** Rare random sprint; also the pet-combo reward. */
  zoomies: () => void;
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
  nextZoomiesAt: Date.now() + 4 * 60_000 + Math.random() * 5 * 60_000,
  levelUpAt: 0,
  dragging: false,
  petTimes: [],

  event: (e) => {
    const prev = get().core;
    const core = reducePet(prev, e, Date.now());
    const patch: Partial<PetStoreState> = { core };
    // A fresh wake already had its teleport slot pass while asleep — push it
    // out so the pet doesn't vanish the moment it opens its eyes.
    if (prev.mood === "doze" && core.mood !== "doze") {
      patch.nextTeleportAt = Date.now() + 60_000;
    }
    // Level-up: a longer celebration with a confetti burst and a proud line,
    // bypassing the bubble throttle (this is rare and earned).
    if (petLevel(core.xp) > petLevel(prev.xp)) {
      const now = Date.now();
      patch.levelUpAt = now;
      patch.core = { ...core, mood: "celebrate", moodUntil: now + 9000 };
      const line = petLine(get().species, "levelup", get().name);
      if (line) queueBubble(get, set, line);
    }
    set(patch);
    // Tokens/output can stream hundreds of times a minute — only durable
    // changes (xp, counters) hit localStorage.
    if (core.xp !== prev.xp || core.stats !== prev.stats) persist(get(), core);
    if (!patch.levelUpAt) maybeBubble(get, set, e);
  },

  tick: (now, dtSec) => {
    const s0 = get();
    const patch: Partial<PetStoreState> = {};
    let changed = false;
    // While dragged, the pet is in the user's hand — time stands still.
    const core = s0.dragging ? s0.core : tickPet(s0.core, now, dtSec);
    if (core !== s0.core) {
      patch.core = core;
      changed = true;
    }
    const bubble = s0.bubble;
    if (bubble && bubble.until <= now) {
      patch.bubble = null;
      changed = true;
    }
    // Focus completion: meditate → celebrate + XP. Ambient streams can't fire
    // during focus, so the celebration is always the session's payoff.
    if (s0.focusUntil && now >= s0.focusUntil) {
      const base = patch.core ?? s0.core;
      patch.core = {
        ...base,
        mood: "celebrate",
        moodUntil: now + CELEBRATE_MS,
        xp: base.xp + XP_AWARD.focus,
      };
      patch.focusUntil = 0;
      changed = true;
      queueBubble(get, set, petLine(s0.species, "celebrate", s0.name) ?? "Focus complete!");
      persist(get(), patch.core);
    }
    // Zoomies schedule: a rare random sprint while plainly idle.
    if (!s0.dragging && now >= s0.nextZoomiesAt) {
      if (s0.core.mood === "idle") {
        const base = patch.core ?? s0.core;
        patch.core = reducePet(base, { type: "zoomies" }, now);
        patch.nextZoomiesAt = now + 4 * 60_000 + Math.random() * 6 * 60_000;
        changed = true;
      } else {
        patch.nextZoomiesAt = now + 30_000;
        changed = true;
      }
    }
    // Teleport lifecycle: clear the window when it lapses, and schedule a new
    // hop when the timer fires. Only a pet that is plainly idle teleports —
    // never mid-walk, mid-zoomies, and NEVER out of its sleep (a nap is
    // sacred).
    const teleport = s0.teleport;
    if (teleport && now >= teleport.until) {
      patch.teleport = null;
      changed = true;
    }
    if (!teleport && now >= s0.nextTeleportAt) {
      if (patch.core ? patch.core.mood === "idle" : s0.core.mood === "idle") {
        const to = s0.home === "sidebar" ? "composer" : "sidebar";
        const base = patch.core ?? s0.core;
        patch.home = to;
        patch.teleport = { from: s0.home, until: now + PET_TELEPORT_MS };
        patch.nextTeleportAt = now + 120_000 + Math.random() * 120_000;
        patch.core = {
          ...base,
          stats: { ...base.stats, teleports: base.stats.teleports + 1 },
        };
        changed = true;
        persist({ ...s0, home: to }, patch.core);
      } else {
        // busy, walking or asleep — try again shortly
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
      core: {
        ...s.core,
        stats: { ...s.core.stats, teleports: s.core.stats.teleports + 1 },
      },
      teleport: { from: s.home, until: now + PET_TELEPORT_MS },
      nextTeleportAt: now + 120_000 + Math.random() * 120_000,
    });
    persist(get(), get().core);
  },

  beginDrag: () => {
    const s = get();
    if (!s.dragging) {
      set({
        dragging: true,
        core: { ...s.core, mood: "idle", moodUntil: 0, targetX: null },
      });
    }
  },
  dragTo: (x) => {
    const s = get();
    if (!s.dragging) return;
    const clamped = Math.min(0.97, Math.max(0.03, x));
    set({ core: { ...s.core, x: clamped } });
  },
  endDrag: () => {
    const s = get();
    if (!s.dragging) return;
    set({ dragging: false, core: { ...s.core, spotX: s.core.x } });
    persist(get(), get().core);
  },

  startFocus: () => {
    const until = Date.now() + PET_FOCUS_MS;
    set({
      focusUntil: until,
      core: { ...get().core, mood: "focus", moodUntil: until, targetX: null },
      nextTeleportAt: until + 60_000, // no relocating a meditating pet
    });
    setPetFocusUntil(until);
    persist(get(), get().core);
  },
  stopFocus: () => {
    set({
      focusUntil: 0,
      core: { ...get().core, mood: "idle", moodUntil: 0 },
    });
    setPetFocusUntil(0);
    persist(get(), get().core);
  },

  zoomies: () => {
    get().event({ type: "zoomies" });
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
    const now = Date.now();
    get().event({ type: "pet" });
    set({ heartAt: now });
    // Combo reward: PET_PET_COMBO pets inside the window → zoomies.
    const times = [...get().petTimes, now]
      .filter((t) => now - t <= PET_COMBO_WINDOW_MS)
      .slice(-PET_PET_COMBO);
    set({ petTimes: times });
    if (times.length >= PET_PET_COMBO) {
      set({ petTimes: [] });
      get().zoomies();
    }
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

setPetFocusUntil(usePetStore.getState().focusUntil);

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
    budget: () => usePetStore.getState().event({ type: "concerned", source: "budget" }),
    zoomies: () => usePetStore.getState().zoomies(),
    focus: () => usePetStore.getState().startFocus(),
    unfocus: () => usePetStore.getState().stopFocus(),
    teleport: () => usePetStore.getState().teleportTo(
      usePetStore.getState().home === "sidebar" ? "composer" : "sidebar",
    ),
    addXp: (n: number) => {
      const s = usePetStore.getState();
      usePetStore.setState({ core: { ...s.core, xp: s.core.xp + n } });
      persist(s, { ...s.core, xp: s.core.xp + n });
    },
    debug: (mood: PetMood) => usePetStore.getState().debugForceMood(mood),
    pet: () => usePetStore.getState().petThePet(),
    state: () => usePetStore.getState(),
  };
}
