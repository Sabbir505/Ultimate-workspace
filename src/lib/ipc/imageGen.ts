// Local image generation (Settings → Local Models → Images): the
// stable-diffusion.cpp sd-server sidecar + its GGUF model catalog, plus
// detection of manually-placed models already in the models folder. Backend
// contract: src-tauri/src/commands/image_gen.rs.
import { safeInvoke, safeListen } from "../ipcCore";

export type ImageModelRole = "diffusion" | "text-encoder" | "vae";
/** "full" = self-contained checkpoint (SD1.5/SDXL, loaded via -m);
 *  "split" = diffusion model + separate text encoder + VAE files. */
export type ImageLayout = "full" | "split";

export interface ImageCatalogEntry {
  id: string;
  label: string;
  /** Package the entry belongs to ("z-image-turbo", "sd15"): diffusion plus
   *  the encoder/VAE it needs, installable/activatable as ONE choice. */
  family: string;
  role: ImageModelRole;
  layout: ImageLayout;
  filename: string;
  downloadUrl: string;
  sizeBytes: number;
  note: string;
  recommended: boolean;
  installed: boolean;
  /** Only meaningful for role === "diffusion". */
  isDefault: boolean;
}

/** One component of a package plan: activate the file already on disk
 *  ("use" — `reused` = from a copy outside the managed dir, i.e. shared with
 *  another package or dropped by hand) or queue its download. Diffusion
 *  VARIANTS carry `selected` (the quant the plan will install). */
export interface FamilyEntryPlan {
  id: string;
  label: string;
  role: ImageModelRole;
  action: "use" | "download";
  path: string | null;
  reused: boolean;
  sizeBytes: number;
  selected: boolean;
}

export interface FamilyPlan {
  family: string;
  label: string;
  layout: ImageLayout;
  /** The chosen diffusion quant (catalog id). */
  diffusionId: string;
  diffusionPath: string | null;
  /** ALL diffusion quants of the family (the variant picker). */
  variants: FamilyEntryPlan[];
  /** Shared components (encoder, VAE) the picked diffusion needs. */
  deps: FamilyEntryPlan[];
  /** Every component active — the card shows ✓ Active instead of a button. */
  active: boolean;
}

/** A manually-placed model file found in the models folder (not part of the
 *  catalog). `path` is models-root-relative with forward slashes — the
 *  identity used by the role/layout assignment commands. */
export interface DetectedImageFile {
  path: string;
  name: string;
  sizeBytes: number;
  role: ImageModelRole;
  /** For diffusion-role files: "full" | "split". */
  layout: ImageLayout | null;
  /** True when the role came from the user's assignment, not the guess. */
  assigned: boolean;
}

export interface ImageGenStatus {
  running: boolean;
  port: number | null;
  /** Models-root-relative path of the loaded diffusion model. */
  diffusionPath: string | null;
  /** Resolved sd-server binary for the current device, when found. */
  binaryPath: string | null;
  /** "auto" | "vulkan" | "cpu". */
  device: string;
  cudaAvailable: boolean;
  vulkanAvailable: boolean;
  cpuAvailable: boolean;
  defaultModel: string | null;
  defaultLayout: string;
  imageDir: string | null;
  catalog: ImageCatalogEntry[];
  /** Every split model's dependencies resolve (encoder + VAE found). */
  dependenciesReady: boolean;
  /** Effective text encoder / VAE (group selection, else the catalog file),
   *  as models-root-relative paths — what a split model actually loads. */
  encoderPath: string | null;
  vaePath: string | null;
  detected: DetectedImageFile[];
}

/** One generated image: a data URI for preview, plus the on-disk path when
 *  the caller asked for one (the chat tool saves into the session artifacts;
 *  the settings "try it" box does not). */
export interface GeneratedImage {
  dataUri: string;
  path: string | null;
  width: number;
  height: number;
}

export const imageGenStatus = () => safeInvoke<ImageGenStatus>("image_gen_status");
export const imageGenStart = () => safeInvoke<ImageGenStatus>("image_gen_start");
export const imageGenStop = () => safeInvoke<void>("image_gen_stop");
/** One-click install/update of a pinned stable-diffusion.cpp build. `device`:
 *  "cuda" (NVIDIA, ~892MB with its CUDA runtime bundle), "vulkan"
 *  (AMD/Intel, ~32MB), or "cpu" (~17MB). Progress arrives under the matching
 *  ServerBuildsCard id ("image-sd-cuda" / "image-sd-vulkan" / "image-sd-cpu"). */
export const imageGenInstall = (device: string, force = false) =>
  safeInvoke<ImageGenStatus>("image_gen_install", { device, force });
/** Set the default diffusion model. `path` is models-root-relative with
 *  forward slashes (catalog downloads live under `image-gen/`); `layout`
 *  must match the file ("full" = self-contained checkpoint). */
export const imageGenSetDefault = (path: string, layout: ImageLayout) =>
  safeInvoke<void>("image_gen_set_default", { path, layout });
/** Assign (or clear with null) a detected file's role. */
export const imageGenSetFileRole = (path: string, role: ImageModelRole | null) =>
  safeInvoke<void>("image_gen_set_file_role", { path, role });
/** Override a detected diffusion file's layout (or clear with null). */
export const imageGenSetFileLayout = (path: string, layout: ImageLayout | null) =>
  safeInvoke<void>("image_gen_set_file_layout", { path, layout });
/** Pick which file a dependency group uses ("text-encoder" / "vae"), or clear
 *  with null → automatic (the catalog file). The diffusion group selects via
 *  imageGenSetDefault. */
export const imageGenSelect = (kind: "text-encoder" | "vae", path: string | null) =>
  safeInvoke<void>("image_gen_select", { kind, path });
/** Activate a package (diffusion + text encoder + VAE) as one choice: every
 *  component already on disk — anywhere in the models folder — is selected,
 *  only genuinely missing files start downloading. Returns the plan that was
 *  applied so the panel can say what was reused vs downloaded. */
export const imageGenUseFamily = (family: string, diffusionId?: string) =>
  safeInvoke<FamilyPlan>("image_gen_use_family", { family, diffusionId: diffusionId ?? null });
/** Read-only plans for every package — what the cards display before you
 *  click Use (which components get reused vs downloaded, which quant). */
export const imageGenFamilyPlans = () =>
  safeInvoke<FamilyPlan[]>("image_gen_family_plans");
export const imageGenSetDevice = (device: string) =>
  safeInvoke<void>("image_gen_set_device", { device });
export const imageGenSetServerPath = (path: string | null) =>
  safeInvoke<void>("image_gen_set_server_path", { path });
/** Generate one image against the RUNNING sidecar (settings "try it" box;
 *  chat generation goes through the generate_image tool, which lazy-starts). */
export const imageGenerate = (prompt: string, width?: number, height?: number) =>
  safeInvoke<GeneratedImage>("image_generate", {
    prompt,
    width: width ?? null,
    height: height ?? null,
  });

/** Live generation-lifecycle push (chat composer-area card): fires on lazy
 *  start, render progress (step counts parsed from the server log), the
 *  finished image, and failures. Backend: image_gen.rs emit_update.
 *  `owner` — the chat session id the render belongs to, set only on the
 *  chat-tool path; ownerless events are attributed to whichever pane claims
 *  them first. */
export interface ImageGenUpdate {
  phase: "starting" | "rendering" | "done" | "error";
  owner?: string;
  step?: number;
  total?: number;
  width?: number;
  height?: number;
  path?: string;
  dataUri?: string;
  error?: string;
}

export const onImageGenUpdate = (handler: (u: ImageGenUpdate) => void) =>
  safeListen<ImageGenUpdate>("image-gen:update", handler);
