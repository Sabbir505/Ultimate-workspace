// Companion pet homes: the pet lives in ONE home at a time (sidebar or one
// rendered chat composer's strip). Strips register on mount/unmount via
// registerPetStrip; the scheduler teleports to a RANDOM other MOUNTED home,
// and a pet whose home strip unmounted is relocated instantly (the vanished
// strip can't play the dissolve animation).
import { beforeEach, describe, expect, it } from "vitest";
import { usePetStore } from "../state/pet";

beforeEach(() => {
  localStorage.clear();
  usePetStore.setState({
    enabled: true,
    home: "sidebar",
    homes: ["sidebar", "main"],
    teleport: null,
    nextTeleportAt: Date.now() + 60_000,
  });
});

describe("pet homes", () => {
  it("registers a mounted strip and keeps an existing pet home", () => {
    usePetStore.getState().registerPetStrip("pane-2", true);
    const s = usePetStore.getState();
    expect(s.homes).toEqual(["sidebar", "main", "pane-2"]);
    expect(s.home).toBe("sidebar"); // untouched — still mounted
  });

  it("relocates instantly when the pet's home strip unmounts", () => {
    usePetStore.setState({ home: "pane-2", homes: ["sidebar", "main", "pane-2"] });
    // pane-2's strip unmounted (pane closed / view switched):
    usePetStore.getState().registerPetStrip("pane-2", false);
    const s = usePetStore.getState();
    expect(s.homes).toEqual(["sidebar", "main"]);
    expect(s.homes).toContain(s.home); // relocated into the surviving set
    expect(s.teleport).toBeNull(); // no dissolve — the old strip is gone
  });

  it("teleports to a random OTHER mounted home", () => {
    usePetStore.getState().registerPetStrip("pane-2", true);
    usePetStore.setState({ home: "sidebar" });
    usePetStore.getState().teleportToRandomOther();
    let s = usePetStore.getState();
    expect(s.home).not.toBe("sidebar");
    expect(["main", "pane-2"]).toContain(s.home);
    expect(s.teleport).not.toBeNull(); // dissolve/materialise window is live

    // Repeated hops always land on a mounted home.
    for (let i = 0; i < 6; i++) {
      usePetStore.getState().teleportToRandomOther();
      s = usePetStore.getState();
      expect(s.homes).toContain(s.home);
    }
  });

  it("relocates a stale persisted home when the first strip mounts", () => {
    // A previous run's split left "pane-3" persisted as the pet's home; on
    // boot only the sidebar strip mounts. The pet must move there instead of
    // rendering nowhere.
    usePetStore.setState({ homes: [], home: "pane-3" });
    usePetStore.getState().registerPetStrip("sidebar", true);
    const s = usePetStore.getState();
    expect(s.homes).toEqual(["sidebar"]);
    expect(s.home).toBe("sidebar");
    expect(s.teleport).toBeNull();
  });

  it("never teleports to an unmounted home — no candidates reschedules", () => {
    usePetStore.setState({ homes: ["sidebar"], home: "sidebar", nextTeleportAt: Date.now() - 1 });
    usePetStore.getState().tick(Date.now(), 0.016);
    const s = usePetStore.getState();
    expect(s.home).toBe("sidebar");
    expect(s.teleport).toBeNull();
    expect(s.nextTeleportAt).toBeGreaterThan(Date.now()); // rescheduled
  });
});
