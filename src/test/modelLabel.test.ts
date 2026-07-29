import { describe, expect, it } from "vitest";
import { shortModelName } from "../lib/modelLabel";

// The label is display-only and derived deterministically from the model id,
// so the same id must render the same short name in every chat (consistency
// when switching sessions) while the full id stays the value stored on the
// session / passed to start_local_model.

describe("shortModelName", () => {
  it("strips a trailing quant tag and .gguf extension", () => {
    expect(shortModelName("Llama-3-8B-Instruct-Q4_K_M.gguf")).toBe("Llama-3-8B-Instruct");
    expect(shortModelName("Qwen2.5-7B-Instruct-Q4_K_M.gguf")).toBe("Qwen2.5-7B-Instruct");
  });

  it("strips a quant tag from a metadata-style name with no extension", () => {
    expect(shortModelName("Qwen2.5-7B-Instruct-Q4_K_M")).toBe("Qwen2.5-7B-Instruct");
    expect(shortModelName("Llama 3 8B Instruct Q8_0")).toBe("Llama 3 8B Instruct");
  });

  it("handles the IQ4_XS / Q5_K_S / Q3_K_L variants", () => {
    expect(shortModelName("model-IQ4_XS.gguf")).toBe("model");
    expect(shortModelName("model-Q5_K_S")).toBe("model");
    expect(shortModelName("model-Q3_K_L.gguf")).toBe("model");
  });

  it("drops a trailing GGUF publisher marker", () => {
    // Release names that append "-GGUF" after the quant tag are common on HF.
    expect(shortModelName("Phi-3-mini-4k-instruct-Q8_0-GGUF")).toBe("Phi-3-mini-4k-instruct");
    expect(shortModelName("Phi-3-mini-4k-instruct-Q8_0 GGUF")).toBe("Phi-3-mini-4k-instruct");
  });

  it("leaves a model with no known quant tag intact (apart from .gguf)", () => {
    expect(shortModelName("my-custom-model.gguf")).toBe("my-custom-model");
    expect(shortModelName("my-custom-model")).toBe("my-custom-model");
  });

  it("is consistent: the same id yields the same label every time", () => {
    const id = "Llama-3-8B-Instruct-Q4_K_M.gguf";
    expect(shortModelName(id)).toBe(shortModelName(id));
    // And a session that stored this id renders the same label regardless of
    // which chat is viewing it (the helper is pure over the id).
    expect(shortModelName(id)).toBe("Llama-3-8B-Instruct");
  });

  it("preserves the base name when a quant-like substring appears mid-name", () => {
    // Q6_K here is the *param* layer name, not a trailing quant — but since it
    // isn't trailing, the name is left alone.
    expect(shortModelName("Q6_K-vision-preview")).toBe("Q6_K-vision-preview");
  });

  it("handles empty input", () => {
    expect(shortModelName("")).toBe("");
  });
});
