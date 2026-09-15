// Companion pet homes: the pet lives in ONE home at a time (sidebar or one
// open chat pane's composer strip). Panes publish their ids via setPetHomes;
// the scheduler teleports to a RANDOM other existing home, and a pet whose
// home pane closed is relocated instantly (the vanished strip can't play the
// dissolve animation).
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
  it("publishes the pane list and keeps a still-existing home", () => {
    usePetStore.getState().setPetHomes(["sidebar", "main", "pane-2"]);
    const s = usePetStore.getState();
    expect(s.homes).toEqual(["sidebar", "main", "pane-2"]);
    expect(s.home).toBe("sidebar"); // untouched — still exists
  });

  it("relocates instantly when the pet's home pane closes", () => {
    usePetStore.setState({ home: "pane-2", homes: ["sidebar", "main", "pane-2"] });
    // pane-2 closed:
    usePetStore.getState().setPetHomes(["sidebar", "main"]);
    const s = usePetStore.getState();
    expect(s.homes).toEqual(["sidebar", "main"]);
    expect(s.homes).toContain(s.home); // relocated into the surviving set
    expect(s.teleport).toBeNull(); // no dissolve — the old strip is gone
  });

  it("teleports to a random OTHER existing home", () => {
    usePetStore.getState().setPetHomes(["sidebar", "main", "pane-2"]);
    usePetStore.setState({ home: "sidebar" });
    usePetStore.getState().teleportToRandomOther();
    let s = usePetStore.getState();
    expect(s.home).not.toBe("sidebar");
    expect(["main", "pane-2"]).toContain(s.home);
    expect(s.teleport).not.toBeNull(); // dissolve/materialise window is live

    // Repeated hops always land on an existing home.
    for (let i = 0; i < 6; i++) {
      usePetStore.getState().teleportToRandomOther();
      s = usePetStore.getState();
      expect(s.homes).toContain(s.home);
    }
  });

  it("falls back to the default home set when no homes are published", () => {
    usePetStore.setState({ homes: [], home: "nowhere" });
    usePetStore.getState().setPetHomes([]);
    const s = usePetStore.getState();
    expect(s.homes).toEqual(["sidebar", "main"]);
    expect(s.homes).toContain(s.home);
  });
});
