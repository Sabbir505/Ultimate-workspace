// The pet canvas is FIXED over the whole app and only the frame loop clears
// it. `stop()` alone left the last frame painted, so the pets that just
// unmounted stayed frozen over the next view ("pets bleeding into the vault /
// wiki / bots views"). Unmounting the last pet must both stop AND clear.
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  add: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../lib/pets/adePets", () => {
  class PetStage {
    add() {
      spies.add();
      return { setState() {}, setFacing() {}, remove: vi.fn() };
    }
    start() {
      spies.start();
    }
    stop() {
      spies.stop();
    }
    clear() {
      spies.clear();
    }
    dispose() {
      spies.dispose();
    }
  }
  return { PetStage };
});

describe("pet stage: clear when the last pet unmounts", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const s of Object.values(spies)) s.mockClear();
    // Pretend WebGL exists so getStage() builds the (mocked) stage.
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = orig(tag);
      if (tag === "canvas") Object.defineProperty(el, "getContext", { value: () => ({}) });
      return el;
    }) as never);
  });

  it("clears the fixed canvas after stopping", async () => {
    const { mountPet } = await import("../lib/pets/stage");
    const host = document.createElement("div");
    document.body.appendChild(host);

    const handle = await mountPet(host, "panda", "idle");
    expect(handle).toBeTruthy();
    expect(spies.start).toHaveBeenCalled();

    handle!.remove();
    expect(spies.stop).toHaveBeenCalled();
    expect(spies.clear).toHaveBeenCalled();
  });
});
