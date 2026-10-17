// A live 3D preview of the six bot companions (Settings → Appearance → Bot
// pets). Instead of flat emoji chips, the real pets render here so quality and
// lighting can be compared as you change them.
//
// Why a DEDICATED stage rather than the app-wide one (lib/pets/stage.ts): the
// global pet canvas is fixed at z-index 38, BELOW this settings modal (z-40)
// whose `.view-panel` carries backdrop-filter: blur(24px) — a pet drawn on the
// global canvas would sit behind the glass and smear. This stage owns a canvas
// that lives INSIDE the panel, so it composites crisply on top of the frosted
// background. It is transient (disposed on unmount) and, unlike the global
// stage, does not free the shared fur materials/textures it borrows.
import { useEffect, useRef, useState } from "react";
import { BOT_PETS } from "../../lib/ipc/bots";
import { createPetPreview, type PetPreview } from "../../lib/pets/stage";
import { useSettingsStore } from "../../state/settings";
import { PetAvatar } from "./PetAvatar";

export function PetPreviewGrid() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<PetPreview | null>(null);
  // No WebGL (jsdom, a GPU-less machine): fall back to the flat chips so the
  // section still shows what the six companions look like.
  const [fallback, setFallback] = useState(false);

  const quality = useSettingsStore((s) => s.petRenderMode);
  const lighting = useSettingsStore((s) => s.petLightingMode);
  const lightingIntensity = useSettingsStore((s) => s.petLightingIntensity);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    let disposed = false;
    void createPetPreview(canvas).then((stage) => {
      if (disposed) {
        stage?.dispose();
        return;
      }
      if (!stage) {
        setFallback(true);
        return;
      }
      stageRef.current = stage;
      // Mount each species into its own cell rect (the stage scissors the pet
      // into that element's box).
      wrap.querySelectorAll<HTMLElement>("[data-pet-slot]").forEach((el) => {
        const kind = el.dataset.petSlot;
        if (kind) stage.add(kind as (typeof BOT_PETS)[number], el);
      });
    });
    return () => {
      disposed = true;
      stageRef.current?.dispose();
      stageRef.current = null;
    };
  }, []);

  // Live-apply quality + lighting while the user drags the controls.
  useEffect(() => {
    stageRef.current?.setQuality(quality);
    stageRef.current?.setLighting(lighting, lightingIntensity);
  }, [quality, lighting, lightingIntensity]);

  return (
    <div className={"pet-preview-grid" + (fallback ? " is-flat" : "")} ref={wrapRef}>
      {!fallback && <canvas ref={canvasRef} className="pet-preview-canvas" aria-hidden="true" />}
      {BOT_PETS.map((species) => (
        <figure key={species} className="pet-preview-cell">
          {fallback ? (
            <PetAvatar species={species} size={48} flat />
          ) : (
            // No aria-hidden: the 3D engine skips hosts marked aria-hidden
            // (that guard keeps pets out of hidden panels), so hiding this
            // would blank the preview.
            <span className="pet-preview-slot" data-pet-slot={species} />
          )}
          <figcaption>{species}</figcaption>
        </figure>
      ))}
    </div>
  );
}
