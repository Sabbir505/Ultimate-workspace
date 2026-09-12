// Pet state-machine tests — the mood reducer and tick loop are the whole
// pet brain, so they carry the test weight: transitions, priorities,
// cooldowns, dozing, strolls, XP/levels/hat unlocks, persistence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  initialPetCore,
  levelThreshold,
  petLevel,
  PET_DOZE_AFTER_MS,
  PET_MILESTONES,
  PET_WALK_SPEED,
  reducePet,
  setPetReducedMotion,
  tickPet,
  unlockedHats,
  usePetStore,
  type PetCore,
} from "./pet";

const T0 = 1_000_000;
const CELEBRATE_TEST_MS = 4_000;

function core(overrides: Partial<PetCore> = {}): PetCore {
  return { ...initialPetCore(T0), ...overrides };
}

/** Deterministic rng: walks always pick 0.5, always the same delays. */
const fixedRng = () => 0.5;

describe("reducePet", () => {
  it("goes watching on chat tokens and refreshes the cooldown", () => {
    const a = reducePet(core(), { type: "chatToken" }, T0);
    expect(a.mood).toBe("watching");
    expect(a.moodUntil).toBe(T0 + 2500);
    const b = reducePet(a, { type: "chatToken" }, T0 + 1000);
    expect(b.mood).toBe("watching");
    expect(b.moodUntil).toBe(T0 + 3500);
  });

  it("goes to work on agent output and clears any stroll target", () => {
    const a = reducePet(core({ mood: "walk", targetX: 0.4 }), { type: "agentOutput" }, T0);
    expect(a.mood).toBe("work");
    expect(a.targetX).toBeNull();
  });

  it("celebrates and awards XP per source", () => {
    const turn = reducePet(core(), { type: "celebrate", source: "turn" }, T0);
    expect(turn.mood).toBe("celebrate");
    expect(turn.xp).toBe(6);
    expect(turn.stats.turns).toBe(1);
    const auto = reducePet(core({ xp: 6 }), { type: "celebrate", source: "automation" }, T0);
    expect(auto.xp).toBe(16);
    expect(auto.stats.automations).toBe(1);
  });

  it("concerned outranks an in-flight celebration", () => {
    const celebrating = reducePet(core(), { type: "celebrate", source: "turn" }, T0);
    const crashed = reducePet(celebrating, { type: "concerned", source: "crash" }, T0 + 100);
    expect(crashed.mood).toBe("concerned");
    expect(crashed.stats.errors).toBe(1);
  });

  it("chat tokens do not downgrade celebrate/concerned/work", () => {
    const celebrating = reducePet(core(), { type: "celebrate", source: "turn" }, T0);
    expect(reducePet(celebrating, { type: "chatToken" }, T0 + 100).mood).toBe("celebrate");
    const working = reducePet(core(), { type: "agentOutput" }, T0);
    expect(reducePet(working, { type: "chatToken" }, T0 + 100).mood).toBe("work");
  });

  it("lower-priority work yields to a newer watching mood only when expired", () => {
    const watching = reducePet(core(), { type: "chatToken" }, T0);
    // work outranks watching even while the watch cooldown runs
    expect(reducePet(watching, { type: "agentOutput" }, T0 + 100).mood).toBe("work");
  });

  it("petting makes the pet happy and counts it", () => {
    const petted = reducePet(core(), { type: "pet" }, T0);
    expect(petted.mood).toBe("happy");
    expect(petted.stats.pets).toBe(1);
    expect(petted.xp).toBe(1);
  });

  it("petting always shows the happy mood, even mid-celebration or concern", () => {
    const celebrating = reducePet(core(), { type: "celebrate", source: "turn" }, T0);
    expect(reducePet(celebrating, { type: "pet" }, T0 + 100).mood).toBe("happy");
    const concerned = reducePet(core(), { type: "concerned", source: "error" }, T0);
    expect(reducePet(concerned, { type: "pet" }, T0 + 100).mood).toBe("happy");
  });

  it("any event wakes a dozing pet", () => {
    const asleep = core({ mood: "doze", lastEventAt: T0 - PET_DOZE_AFTER_MS * 2 });
    expect(reducePet(asleep, { type: "activity" }, T0).mood).toBe("idle");
    expect(reducePet(asleep, { type: "chatToken" }, T0).mood).toBe("watching");
  });

  it("tracks lastEventAt for every event", () => {
    const a = reducePet(core(), { type: "activity" }, T0 + 555);
    expect(a.lastEventAt).toBe(T0 + 555);
  });
});

describe("tickPet", () => {
  it("holds a transient mood until it expires, then returns to idle", () => {
    const watching = reducePet(core(), { type: "chatToken" }, T0);
    expect(tickPet(watching, T0 + 1000, 1, fixedRng).mood).toBe("watching");
    const expired = tickPet(watching, T0 + 2600, 1, fixedRng);
    expect(expired.mood).toBe("idle");
    expect(expired.moodUntil).toBe(0);
  });

  it("naps after the doze timeout with no events", () => {
    // next stroll scheduled far out so the pet is plainly idle
    const idle = core({ lastEventAt: T0, nextWalkAt: T0 + 10 * 60_000 });
    const before = tickPet(idle, T0 + PET_DOZE_AFTER_MS - 1, 1, fixedRng);
    expect(before.mood).toBe("idle");
    const asleep = tickPet(idle, T0 + PET_DOZE_AFTER_MS, 1, fixedRng);
    expect(asleep.mood).toBe("doze");
  });

  it("strolls when idle: picks a target, walks, arrives, goes idle", () => {
    const idle = core({ nextWalkAt: T0 });
    const start = tickPet(idle, T0 + 1, 0.016, fixedRng);
    expect(start.mood).toBe("walk");
    // fixedRng 0.5 → stroll wanders around the spot (0.85): midpoint 0.805
    expect(start.targetX).toBeCloseTo(0.805, 5);

    // walking right: x advances by speed*dt each tick toward the target
    let c = start;
    let now = T0 + 1;
    for (let i = 0; i < 200 && c.mood === "walk"; i++) {
      now += 100;
      c = tickPet(c, now, 0.1, fixedRng);
    }
    expect(c.mood).toBe("idle");
    expect(c.x).toBeCloseTo(0.805, 5);
    expect(c.targetX).toBeNull();
    // target 0.805 < start x 0.85 — the pet walked left
    expect(c.facing).toBe(-1);
  });

  it("walks left when the target is behind, flipping facing", () => {
    const strolling = core({ mood: "walk", x: 0.9, targetX: 0.2, nextWalkAt: T0 });
    const stepped = tickPet(strolling, T0 + 16, 0.1, fixedRng);
    expect(stepped.facing).toBe(-1);
    expect(stepped.x).toBeLessThan(0.9);
  });

  it("respects the walk speed constant", () => {
    const strolling = core({ mood: "walk", x: 0.5, targetX: 1, nextWalkAt: T0 });
    const stepped = tickPet(strolling, T0 + 1000, 1, fixedRng);
    expect(stepped.x).toBeCloseTo(0.5 + PET_WALK_SPEED, 6);
  });

  it("never strolls with reduced motion (poses still change via events)", () => {
    setPetReducedMotion(true);
    try {
      const idle = core({ nextWalkAt: T0 - 1000 });
      expect(tickPet(idle, T0, 0.016, fixedRng).mood).toBe("idle");
    } finally {
      setPetReducedMotion(false);
    }
  });

  it("resumes an interrupted stroll after a transient expires (no deadlock)", () => {
    // strolling toward a target when a celebration interrupts mid-walk
    const walking = core({ mood: "walk", x: 0.5, targetX: 0.8, nextWalkAt: T0 });
    const celebrated = reducePet(walking, { type: "celebrate", source: "turn" }, T0 + 10);
    expect(celebrated.targetX).toBe(0.8);
    // celebration expires — the stroll must RESUME, not freeze mid-strip
    const expired = tickPet(celebrated, T0 + 10 + CELEBRATE_TEST_MS, 0.016, fixedRng);
    expect(expired.mood).toBe("walk");
    expect(expired.targetX).toBe(0.8);
    // and it still arrives
    let c = expired;
    let now = T0 + 10 + CELEBRATE_TEST_MS;
    for (let i = 0; i < 200 && c.mood === "walk"; i++) {
      now += 100;
      c = tickPet(c, now, 0.1, fixedRng);
    }
    expect(c.mood).toBe("idle");
    expect(c.x).toBeCloseTo(0.8, 5);
  });

  it("does not nap while walking", () => {
    const strolling = core({
      mood: "walk",
      x: 0.5,
      targetX: 0.2,
      lastEventAt: T0 - PET_DOZE_AFTER_MS * 3,
    });
    expect(tickPet(strolling, T0 + 100, 0.1, fixedRng).mood).toBe("walk");
  });
});

describe("zoomies", () => {
  it("runs at 4× stroll speed toward the far side of the strip", () => {
    const z = reducePet(core({ x: 0.3 }), { type: "zoomies" }, T0);
    expect(z.mood).toBe("zoomies");
    expect(z.targetX).toBe(0.92);
    expect(z.facing).toBe(1);
    const stepped = tickPet(z, T0 + 100, 0.1, fixedRng);
    expect(stepped.x).toBeCloseTo(0.3 + PET_WALK_SPEED * 4 * 0.1, 6);
  });

  it("fires from the store when a pet combo completes, and resets the combo", () => {
    const store = usePetStore.getState();
    store.petThePet();
    store.petThePet();
    usePetStore.getState().petThePet();
    expect(usePetStore.getState().core.mood).toBe("zoomies");
    expect(usePetStore.getState().petTimes).toHaveLength(0);
  });
});

describe("focus buddy", () => {
  it("meditates: ambient streams don't break focus", () => {
    usePetStore.getState().startFocus();
    const focused = usePetStore.getState();
    expect(focused.core.mood).toBe("focus");
    focused.event({ type: "chatToken" });
    focused.event({ type: "agentOutput" });
    expect(usePetStore.getState().core.mood).toBe("focus");
    // …but a real celebration breaks through
    focused.event({ type: "celebrate", source: "turn" });
    expect(usePetStore.getState().core.mood).toBe("celebrate");
    usePetStore.getState().stopFocus();
  });

  it("pays off with a celebration + XP when the session completes", () => {
    const before = usePetStore.getState().core.xp;
    usePetStore.getState().startFocus();
    usePetStore.setState({ focusUntil: Date.now() - 1 });
    usePetStore.getState().tick(Date.now(), 0.016);
    const after = usePetStore.getState();
    expect(after.focusUntil).toBe(0);
    expect(after.core.mood).toBe("celebrate");
    expect(after.core.xp).toBe(before + 8);
  });
});

describe("drag", () => {
  it("moves the pet within bounds and remembers the new spot", () => {
    usePetStore.getState().beginDrag();
    expect(usePetStore.getState().dragging).toBe(true);
    usePetStore.getState().dragTo(2);
    expect(usePetStore.getState().core.x).toBeLessThanOrEqual(0.97);
    usePetStore.getState().dragTo(0.3);
    usePetStore.getState().endDrag();
    const s = usePetStore.getState();
    expect(s.dragging).toBe(false);
    expect(s.core.spotX).toBeCloseTo(0.3, 5);
    expect(JSON.parse(localStorage.getItem("relay.pet.v1") ?? "{}").spotX).toBeCloseTo(0.3, 5);
  });

  it("strolls stay near the pet's spot", () => {
    usePetStore.setState({ core: { ...usePetStore.getState().core, spotX: 0.5, nextWalkAt: T0 } });
    const started = tickPet(usePetStore.getState().core, T0 + 1, 0.016, fixedRng);
    // fixedRng 0.5 → 0.4 + 0.5 * 0.22 = 0.51 — right around the spot
    expect(started.targetX).toBeCloseTo(0.51, 5);
  });
});

describe("budget concern", () => {
  it("worries about budget alerts without counting them as errors", () => {
    const before = usePetStore.getState().core.stats.errors;
    usePetStore.getState().event({ type: "concerned", source: "budget" });
    const s = usePetStore.getState();
    expect(s.core.mood).toBe("concerned");
    expect(s.core.stats.errors).toBe(before);
  });
});

describe("level-up party", () => {
  it("extends the celebration and marks the burst on a level crossing", () => {
    usePetStore.setState({ core: { ...usePetStore.getState().core, xp: 45 } });
    usePetStore.getState().event({ type: "celebrate", source: "turn" });
    const s = usePetStore.getState();
    expect(s.core.xp).toBe(51);
    expect(petLevel(s.core.xp)).toBe(2);
    expect(s.levelUpAt).toBeGreaterThan(0);
    expect(s.core.moodUntil).toBeGreaterThan(Date.now() + 8000);
  });
});

describe("teleport stat", () => {
  it("counts scheduled and requested teleports", () => {
    usePetStore.setState({
      core: {
        ...usePetStore.getState().core,
        mood: "idle",
        moodUntil: 0,
        nextWalkAt: Date.now() + 999_000, // keep the stroll from racing the hop
      },
      nextTeleportAt: Date.now() - 1,
    });
    usePetStore.getState().tick(Date.now(), 0.016);
    expect(usePetStore.getState().core.stats.teleports).toBe(1);
    usePetStore.setState({ nextTeleportAt: Date.now() + 999_000, teleport: null });
    usePetStore.getState().teleportTo("sidebar");
    expect(usePetStore.getState().core.stats.teleports).toBe(2);
  });
});

describe("milestones", () => {
  it("unlock from stats and never un-earn", () => {
    const stats = { turns: 25, automations: 10, errors: 10, pets: 50, teleports: 1 };
    for (const m of PET_MILESTONES) expect(m.met(stats)).toBe(true);
    const fresh = { turns: 0, automations: 0, errors: 0, pets: 0, teleports: 0 };
    for (const m of PET_MILESTONES) expect(m.met(fresh)).toBe(false);
  });
});

describe("progression", () => {
  it("level thresholds and levels agree", () => {
    expect(levelThreshold(1)).toBe(0);
    expect(levelThreshold(2)).toBe(50);
    expect(levelThreshold(3)).toBe(125);
    expect(petLevel(0)).toBe(1);
    expect(petLevel(49)).toBe(1);
    expect(petLevel(50)).toBe(2);
    expect(petLevel(124)).toBe(2);
    expect(petLevel(125)).toBe(3);
  });

  it("unlocks hats in order with level", () => {
    expect(unlockedHats(0)).toEqual([]);
    expect(unlockedHats(50)).toEqual(["party"]);
    expect(unlockedHats(125)).toEqual(["party", "headphones"]);
    expect(unlockedHats(225)).toEqual(["party", "headphones", "wizard"]);
    expect(unlockedHats(350)).toEqual(["party", "headphones", "wizard", "crown"]);
  });
});

describe("store", () => {
  beforeEach(() => {
    localStorage.clear();
    usePetStore.getState().forgetAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists identity, settings, xp and stats", () => {
    usePetStore.getState().setSpecies("axolotl");
    usePetStore.getState().setName("Bloop Jr");
    usePetStore.getState().event({ type: "celebrate", source: "automation" });

    const raw = JSON.parse(localStorage.getItem("relay.pet.v1") ?? "{}");
    expect(raw.species).toBe("axolotl");
    expect(raw.name).toBe("Bloop Jr");
    expect(raw.xp).toBe(10);
    expect(raw.stats.automations).toBe(1);
    expect(raw.home).toBe("sidebar");
  });

  it("teleports to the other home when the schedule fires while calm", () => {
    const s = usePetStore.getState();
    expect(s.home).toBe("sidebar");
    usePetStore.setState({ nextTeleportAt: Date.now() - 1 });
    usePetStore.getState().tick(Date.now(), 0.016);
    const after = usePetStore.getState();
    expect(after.home).toBe("composer");
    expect(after.teleport).not.toBeNull();
    expect(after.teleport?.from).toBe("sidebar");
  });

  it("never teleports a sleeping pet — the nap is sacred", () => {
    usePetStore.setState({
      nextTeleportAt: Date.now() - 1,
      core: { ...usePetStore.getState().core, mood: "doze", lastEventAt: Date.now() - PET_DOZE_AFTER_MS * 2 },
    });
    usePetStore.getState().tick(Date.now(), 0.016);
    const after = usePetStore.getState();
    expect(after.home).toBe("sidebar");
    expect(after.teleport).toBeNull();
    // and it doesn't teleport the instant it wakes, either
    after.event({ type: "activity" });
    const awake = usePetStore.getState();
    expect(awake.core.mood).toBe("idle");
    expect(awake.teleport).toBeNull();
    expect(awake.nextTeleportAt).toBeGreaterThan(Date.now());
  });

  it("waits when busy — no teleport mid-work", () => {
    usePetStore.setState({
      nextTeleportAt: Date.now() - 1,
      core: { ...usePetStore.getState().core, mood: "work", moodUntil: Date.now() + 5000 },
    });
    usePetStore.getState().tick(Date.now(), 0.016);
    const after = usePetStore.getState();
    expect(after.home).toBe("sidebar");
    expect(after.teleport).toBeNull();
    expect(after.nextTeleportAt).toBeGreaterThan(Date.now());
  });

  it("teleportTo moves the pet immediately with an animation window", () => {
    usePetStore.getState().teleportTo("composer");
    const s = usePetStore.getState();
    expect(s.home).toBe("composer");
    expect(s.teleport?.from).toBe("sidebar");
    // no-op when already there
    usePetStore.getState().teleportTo("composer");
    expect(usePetStore.getState().teleport?.from).toBe("sidebar");
  });

  it("morningReport speaks only after a long absence with unseen news", () => {
    const s = usePetStore.getState();
    s.showBubble("");
    // fresh lastSeen → no morning line
    expect(usePetStore.getState().morningReport(true)).toBeNull();

    // age the last-seen stamp past 6h
    usePetStore.setState({ lastSeen: Date.now() - 7 * 60 * 60_000 });
    const line = usePetStore.getState().morningReport(true);
    expect(line).toBeTruthy();
    // seen news → silent
    usePetStore.setState({ lastSeen: Date.now() - 7 * 60 * 60_000 });
    expect(usePetStore.getState().morningReport(false)).toBeNull();
  });

  it("setHat refuses locked hats", () => {
    usePetStore.getState().setHat("crown");
    expect(usePetStore.getState().hat).toBeNull();
    usePetStore.setState({ core: { ...usePetStore.getState().core, xp: 350 } });
    usePetStore.getState().setHat("crown");
    expect(usePetStore.getState().hat).toBe("crown");
  });
});
