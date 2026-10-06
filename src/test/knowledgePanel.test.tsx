// Settings → Knowledge panel states, driven through mocked IPC
// (docs_* commands + the docs:index:progress listener). Covers the no-model
// CTA, corpus list rendering (counts + enabled toggle), an in-flight index's
// progress bar, and the Remove flow. Also exercises the deep-link: the panel
// renders `.empty-reserved` before any corpus is added.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KnowledgePanel } from "../components/settings/KnowledgePanel";
import type {
  DocCorpus,
  DocsEmbeddingStatus,
  DocsIndexProgressPayload,
  EmbeddingModelEntry,
} from "../lib/ipc";

const docsEmbeddingStatusMock = vi.fn();
const docsListCorporaMock = vi.fn();
const docsAddCorpusMock = vi.fn();
const docsRemoveCorpusMock = vi.fn();
const docsSetCorpusEnabledMock = vi.fn();
const docsStartIndexMock = vi.fn();
const docsCancelIndexMock = vi.fn();
const docsListEmbeddingModelsMock = vi.fn();
const docsSetEmbeddingModelMock = vi.fn();
const onDocsIndexProgressMock = vi.fn();
const onDocsCorpusUpdatedMock = vi.fn();
const openMock = vi.fn();
const getSettingMock = vi.fn();
const setSettingMock = vi.fn();
const docsStartRerankerMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openMock(...a),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/ipc", () => ({
  docsEmbeddingStatus: (...a: unknown[]) => docsEmbeddingStatusMock(...a),
  docsListCorpora: (...a: unknown[]) => docsListCorporaMock(...a),
  docsAddCorpus: (...a: unknown[]) => docsAddCorpusMock(...a),
  docsRemoveCorpus: (...a: unknown[]) => docsRemoveCorpusMock(...a),
  docsSetCorpusEnabled: (...a: unknown[]) => docsSetCorpusEnabledMock(...a),
  docsStartIndex: (...a: unknown[]) => docsStartIndexMock(...a),
  docsCancelIndex: (...a: unknown[]) => docsCancelIndexMock(...a),
  // Embedding-model picker (docs_list_embedding_models + the persisted choice).
  docsListEmbeddingModels: (...a: unknown[]) => docsListEmbeddingModelsMock(...a),
  docsSetEmbeddingModel: (...a: unknown[]) => docsSetEmbeddingModelMock(...a),
  DOCS_EMBEDDING_MODEL_SETTING: "docs.embedding_model",
  onDocsIndexProgress: (...a: unknown[]) => onDocsIndexProgressMock(...a),
  onDocsCorpusUpdated: (...a: unknown[]) => onDocsCorpusUpdatedMock(...a),
  // Reranker row (docs.rerank toggle + sidecar warm-up).
  getSetting: (...a: unknown[]) => getSettingMock(...a),
  setSetting: (...a: unknown[]) => setSettingMock(...a),
  docsStartReranker: (...a: unknown[]) => docsStartRerankerMock(...a),
  fetchModelCatalog: vi.fn().mockResolvedValue(null),
  fetchModelFileSizes: vi.fn().mockResolvedValue(null),
  getGpuVram: vi.fn().mockResolvedValue(null),
  onModelDownloadProgress: vi.fn().mockResolvedValue(() => {}),
  startModelDownload: vi.fn().mockResolvedValue(undefined),
  cancelModelDownload: vi.fn().mockResolvedValue(undefined),
  // STT section (curated whisper.cpp models + sidecar status).
  sttStatus: vi.fn().mockResolvedValue(null),
  sttStart: vi.fn().mockResolvedValue(null),
  sttStop: vi.fn().mockResolvedValue(undefined),
  sttSetDefault: vi.fn().mockResolvedValue(undefined),
  sttSetAutoStart: vi.fn().mockResolvedValue(undefined),
  sttSetServerPath: vi.fn().mockResolvedValue(undefined),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

// The panel opens the IN-APP confirm (state/confirm.ts) before removing —
// there is no window.confirm anymore (this webview rejects it). Tests drive
// the store directly: settle(true) accepts, settle(false) denies.
import { useConfirmStore } from "../state/confirm";

const corpus = (over: Partial<DocCorpus> = {}): DocCorpus => ({
  id: "corp-1",
  name: "my-notes",
  path: "C:/Users/me/notes",
  enabled: true,
  createdAt: 1,
  lastIndexedAt: 1_700_000_000,
  fileCount: 12,
  chunkCount: 40,
  ...over,
});

const sidecar = (over: Partial<DocsEmbeddingStatus> = {}): DocsEmbeddingStatus => ({
  modelPath: "C:/models/nomic-embed-text-v1.5.Q8_0.gguf",
  running: false,
  baseUrl: null,
  ...over,
});

const embedModel = (over: Partial<EmbeddingModelEntry> = {}): EmbeddingModelEntry => ({
  path: "C:/models/nomic-embed-text-v1.5.Q8_0.gguf",
  filename: "nomic-embed-text-v1.5.Q8_0.gguf",
  family: "nomic-embed-text-v1.5",
  quantization: "Q8_0",
  sizeBytes: 84_000_000,
  architecture: "nomic-bert",
  modifiedMs: 1_700_000_000,
  ...over,
});

async function renderWithDefaults(list: DocCorpus[] | null, status: DocsEmbeddingStatus | null) {
  docsEmbeddingStatusMock.mockResolvedValue(status);
  docsListCorporaMock.mockResolvedValue(list);
  render(<KnowledgePanel />);
  // Both fetches resolve async; wait for the component's initial state effect.
  await waitFor(() => {
    expect(docsListCorporaMock).toHaveBeenCalled();
    expect(docsEmbeddingStatusMock).toHaveBeenCalled();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSettingMock.mockResolvedValue(null);
  setSettingMock.mockResolvedValue(undefined);
  docsListEmbeddingModelsMock.mockResolvedValue([]);
  docsSetEmbeddingModelMock.mockResolvedValue(null);
  docsStartRerankerMock.mockResolvedValue(false);
  onDocsIndexProgressMock.mockImplementation(() => Promise.resolve(vi.fn()));
  onDocsCorpusUpdatedMock.mockImplementation(() => Promise.resolve(vi.fn()));
  // Fresh confirm state per test (module-global store).
  useConfirmStore.setState({ current: null });
});

afterEach(() => {
  cleanup();
});

describe("KnowledgePanel", () => {
  it("shows the empty state CTA when no corpora exist yet", async () => {
    await renderWithDefaults(null, sidecar());
    expect(screen.getByText(/no corpora yet/i)).toBeTruthy();
    // A model installed but never sidecar-running should show the status note.
    expect(screen.getByText(/will start on next index/i)).toBeTruthy();
  });

  it("warns when no embedding model is installed", async () => {
    await renderWithDefaults(null, { modelPath: null, running: false, baseUrl: null });
    expect(screen.getAllByText(/embedding model/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/not installed/i)).toBeTruthy();
  });

  it("renders a corpus row with path, counts, and an enabled toggle", async () => {
    // Toggle off → docsSetCorpusEnabled should be called with false.
    docsSetCorpusEnabledMock.mockResolvedValue(undefined);
    docsRemoveCorpusMock.mockResolvedValue(undefined);
    docsListCorporaMock.mockResolvedValue([
      corpus(),
      corpus({ id: "corp-2", name: "research", enabled: false, fileCount: 3, chunkCount: 0 }),
    ]);
    await renderWithDefaults([corpus(), corpus({ id: "corp-2", name: "research", enabled: false, fileCount: 3, chunkCount: 0 })], sidecar({ running: true }));
    // Path + counts rendered.
    expect(screen.getByText(/my-notes/i)).toBeTruthy();
    expect(screen.getByText(/12 files/i)).toBeTruthy();
    expect(screen.getByText(/40 chunks/i)).toBeTruthy();
    // Enabled toggle: default (enabled) is checked.
    const firstCheck = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    fireEvent.click(firstCheck);
    await waitFor(() => expect(docsSetCorpusEnabledMock).toHaveBeenCalledWith("corp-1", false));
  });

  it("reflects an in-flight index via the progress event", async () => {
    await renderWithDefaults([corpus()], sidecar());
    // Simulate the backend push: running event with a partial count.
    const handler = onDocsIndexProgressMock.mock
      .calls[0][0] as unknown as (p: DocsIndexProgressPayload) => void;
    actSafe(() =>
      handler({
        corpusId: "corp-1",
        state: "running",
        processedFiles: 3,
        totalFiles: 12,
        chunksWritten: 9,
        imagesProcessed: 0,
        imagesSkipped: 0,
        error: null,
      }),
    );
    expect(screen.getByText(/3\/12 files/)).toBeTruthy();
  });

  it("starts an index when 'Index' is clicked", async () => {
    docsStartIndexMock.mockResolvedValue(undefined);
    await renderWithDefaults([corpus({ chunkCount: 0 })], sidecar());
    fireEvent.click(screen.getByText(/^Index$/));
    expect(docsStartIndexMock).toHaveBeenCalledWith("corp-1");
  });

  it("indexes a corpus immediately after adding it", async () => {
    // The 2026-09-30 report: adding a corpus left it inert (0 files ·
    // 0 chunks · never indexed) because nothing kicked the run off — the
    // add flow itself must now start the index.
    docsAddCorpusMock.mockResolvedValue(corpus({ fileCount: 0, chunkCount: 0, lastIndexedAt: null }));
    docsStartIndexMock.mockResolvedValue(undefined);
    openMock.mockResolvedValue("D:/projects/Ultimate-workspace");
    await renderWithDefaults([], sidecar());
    fireEvent.click(screen.getByRole("button", { name: /\+ Add folder/ }));
    await waitFor(() => expect(docsAddCorpusMock).toHaveBeenCalledWith("D:/projects/Ultimate-workspace"));
    await waitFor(() => expect(docsStartIndexMock).toHaveBeenCalledWith("corp-1"));
  });

  it("surfaces a start failure when the auto-index cannot launch", async () => {
    docsAddCorpusMock.mockResolvedValue(corpus());
    docsStartIndexMock.mockRejectedValue("no embedding model installed");
    openMock.mockResolvedValue("D:/projects/trading");
    await renderWithDefaults([], sidecar());
    fireEvent.click(screen.getByRole("button", { name: /\+ Add folder/ }));
    await waitFor(() =>
      expect(screen.getByText(/indexing failed to start/i)).toBeTruthy(),
    );
  });

  it("removes a corpus after confirm", async () => {
    docsRemoveCorpusMock.mockResolvedValue(undefined);
    docsListCorporaMock.mockResolvedValue([]);
    await renderWithDefaults([corpus()], sidecar());
    fireEvent.click(screen.getByText(/^Remove$/));
    // The in-app confirm opens (no window.confirm) — accept it, then the
    // removal must run.
    await waitFor(() => expect(useConfirmStore.getState().current).toBeTruthy());
    expect(docsRemoveCorpusMock).not.toHaveBeenCalled();
    act(() => useConfirmStore.getState().settle(true));
    await waitFor(() => expect(docsRemoveCorpusMock).toHaveBeenCalledWith("corp-1"));
  });

  it("does NOT remove a corpus when the confirm is denied", async () => {
    docsRemoveCorpusMock.mockResolvedValue(undefined);
    docsListCorporaMock.mockResolvedValue([corpus()]);
    await renderWithDefaults([corpus()], sidecar());
    fireEvent.click(screen.getByText(/^Remove$/));
    await waitFor(() => expect(useConfirmStore.getState().current).toBeTruthy());
    act(() => useConfirmStore.getState().settle(false));
    expect(docsRemoveCorpusMock).not.toHaveBeenCalled();
  });

  it("persists the reranker toggle to docs.rerank and warms the sidecar", async () => {
    // Found model + sidecar down: enabling should write the setting and kick
    // docs_start_reranker (best-effort warm-up).
    await renderWithDefaults(
      [corpus()],
      sidecar({
        reranker: { modelPath: "C:/models/bge-reranker-v2-m3-Q8_0.gguf", running: false, baseUrl: null },
      }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /rerank search results/i }));
    await waitFor(() => expect(setSettingMock).toHaveBeenCalledWith("docs.rerank", "true"));
    await waitFor(() => expect(docsStartRerankerMock).toHaveBeenCalled());
  });

  it("lists discovered embedding models per family+quant and persists a choice", async () => {
    docsListEmbeddingModelsMock.mockResolvedValue([
      embedModel(),
      embedModel({
        path: "C:/models/embeddinggemma-2-F16.gguf",
        filename: "embeddinggemma-2-F16.gguf",
        family: "embeddinggemma-2",
        quantization: "F16",
        sizeBytes: 558_000_000,
        architecture: "gemma-embedding2",
      }),
    ]);
    docsSetEmbeddingModelMock.mockResolvedValue("C:/models/embeddinggemma-2-F16.gguf");
    await renderWithDefaults([], sidecar());

    const picker = screen.getByRole("combobox", { name: /embedding model/i });
    // Auto is the default choice; each discovered file is a grouped option.
    expect((picker as HTMLSelectElement).value).toBe("");
    // The active model (sidecar.modelPath) is marked on its option.
    expect(screen.getByRole("option", { name: /Q8_0 · 80 MB — active/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /F16 · 532 MB/ })).toBeTruthy();

    fireEvent.change(picker, { target: { value: "C:/models/embeddinggemma-2-F16.gguf" } });
    await waitFor(() =>
      expect(docsSetEmbeddingModelMock).toHaveBeenCalledWith("C:/models/embeddinggemma-2-F16.gguf"),
    );
  });

  it("falls back to auto (null) when switching from a manual choice to Auto", async () => {
    // Start on a manual pick, then switch back to Auto — a no-op change
    // (Auto → Auto) never calls the backend, so seed the manual one first.
    getSettingMock.mockImplementation((key: string) =>
      key === "docs.embedding_model"
        ? Promise.resolve("C:/models/embeddinggemma-2-F16.gguf")
        : Promise.resolve(null),
    );
    docsListEmbeddingModelsMock.mockResolvedValue([embedModel()]);
    await renderWithDefaults([], sidecar());
    const picker = screen.getByRole("combobox", { name: /embedding model/i });
    await waitFor(() =>
      expect((picker as HTMLSelectElement).value).toBe("C:/models/embeddinggemma-2-F16.gguf"),
    );
    fireEvent.change(picker, { target: { value: "" } });
    await waitFor(() => expect(docsSetEmbeddingModelMock).toHaveBeenCalledWith(null));
  });

  it("warns when the chosen embedding model file is gone", async () => {
    getSettingMock.mockImplementation((key: string) =>
      key === "docs.embedding_model"
        ? Promise.resolve("C:/models/deleted-model.Q8_0.gguf")
        : Promise.resolve(null),
    );
    docsListEmbeddingModelsMock.mockResolvedValue([embedModel()]);
    await renderWithDefaults([], sidecar());
    expect(screen.getByText(/chosen model file is gone/i)).toBeTruthy();
  });

  it("offers embeddinggemma-2 among the downloadable suggestions", async () => {
    await renderWithDefaults([], sidecar({ modelPath: null }));
    expect(screen.getByText(/embeddinggemma-2/i)).toBeTruthy();
    expect(screen.getByText(/nomic-embed-text-v1\.5/i)).toBeTruthy();
  });
});

function actSafe(fn: () => void) {
  act(fn);
}
