// VRAM-aware market recommendations (roadmap #11): ModelCard shows a
//  "✓ Recommended" badge when a model's loaded memory requirement fits a
//  discrete GPU's VRAM with headroom, and a VRAM-aware fit label otherwise.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ModelCard } from "../components/settings/ModelMarket";

// ModelCard is exported; render it directly with a known entry + VRAM.
const entry = {
  id: "repo-1",
  displayName: "Test Model",
  author: "someone",
  repoId: "someone/model",
  filename: "model-Q4_K_M.gguf",
  downloads: 100,
  likes: 5,
  lastModified: null,
  // 3 GB file → ~3.36 GB loaded requirement.
  sizeBytes: 3 * 1024 * 1024 * 1024,
  description: "a test model",
  tags: ["gguf", "text-generation"],
  sha256: null,
  downloadUrl: "https://example.com/x.gguf",
  vision: false,
  paramsLabel: "7B",
  quantization: "Q4_K_M",
  license: null,
  gated: false,
};

function noopEntry(): typeof entry {
  return { ...entry };
}

describe("ModelCard VRAM recommendation", () => {
  afterEach(cleanup);

  function renderCard(cfg: { vramBytes?: number | null; gpuName?: string | null }) {
    // Populate module-private helpers via the badge output (size 3GB → req 3.36GB).
    // 8 GB VRAM: fits + <0.7 headroom (3.36/8 = 0.42 → Recommended).
    const vram = cfg.vramBytes === undefined ? 8 * 1024 * 1024 * 1024 : cfg.vramBytes;
    return render(
      <ModelCard
        entry={noopEntry()}
        download={undefined}
        totalRam={128 * 1024 * 1024 * 1024}
        vramBytes={vram}
        gpuName={cfg.gpuName === undefined ? "NVIDIA RTX 4070" : cfg.gpuName}
        isDownloaded={false}
        availableQuants={[]}
        onAction={vi.fn()}
      />,
    );
  }

  it("shows a Recommended badge when the model fits VRAM with headroom", () => {
    renderCard({});
    // 3.36 GB / 8 GB = 42% → "fits" + recommended.
    expect(screen.getByText(/✓ Recommended/)).toBeTruthy();
    expect(screen.getByText(/Fits/)).toBeTruthy();
  });

  it("does NOT recommend when there is no discrete GPU (VRAM null)", () => {
    renderCard({ vramBytes: null, gpuName: null });
    expect(screen.queryByText(/✓ Recommended/)).toBeNull();
    // Falls back to RAM fit: 3 GB vs 128 GB RAM → Fits.
    expect(screen.getByText(/Fits/)).toBeTruthy();
  });

  it("shows Too large against a small VRAM budget", () => {
    // 2 GB VRAM → 3.36 required / 2 = 1.68 → too_large.
    renderCard({ vramBytes: 2 * 1024 * 1024 * 1024, gpuName: "Small GPU" });
    expect(screen.getByText(/Too large/)).toBeTruthy();
    expect(screen.queryByText(/✓ Recommended/)).toBeNull();
  });
});
