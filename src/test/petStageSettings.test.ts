// usePetStageSettings → applyPetStageSettings → PetStage wiring. The settings
// store is the source of truth; stage.ts must (a) remember choices made before
// any pet exists and seed the stage with them at creation, and (b) push later
// changes into the live stage.
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  ctorOpts: vi.fn(),
  setQuality: vi.fn(),
  setLighting: vi.fn(),
}));

vi.mock("../lib/pets/adePets", () => {
  class PetStage {
    constructor(opts: unknown) {
      spies.ctorOpts(opts);
    }
    add() {
      return { setState() {}, setFacing() {}, remove: vi.fn() };
    }
    start() {}
    stop() {}
    clear() {}
    dispose() {}
    setQuality(q: string) {
      spies.setQuality(q);
    }
    setLighting(mode: string, intensity: number) {
      spies.setLighting(mode, intensity);
    }
  }
  return { PetStage };
});

function fakeWebgl() {
  // Stub on the prototype (not a per-call createElement spy): webglAvailable
  // probes a fresh canvas, and a nested spy-on-a-spy is fragile across tests.
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
}

describe("pet stage settings wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const s of Object.values(spies)) s.mockClear();
    fakeWebgl();
  });

  it("seeds a stage created after the settings were applied", async () => {
    const { applyPetStageSettings, mountPet } = await import("../lib/pets/stage");
    applyPetStageSettings({ quality: "high", lighting: "low", lightingIntensity: 1.4 });

    const host = document.createElement("div");
    document.body.appendChild(host);
    await mountPet(host, "panda", "idle");

    expect(spies.ctorOpts).toHaveBeenCalledWith(
      expect.objectContaining({ quality: "high", lighting: "low", lightingIntensity: 1.4 }),
    );
  });

  it("pushes later changes into the live stage", async () => {
    const { applyPetStageSettings, mountPet } = await import("../lib/pets/stage");
    const host = document.createElement("div");
    document.body.appendChild(host);
    await mountPet(host, "panda", "idle");
    expect(spies.ctorOpts).toHaveBeenCalled();

    applyPetStageSettings({ quality: "medium", lighting: "high", lightingIntensity: 0.8 });

    expect(spies.setQuality).toHaveBeenCalledWith("medium");
    expect(spies.setLighting).toHaveBeenCalledWith("high", 0.8);
  });
});
