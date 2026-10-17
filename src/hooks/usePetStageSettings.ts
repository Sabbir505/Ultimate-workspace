// Applies the user's pet render/lighting settings (Settings → Appearance →
// Bot pets) to the shared 3D pet stage. The stage lives in lib/pets/stage.ts
// and may not exist yet (it starts on the first pet mount), so
// applyPetStageSettings also remembers the desired values for a later stage.
//
// Mounted once at the app shell (App.tsx) alongside the other global settings
// hooks, so a change reaches the stage immediately regardless of which view or
// dock a pet is currently drawn in.
import { useEffect } from "react";
import { useSettingsStore } from "../state/settings";
import { applyPetStageSettings } from "../lib/pets/stage";

export function usePetStageSettings(): void {
  const quality = useSettingsStore((s) => s.petRenderMode);
  const lighting = useSettingsStore((s) => s.petLightingMode);
  const lightingIntensity = useSettingsStore((s) => s.petLightingIntensity);

  useEffect(() => {
    applyPetStageSettings({ quality, lighting, lightingIntensity });
  }, [quality, lighting, lightingIntensity]);
}
