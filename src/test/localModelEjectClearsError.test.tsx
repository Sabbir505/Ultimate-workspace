// Regression (2026-10-16 report): a failed local-model start ("could not be
// started after restart", e.g. the Ternary-Bonsai PQ2_0 load) left its
// `chat-error` banner in the session's `errorBySession` slot past the point
// where the user ejected the broken model or loaded a different one — only
// the next send cleared it, so the old model's error sat on screen and read
// as a live failure of the model the user had moved to. Ejecting and every
// committed model pick must clear this session's stale banner.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { stopLocalModelMock, startLocalModelMock } = vi.hoisted(() => ({
  stopLocalModelMock: vi.fn(async () => {}),
  // Typed params so `mock.calls[0][0]` is the model id (tests assert on it).
  startLocalModelMock: vi.fn(
    async (
      _modelId: string,
      _path: string,
      _mmprojPath?: string | null,
      _overrides?: unknown,
    ) => ({
      modelId: "good-1",
      port: 51999,
      nCtx: 8192,
      nGpuLayers: 999,
      baseUrl: "http://127.0.0.1:51999",
    }),
  ),
}));

const STALE_MODEL = "Ternary-Bonsai-2-9B-PQ2_0-MTP-Q8_0.gguf";
const GOOD_MODEL = "Gemma-4-E4B-Instruct-Q4_K_M.gguf";

const GOOD_SCAN = [
  {
    id: "good-1",
    path: `D:/local models/models/${GOOD_MODEL}`,
    filename: GOOD_MODEL,
    sizeBytes: 4.97e9,
    name: null,
    architecture: "gemma3",
    paramCountLabel: "4B",
    quantization: "Q4_K_M",
    memoryClass: "fits",
    source: "scan",
    hasVision: false,
    mmprojPath: null,
    toolSupport: "likely",
  },
];

const STALE_ERROR =
  'The local model "Ternary-Bonsai-2-9B" could not be started after restart: ' +
  "llama-server exited during startup with --n-gpu-layers=999.";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // A live sidecar running the broken model — the ⏏ row's visibility gate.
  localModelStatus: vi.fn(async () => ({
    modelId: STALE_MODEL,
    port: 51820,
    nCtx: 4096,
    nGpuLayers: 999,
    baseUrl: "http://127.0.0.1:51820",
  })),
  scanLocalModels: vi.fn(async () => GOOD_SCAN),
  stopLocalModel: stopLocalModelMock,
  startLocalModel: startLocalModelMock,
  warmupLocalPrompt: vi.fn(async () => {}),
  updateChatSessionModel: vi.fn(async () => null),
  // Mount-time loaders (silence the real IPC wrappers).
  getLocalModelOverrides: vi.fn(async () => null),
  countContextTokens: vi.fn(async () => null),
  listConnectors: vi.fn(async () => []),
  mcpGalleryList: vi.fn(async () => ({ installed: [] })),
  listSessionConnectors: vi.fn(async () => []),
  listChatSkills: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
}));

import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";
import { ChatView } from "../components/chat/ChatView";

// jsdom doesn't implement scrollIntoView (the picker's keyboard-nav effect).
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

beforeEach(() => {
  stopLocalModelMock.mockClear();
  startLocalModelMock.mockClear();
  useChatStore.setState({
    activeChatSessionId: "s1",
    chatPaneTree: null,
    paneBuffers: {},
    loaded: true,
    config: { provider: "openai_compatible", model: "m" } as never,
    sessions: [
      {
        id: "s1",
        title: "S1",
        agent: "local",
        provider: "local_gguf",
        model: STALE_MODEL,
        createdAt: 0,
        lastActiveAt: 0,
      } as never,
    ],
    // The banner lives in the timeline branch — it renders with the chat.
    messages: [
      { id: 1, chatSessionId: "s1", role: "user", content: "hi", inputTokens: null, outputTokens: null, costUsd: null, createdAt: 0 },
      { id: 2, chatSessionId: "s1", role: "assistant", content: "hello", inputTokens: null, outputTokens: null, costUsd: null, createdAt: 0 },
    ] as never,
    messagesSessionId: "s1",
    streaming: {},
    chatStatus: {},
    livePerf: {},
    lastTurnPerf: {},
    sessionMetrics: {},
    artifacts: {},
    artifactProposals: {},
    artifactsByMessage: {},
    tasks: {},
    loopState: {},
    // The leftover failure from the previous model's start.
    errorBySession: { s1: STALE_ERROR },
    errorCodeBySession: { s1: "local_start_failed" },
  });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ openContextTipIds: [], contextTipOpen: false });
  useChatStore.setState({
    streaming: {},
    messages: [],
    activeChatSessionId: null,
    errorBySession: {},
    errorCodeBySession: {},
  });
});

const openPicker = (container: HTMLElement) =>
  fireEvent.click(container.querySelector<HTMLElement>(".agent-chip")!);

describe("stale local-model error clears when the user moves on", () => {
  it("ejecting the sidecar drops the previous model's banner", async () => {
    const view = render(<ChatView />);

    // The banner from the failed start is up before the eject.
    await waitFor(() => {
      expect(document.querySelector(".chat-error")).toBeTruthy();
    });

    openPicker(view.container);
    const eject = await screen.findByRole("button", { name: /eject model/i });
    fireEvent.click(eject);

    await waitFor(() => {
      expect(useChatStore.getState().errorBySession["s1"]).toBeUndefined();
      expect(useChatStore.getState().errorCodeBySession["s1"]).toBeUndefined();
      expect(document.querySelector(".chat-error")).toBeNull();
    });
    expect(stopLocalModelMock).toHaveBeenCalledWith(STALE_MODEL);
  });

  it("picking a different local model drops the previous model's banner", async () => {
    const view = render(<ChatView />);
    await waitFor(() => {
      expect(document.querySelector(".chat-error")).toBeTruthy();
    });

    openPicker(view.container);
    const row = await screen.findByRole("menuitemradio", { name: /Gemma-4-E4B-Instruct/ });
    fireEvent.click(row);

    await waitFor(() => {
      expect(startLocalModelMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(useChatStore.getState().errorBySession["s1"]).toBeUndefined();
      expect(document.querySelector(".chat-error")).toBeNull();
    });
    // The spawn used the picked model's registry id — the clear rode the
    // committed pick, not some unrelated state write.
    expect(startLocalModelMock.mock.calls[0][0]).toBe("good-1");
  });
});
