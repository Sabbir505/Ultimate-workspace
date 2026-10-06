// The Images panel's "Recommended" pack tag: a manually-downloaded pack's
// components (diffusion + text encoder + VAE) share a folder under the
// models root, so picking the diffusion highlights its siblings.
// samePackDir is the matcher — covered here directly.
import { describe, expect, it } from "vitest";
import { samePackDir } from "../components/settings/ImageGenPanel";

describe("samePackDir", () => {
  it("matches files that share a pack folder (incl. subfolder layouts)", () => {
    // The qwen-image-2.1 manual pack: turbo/ diffusion, pack-root encoder,
    // vae/ VAE — all under one common folder.
    expect(
      samePackDir(
        "qwen-image-2.1/turbo/qwen_image_2.1_turbo_Q5_K_M.gguf",
        "qwen-image-2.1/Qwen3VL-8B-Instruct-Q4_K_M.gguf",
      ),
    ).toBe(true);
    expect(
      samePackDir(
        "qwen-image-2.1/vae/qwen_image_2.1_vae_bf16.safetensors",
        "qwen-image-2.1/turbo/qwen_image_2.1_turbo_Q5_K_M.gguf",
      ),
    ).toBe(true);
    // Everything dropped loose into one folder.
    expect(samePackDir("pack/model.gguf", "pack/model.vae.safetensors")).toBe(true);
  });

  it("does not match unrelated folders or root-level files", () => {
    expect(
      samePackDir(
        "image-gen/z_image_turbo-Q4_0.gguf",
        "qwen-image-2.1/Qwen3VL-8B-Instruct-Q4_K_M.gguf",
      ),
    ).toBe(false);
    expect(samePackDir("loose.gguf", "other/loose.gguf")).toBe(false);
  });

  it("normalizes backslashes (windows paths from the backend)", () => {
    expect(
      samePackDir("qwen-image-2.1\\turbo\\x.gguf", "qwen-image-2.1/vae/y.safetensors"),
    ).toBe(true);
  });
});
