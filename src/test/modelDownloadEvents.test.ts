// Runtime builds (llama.cpp CUDA / whisper.cpp CPU+CUDA) ride the same
// download stream as Hugging Face models but must not be announced as "model
// download finished" — a CUDA build is an exe/DLL bundle, not a model. The
// hook words them as builds with the Server-builds-card names; model ids
// (`repo::file`) keep the original wording.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const notifySpy = vi.fn();
vi.mock("../lib/notifyCenter", () => ({ relayNotify: (...a: unknown[]) => notifySpy(...a) }));

let handler: ((p: unknown) => void) | null = null;
vi.mock("../hooks/useTauriEvent", () => ({
  useEventSubscription: (_evt: unknown, h: (p: unknown) => void) => {
    handler = h;
  },
}));
vi.mock("../lib/ipc", () => ({ onModelDownloadProgress: "local-model:download:progress" }));
vi.mock("../state/ui", () => ({
  useUiStore: (sel: (s: unknown) => unknown) =>
    sel({ updateModelDownload: vi.fn() }),
}));

import { useModelDownloadEvents } from "../hooks/useModelDownloadEvents";

function progress(over: Record<string, unknown>) {
  return {
    id: "org/model::model.gguf",
    state: "done",
    downloadedBytes: 1,
    totalBytes: 1,
    bytesPerSecond: 0,
    finalPath: null,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  notifySpy.mockClear();
  handler = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("model download notifications", () => {
  it("announces a CUDA llama-server build as a build, not a model", () => {
    renderHook(() => useModelDownloadEvents());
    handler!(progress({ id: "llama-cuda-server", state: "done" }));
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Build download finished",
        body: "Llama server (CUDA build) is ready to run.",
      }),
    );
  });

  it("announces whisper builds as builds with the card names", () => {
    renderHook(() => useModelDownloadEvents());
    handler!(progress({ id: "stt-whisper-cuda", state: "done" }));
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Build download finished",
        body: "Whisper server (CUDA build) is ready to run.",
      }),
    );
    handler!(progress({ id: "stt-whisper-server", state: "done" }));
    expect(notifySpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Build download finished",
        body: "Whisper server (CPU build) is ready to run.",
      }),
    );
  });

  it("keeps the model wording for Hugging Face model ids", () => {
    renderHook(() => useModelDownloadEvents());
    handler!(progress({ id: "bartowski/Llama-3-8B::Q4_K_M.gguf", state: "done" }));
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Model download finished",
        body: "bartowski/Llama-3-8B is ready to run.",
      }),
    );
  });

  it("words build failures as build failures", () => {
    renderHook(() => useModelDownloadEvents());
    handler!(progress({ id: "stt-whisper-cuda", state: "error", error: "sha mismatch" }));
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Build download failed",
        body: "sha mismatch",
      }),
    );
    handler!(progress({ id: "llama-cuda-server", state: "error", error: null }));
    expect(notifySpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Build download failed",
        body: "Llama server (CUDA build) could not be downloaded.",
      }),
    );
  });
});
