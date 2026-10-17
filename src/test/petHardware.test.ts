import { describe, expect, it } from "vitest";
import {
  classifyPetHardware,
  recommendedPetModes,
  type PetHardwareSignals,
} from "../lib/pets/hardware";

// The hardware probe picks the DEFAULT pet presets, so a wrong classification
// means either needless jank (too high) or a needlessly ugly pet (too low).
// classifyPetHardware is pure so the tiers are pinned without a real GPU.

function sig(over: Partial<PetHardwareSignals> = {}): PetHardwareSignals {
  return { renderer: "", software: false, cores: 8, memoryGb: 16, ...over };
}

describe("classifyPetHardware", () => {
  it("software rasterizers are always low", () => {
    expect(classifyPetHardware(sig({ renderer: "SwiftShader", software: true }))).toBe("low");
  });

  it("discrete GPUs are high", () => {
    expect(classifyPetHardware(sig({ renderer: "NVIDIA GeForce RTX 3080" }))).toBe("high");
    expect(classifyPetHardware(sig({ renderer: "AMD Radeon RX 6800" }))).toBe("high");
    expect(classifyPetHardware(sig({ renderer: "Apple M2 Pro" }))).toBe("high");
  });

  it("integrated GPUs are medium", () => {
    expect(classifyPetHardware(sig({ renderer: "Intel(R) UHD Graphics 620" }))).toBe("medium");
    expect(classifyPetHardware(sig({ renderer: "AMD Radeon Graphics" }))).toBe("medium");
  });

  it("unknown renderer is medium (erring safe)", () => {
    expect(classifyPetHardware(sig({ renderer: "" }))).toBe("medium");
  });

  it("few cores cap a strong GPU down", () => {
    expect(classifyPetHardware(sig({ renderer: "NVIDIA GeForce RTX 4090", cores: 4 }))).toBe("medium");
    expect(classifyPetHardware(sig({ renderer: "NVIDIA GeForce RTX 4090", cores: 2 }))).toBe("low");
  });

  it("low memory caps the tier down", () => {
    expect(classifyPetHardware(sig({ renderer: "NVIDIA RTX 3080", memoryGb: 4 }))).toBe("medium");
    expect(classifyPetHardware(sig({ renderer: "NVIDIA RTX 3080", memoryGb: 2 }))).toBe("low");
  });

  it("a weak everything lands on low", () => {
    expect(classifyPetHardware(sig({ renderer: "Intel HD Graphics", cores: 2, memoryGb: 2 }))).toBe(
      "low",
    );
  });
});

describe("recommendedPetModes", () => {
  it("rides render and lighting on the same tier", () => {
    expect(recommendedPetModes({ renderer: "", software: false, cores: 8, memoryGb: 16, tier: "high" })).toEqual(
      { render: "high", lighting: "high" },
    );
    expect(recommendedPetModes({ renderer: "", software: true, cores: 4, memoryGb: 4, tier: "low" })).toEqual(
      { render: "low", lighting: "low" },
    );
  });
});
