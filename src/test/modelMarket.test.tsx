// Model Market redesign: hero fit badges, "Fits my hardware" filter,
// slimmed card tags, collapsed download-settings disclosure, and the detail
// modal's stat strip + per-quant fit rows.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelMarket } from "../components/settings/ModelMarket";
import type { CatalogEntry, FetchCatalogResult } from "../lib/ipc";

const fetchCatalogMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  getMarketSettings: vi.fn().mockResolvedValue({
    modelsDir: "D:\\local models\\models",
    defaultModelsDir: "D:\\local models\\models",
    hasHuggingFaceToken: false,
  }),
  fetchModelCatalog: (...a: unknown[]) => fetchCatalogMock(...a),
  getGpuVram: vi.fn().mockResolvedValue(null),
  onModelDownloadProgress: vi.fn().mockResolvedValue(() => {}),
  startModelDownload: vi.fn().mockResolvedValue(undefined),
  cancelModelDownload: vi.fn().mockResolvedValue(undefined),
  pickModelsDirectory: vi.fn(),
  setModelsDirectory: vi.fn(),
  setHuggingFaceToken: vi.fn(),
  clearHuggingFaceToken: vi.fn(),
  downloadMmproj: vi.fn(),
  toastError: vi.fn(),
}));

function entry(partial: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: `${partial.repoId ?? "a/b"}::${partial.filename ?? "m.gguf"}`,
    displayName: partial.repoId?.split("/").slice(1).join("/") ?? "model",
    author: "a",
    repoId: "a/b",
    filename: "m.gguf",
    downloads: 1000,
    likes: 100,
    lastModified: null,
    sizeBytes: 4 * 1024 * 1024 * 1024,
    description: null,
    tags: [],
    sha256: null,
    downloadUrl: "https://example/x",
    vision: false,
    paramsLabel: null,
    quantization: null,
    license: null,
    gated: false,
    ...partial,
  };
}

const CATALOG: FetchCatalogResult = {
  stale: false,
  hasHuggingFaceToken: false,
  entries: [
    entry({
      repoId: "small/tiny",
      displayName: "tiny",
      filename: "tiny-q4.gguf",
      sizeBytes: 3 * 1024 * 1024 * 1024,
      quantization: "Q4_K_M",
      paramsLabel: "7B",
      license: "mit",
      tags: ["text-generation", "transformers", "arxiv:2401.00000", "gguf"],
    }),
    entry({
      repoId: "huge/whale",
      displayName: "whale",
      filename: "whale-q4.gguf",
      sizeBytes: 20 * 1024 * 1024 * 1024,
      quantization: "Q4_K_M",
      tags: [],
    }),
  ],
};

describe("ModelMarket redesign", () => {
  afterEach(() => cleanup());

  it("renders hero fit badges and slimmed tags on cards", async () => {
    fetchCatalogMock.mockResolvedValue(CATALOG);
    const { container } = render(<ModelMarket onDownloadComplete={() => {}} />);
    await waitFor(() => expect(screen.getByText("tiny")).toBeTruthy());
    const badges = container.querySelectorAll(".fit-badge");
    expect(badges.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".fit-badge.fits")).toBeTruthy();
    expect(container.querySelector(".fit-badge.too_large")).toBeTruthy();
    // Provenance tags no longer clutter cards…
    expect(screen.queryByText("transformers")).toBeNull();
    expect(screen.queryByText(/Based on/)).toBeNull();
    // …but survive into the detail modal's strip.
    fireEvent.click(screen.getByText("tiny"));
    await waitFor(() => expect(screen.getAllByText("transformers").length).toBeGreaterThan(0));
    expect(screen.queryByText(/arxiv:/)).toBeNull();
  });

  it("filters out oversized repos via the Fits-my-hardware sort option", async () => {
    fetchCatalogMock.mockResolvedValue(CATALOG);
    const { container } = render(<ModelMarket onDownloadComplete={() => {}} />);
    await waitFor(() => expect(screen.getByText("whale")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "fits" } });
    await waitFor(() => expect(screen.queryByText("whale")).toBeNull());
    expect(screen.getByText("tiny")).toBeTruthy();
    void container;
  });

  it("collapses download settings into a disclosure and shows quant fit rows in the modal", async () => {
    fetchCatalogMock.mockResolvedValue(CATALOG);
    const { container } = render(
      <ModelMarket
        onDownloadComplete={() => {}}
        localModels={[{ filename: "tiny-q4.gguf" }]}
      />,
    );
    await waitFor(() => expect(screen.getByText("tiny")).toBeTruthy());
    // Disclosure summary shows the destination; the token row lives inside
    // the collapsed body (jsdom keeps it in the DOM, so assert on <details>).
    expect(screen.getByText(/Downloads → D:\\local models\\models/)).toBeTruthy();
    const disclosure = container.querySelector("details.model-market-settings");
    expect(disclosure).toBeTruthy();
    expect(disclosure!.hasAttribute("open")).toBe(false);
    expect(disclosure!.querySelector(".model-market-settings-body")).toBeTruthy();
    // Already-downloaded repo shows the ready state instead of Download.
    expect(screen.getByText(/Already downloaded/)).toBeTruthy();
    // Modal: stat strip pairs + per-quant rows with fit dots. The modal
    // portals to document.body, so query there rather than `container`.
    fireEvent.click(screen.getByText("tiny"));
    await waitFor(() =>
      expect(document.body.querySelectorAll(".model-detail-pair").length).toBeGreaterThan(2),
    );
    expect(document.body.querySelectorAll(".model-detail-quant-row").length).toBe(0); // single quant → no selector
  });
});
