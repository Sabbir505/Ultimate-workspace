// Hardware probe for the 3D pets (Settings → Appearance → Bot pets).
//
// The pets are the app's only WebGL surface, so a machine that can't push them
// smoothly should start on a cheaper preset instead of discovering that through
// dropped frames. This reads the GPU (via the WebGL renderer string), CPU core
// count and device memory, and classifies the machine into low / medium / high.
//
// Pure classifier + a cached, side-effecting probe so the settings UI and the
// settings store share ONE detection (and one throwaway GL context). JSDOM and
// GPU-less machines get the safe `medium`/`low` outcome — never a crash.

/** The three tunable render tiers (a subset of the settings' PetMode). */
export type PetTier = "low" | "medium" | "high";

export interface PetHardwareSignals {
  /** Raw or friendly GPU renderer string ("" when unknown). */
  renderer: string;
  /** True for software rasterizers (SwiftShader/llvmpipe) — always slow. */
  software: boolean;
  /** navigator.hardwareConcurrency (0 when unknown). */
  cores: number;
  /** navigator.deviceMemory in GB (null when the browser doesn't expose it). */
  memoryGb: number | null;
}

export interface PetHardwareProfile extends PetHardwareSignals {
  tier: PetTier;
}

const TIER_RANK: Record<PetTier, number> = { low: 0, medium: 1, high: 2 };
function lowerTier(a: PetTier, b: PetTier): PetTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

/**
 * Classify a machine from its signals. Pure so it is unit-testable without a
 * real GPU. Errs toward the SAFE tier when a signal is ambiguous.
 */
export function classifyPetHardware(s: PetHardwareSignals): PetTier {
  const r = s.renderer.toLowerCase();
  let tier: PetTier = "medium";

  if (s.software) {
    tier = "low";
  } else if (/(rtx|geforce|radeon rx|radeon pro|quadro|arc a\d|apple m\d)/.test(r)) {
    // Discreet GPU / Apple Silicon.
    tier = "high";
  } else if (/(intel|iris|uhd|hd graphics|radeon graphics|vega|mali|adreno)/.test(r)) {
    // Integrated or mobile GPU.
    tier = "medium";
  }

  // CPU + memory can only pull the tier DOWN — a weak CPU starves any GPU, and
  // the frame loop runs on the main thread.
  if (s.cores > 0 && s.cores <= 4) tier = lowerTier(tier, "medium");
  if (s.cores > 0 && s.cores <= 2) tier = "low";
  if (s.memoryGb != null && s.memoryGb <= 4) tier = lowerTier(tier, "medium");
  if (s.memoryGb != null && s.memoryGb <= 2) tier = "low";

  return tier;
}

/** The render + lighting presets recommended for a profile. */
export function recommendedPetModes(p: PetHardwareProfile): { render: PetTier; lighting: PetTier } {
  // Lighting rides the same tier: a low-end machine can't afford the full
  // environment + rim pass any more than it can afford the resolution.
  return { render: p.tier, lighting: p.tier };
}

function friendlyRenderer(raw: string): string {
  if (!raw) return "";
  // Common ANGLE wrapper: "ANGLE (VENDOR, DEVICE Direct3D11 vs_5_0 ps_5_0, D3D11)".
  const angle = raw.match(/ANGLE \(([^,]+),\s*([^,]+)/i);
  let name = angle ? angle[2] : raw;
  name = name
    .replace(/^ANGLE Metal Renderer:\s*/i, "")
    .replace(/\s+(Direct3D|D3D|OpenGL|Vulkan|Metal|vs_\S+|ps_\S+).*$/i, "")
    .replace(/\s*\(0x[0-9A-F]+\)/i, "")
    .trim();
  return name;
}

let cached: PetHardwareProfile | null = null;

/** Probe the machine once (cached). Safe to call from the renderer only. */
export function detectPetHardware(): PetHardwareProfile {
  if (cached) return cached;

  let rawRenderer = "";
  let software = false;
  try {
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      const gl = (canvas.getContext("webgl2") ||
        canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
      if (gl) {
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        if (dbg) {
          rawRenderer = String(
            gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ??
              gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) ??
              "",
          );
        } else {
          rawRenderer = String(gl.getParameter(gl.RENDERER) ?? "");
        }
        // Don't strand a GL context just to read a string.
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    }
  } catch {
    /* no WebGL / blocked — classify from CPU + memory alone */
  }

  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 0;
  const memoryGb =
    typeof navigator !== "undefined" &&
    typeof (navigator as unknown as { deviceMemory?: number }).deviceMemory === "number"
      ? ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null)
      : null;

  const lower = rawRenderer.toLowerCase();
  software = /swiftshader|llvmpipe|software|microsoft basic|mesa offscreen/.test(lower);

  const signals: PetHardwareSignals = {
    renderer: friendlyRenderer(rawRenderer),
    software,
    cores,
    memoryGb,
  };
  cached = { ...signals, tier: classifyPetHardware(signals) };
  return cached;
}
