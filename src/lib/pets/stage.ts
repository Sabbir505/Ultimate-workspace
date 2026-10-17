// The shared 3D pet stage (src/lib/pets/adePets.ts).
//
// ONE WebGL context serves every pet on screen: the stage owns a fixed,
// click-through canvas covering the viewport, and each pet is drawn into the
// rectangle of the DOM element that "hosts" it (the composer dock slot, the
// sidebar dock slot, a rail avatar, an editor preview). That is why the pets
// can dock anywhere without a canvas per slot — and why they cost nothing when
// scrolled out of view.
//
// Everything here degrades quietly:
//   * three.js + the engine are imported DYNAMICALLY, so they stay out of the
//     entry chunk and are only paid for once a pet actually mounts;
//   * when WebGL is unavailable (jsdom, a machine without GPU support) the
//     acquire() call resolves to null and callers render their CSS fallback.
//
// Only one stage exists per webview (the engine is built for that); it starts
// on the first mount and stops when the last pet unmounts.

import type { PetKind, PetState, QualityMode, LightingMode } from "./adePets";

export type { PetKind, PetState, QualityMode, LightingMode };

export interface PetHandle {
  setState(state: PetState): void;
  /** Face +1 (right) / -1 (left). Lets a caller that moves the pet itself (the
   *  docked bot pets, which locomote via DOM) keep it facing its walk. */
  setFacing(facing: 1 | -1): void;
  remove(): void;
}

type StageLike = {
  add(kind: string, opts: { element: HTMLElement; state?: string }): {
    setState(s: string): void;
    setFacing?(f: number): void;
    remove(): void;
  };
  start(): void;
  stop(): void;
  /** Wipe the last frame. stop() only halts the loop — the canvas keeps the
   *  last render, and this canvas is FIXED over the whole app, so without a
   *  clear the pets that just unmounted stay frozen over the next view. */
  clear?(): void;
  dispose(): void;
  setQuality?(q: string): void;
  setLighting?(mode: string, intensity: number): void;
};

let stage: StageLike | null = null;
let loading: Promise<StageLike | null> | null = null;
let mounted = 0;
let canvas: HTMLCanvasElement | null = null;

/** True when this webview can render WebGL at all. Cheap, sync, and used by
 *  the components to decide which fallback to draw. */
export function webglAvailable(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    return Boolean(
      probe.getContext("webgl2") ||
        probe.getContext("webgl") ||
        probe.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}

/** Desired stage settings, read from the settings store by `usePetStageSettings`
 *  and applied here. They live at module scope so a stage created LATER (the
 *  first pet mount) starts with the user's choices, and so a settings change
 *  before any pet exists is remembered.
 *  - quality `auto` lets the engine's governor step down when frames get slow.
 *  - lighting `auto` tracks the (possibly governed) quality level. */
let petQuality: QualityMode = "auto";
let petLighting: LightingMode = "auto";
let petLightingIntensity = 1;

/** Push the user's pet render/lighting settings into the stage (if it exists
 *  yet). Called from `usePetStageSettings` on mount and whenever they change. */
export function applyPetStageSettings(settings: {
  quality: QualityMode;
  lighting: LightingMode;
  lightingIntensity: number;
}): void {
  petQuality = settings.quality;
  petLighting = settings.lighting;
  petLightingIntensity = settings.lightingIntensity > 0 ? settings.lightingIntensity : 1;
  if (stage) {
    stage.setQuality?.(petQuality);
    stage.setLighting?.(petLighting, petLightingIntensity);
  }
}

function ensureCanvas(): HTMLCanvasElement {
  if (canvas && canvas.isConnected) return canvas;
  const c = document.createElement("canvas");
  c.setAttribute("aria-hidden", "true");
  c.className = "pet-stage-canvas";
  // The stage draws into scissor rectangles of this canvas; it must cover the
  // viewport, never intercept clicks, and sit above the chat surface but BELOW
  // modals / popovers / the command palette.
  c.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:38;";
  document.body.appendChild(c);
  canvas = c;
  return c;
}

async function getStage(): Promise<StageLike | null> {
  if (stage) return stage;
  if (loading) return loading;
  if (!webglAvailable()) return null;
  loading = (async () => {
    try {
      const mod = await import("./adePets");
      const c = ensureCanvas();
      const s = new mod.PetStage({
        canvas: c,
        quality: petQuality,
        lighting: petLighting,
        lightingIntensity: petLightingIntensity,
        fps: 30,
      }) as unknown as StageLike;
      stage = s;
      return s;
    } catch (e) {
      console.warn("[pets] 3D stage unavailable", e);
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * Mount one pet into `element`'s rectangle. Resolves to a handle, or to null
 * when 3D is unavailable — callers must tolerate null (they draw a fallback).
 */
export async function mountPet(
  element: HTMLElement,
  kind: PetKind,
  state: PetState = "idle",
): Promise<PetHandle | null> {
  const s = await getStage();
  if (!s || !element.isConnected) return null;
  try {
    const pet = s.add(kind, { element, state });
    mounted += 1;
    s.start();
    let removed = false;
    return {
      setState(next: PetState) {
        if (!removed) pet.setState(next);
      },
      setFacing(facing: 1 | -1) {
        if (!removed) pet.setFacing?.(facing);
      },
      remove() {
        if (removed) return;
        removed = true;
        try {
          pet.remove();
        } catch {
          /* the stage may be disposing concurrently */
        }
        mounted = Math.max(0, mounted - 1);
        if (mounted === 0) {
          // Keep the GL context (a dock that unmounts and remounts on every
          // view switch must not pay for a new one) but stop the frame loop —
          // and WIPE the last frame. The canvas is fixed over the whole app
          // and only the frame loop clears it, so a bare stop() left the just-
          // unmounted pets frozen on top of whatever view came next (the
          // "pets bleeding into the vault / wiki / bots views" report).
          s.stop();
          s.clear?.();
        }
      },
    };
  } catch (e) {
    console.warn("[pets] could not mount a pet", e);
    return null;
  }
}

/** Stop rendering without tearing down the context (window hidden). */
export function pausePets(): void {
  stage?.stop();
}

export function resumePets(): void {
  if (mounted > 0) stage?.start();
}

/** A self-owned stage for an in-panel live preview (Settings → Bot pets).
 *  Unlike the app-wide shared stage, this one owns its canvas and lives INSIDE
 *  the settings panel, so the panel's backdrop-filter blur (which sits above
 *  the global canvas at z-index 38) can't smear it. Transient — dispose() on
 *  unmount. */
export interface PetPreview {
  /** Mount one pet into `element`'s rectangle (same scissor model as the app). */
  add(kind: PetKind, element: HTMLElement): void;
  setQuality(quality: QualityMode): void;
  setLighting(mode: LightingMode, intensity: number): void;
  dispose(): void;
}

/** Build an isolated preview stage over `canvas`. Resolves to null when WebGL
 *  is unavailable (the caller then shows a flat fallback). */
export async function createPetPreview(canvas: HTMLCanvasElement): Promise<PetPreview | null> {
  if (!webglAvailable()) return null;
  try {
    const mod = await import("./adePets");
    const s = new mod.PetStage({
      canvas,
      quality: petQuality,
      lighting: petLighting,
      lightingIntensity: petLightingIntensity,
      fps: 30,
    }) as unknown as StageLike;
    s.start();
    return {
      add(kind, element) {
        try {
          s.add(kind, { element });
        } catch (e) {
          console.warn("[pets] could not mount a preview pet", e);
        }
      },
      setQuality(quality) {
        s.setQuality?.(quality);
      },
      setLighting(mode, intensity) {
        s.setLighting?.(mode, intensity);
      },
      dispose() {
        try {
          // false = leave the shared fur materials / textures alone; the
          // app-wide stage still uses them.
          (s as unknown as { dispose(shared?: boolean): void }).dispose(false);
        } catch {
          /* already gone */
        }
      },
    };
  } catch (e) {
    console.warn("[pets] preview stage unavailable", e);
    return null;
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pausePets();
    else resumePets();
  });
}
