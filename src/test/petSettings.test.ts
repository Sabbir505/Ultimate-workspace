import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PET_LIGHTING_INTENSITY,
  PET_LIGHTING_MAX,
  PET_LIGHTING_MIN,
  useSettingsStore,
} from "../state/settings";

// Pet 3D render/lighting settings (Settings → Appearance → Bot pets). These
// feed lib/pets/stage.ts (applyPetStageSettings) → PetStage's QUALITY/LIGHTING
// presets, so the defaults + clamps are the contract the settings UI relies on.

describe("pet render + lighting settings — defaults", () => {
  it("ships auto render/lighting at 100% brightness", () => {
    const s = useSettingsStore.getState();
    expect(s.petRenderMode).toBe("auto");
    expect(s.petLightingMode).toBe("auto");
    expect(s.petLightingIntensity).toBe(DEFAULT_PET_LIGHTING_INTENSITY);
    expect(DEFAULT_PET_LIGHTING_INTENSITY).toBe(1);
  });
});

describe("pet render + lighting settings — setters", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      petRenderMode: "auto",
      petLightingMode: "auto",
      petLightingIntensity: DEFAULT_PET_LIGHTING_INTENSITY,
    });
  });

  it("accepts every preset for both render and lighting", () => {
    for (const mode of ["low", "medium", "high", "auto"] as const) {
      useSettingsStore.getState().setPetRenderMode(mode);
      useSettingsStore.getState().setPetLightingMode(mode);
      expect(useSettingsStore.getState().petRenderMode).toBe(mode);
      expect(useSettingsStore.getState().petLightingMode).toBe(mode);
    }
  });

  it("accepts an in-band brightness and clamps out-of-band values", () => {
    useSettingsStore.getState().setPetLightingIntensity(1.2);
    expect(useSettingsStore.getState().petLightingIntensity).toBe(1.2);
    useSettingsStore.getState().setPetLightingIntensity(99); // > MAX
    expect(useSettingsStore.getState().petLightingIntensity).toBe(PET_LIGHTING_MAX);
    useSettingsStore.getState().setPetLightingIntensity(0.01); // < MIN
    expect(useSettingsStore.getState().petLightingIntensity).toBe(PET_LIGHTING_MIN);
  });
});
