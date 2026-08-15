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
} from "../lib/ipc";

const docsEmbeddingStatusMock = vi.fn();
const docsListCorporaMock = vi.fn();
const docsAddCorpusMock = vi.fn();
const docsRemoveCorpusMock = vi.fn();
const docsSetCorpusEnabledMock = vi.fn();
const docsStartIndexMock = vi.fn();
const docsCancelIndexMock = vi.fn();
const onDocsIndexProgressMock = vi.fn();
const onDocsCorpusUpdatedMock = vi.fn();
const openMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openMock(...a),
}));

vi.mock("../lib/ipc", () => ({
  docsEmbeddingStatus: (...a: unknown[]) => docsEmbeddingStatusMock(...a),
  docsListCorpora: (...a: unknown[]) => docsListCorporaMock(...a),
  docsAddCorpus: (...a: unknown[]) => docsAddCorpusMock(...a),
  docsRemoveCorpus: (...a: unknown[]) => docsRemoveCorpusMock(...a),
  docsSetCorpusEnabled: (...a: unknown[]) => docsSetCorpusEnabledMock(...a),
  docsStartIndex: (...a: unknown[]) => docsStartIndexMock(...a),
  docsCancelIndex: (...a: unknown[]) => docsCancelIndexMock(...a),
  onDocsIndexProgress: (...a: unknown[]) => onDocsIndexProgressMock(...a),
  onDocsCorpusUpdated: (...a: unknown[]) => onDocsCorpusUpdatedMock(...a),
}));

// The panel calls confirm() before removing — spy it (fresh per test, so the
// vi.clearAllMocks() reset doesn't detach a stale mock). Seeded to accept by
// default so the happy-path remove flow is exercised; a case that needs denial
// can point it at false via callback.mockReturnValue.
let confirmSpy: ReturnType<typeof vi.fn>;

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
  onDocsIndexProgressMock.mockImplementation(() => Promise.resolve(vi.fn()));
  onDocsCorpusUpdatedMock.mockImplementation(() => Promise.resolve(vi.fn()));
  confirmSpy = vi.fn().mockReturnValue(true);
  // Stash the spy on window so component code that calls window.confirm() picks it up.
  window.confirm = confirmSpy as unknown as typeof window.confirm;
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
    expect(screen.getByText(/embedding model/i)).toBeTruthy();
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

  it("removes a corpus after confirm", async () => {
    docsRemoveCorpusMock.mockResolvedValue(undefined);
    docsListCorporaMock.mockResolvedValue([]);
    await renderWithDefaults([corpus()], sidecar());
    fireEvent.click(screen.getByText(/^Remove$/));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    await waitFor(() => expect(docsRemoveCorpusMock).toHaveBeenCalledWith("corp-1"));
  });
});

function actSafe(fn: () => void) {
  act(fn);
}
