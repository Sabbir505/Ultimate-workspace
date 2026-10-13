// The no-output watchdog, post-fix: a turn that keeps producing ANY liveness
// signal (tokens, the 500ms `chat:perf` heartbeat, status lines) is never
// released — a minutes-long tool call emits no text deltas but is alive.
// When the timer does expire, the release is reconciled with the backend:
// a turn the backend still owns keeps its bubble (and its Stop button), and
// only a turn the backend has finished is released — through the Stop path,
// which persists the streamed partial and actually stops the turn instead of
// leaving a phantom that rejects every later send with
// "a turn is already running for this chat".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  sendChatMessage: vi.fn().mockResolvedValue(undefined),
  sendAgentChatMessage: vi.fn().mockResolvedValue(undefined),
  cancelChatMessage: vi.fn().mockResolvedValue(undefined),
  cancelAgentChatMessage: vi.fn().mockResolvedValue(undefined),
  chatTurnInFlight: vi.fn().mockResolvedValue(false),
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatSessions: vi.fn().mockResolvedValue([]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  listChatCheckpoints: vi.fn().mockResolvedValue([]),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn(),
  generateChatTitle: vi.fn().mockResolvedValue(null),
  getChatConfig: vi.fn(),
  getChatSessionMetrics: vi.fn().mockResolvedValue(null),
  setChatSessionUnread: vi.fn().mockResolvedValue(undefined),
  setChatSessionStarred: vi.fn(),
  setChatSessionProject: vi.fn(),
  updateChatSessionTitle: vi.fn(),
  updateChatSessionModel: vi.fn(),
  updateChatSessionProvider: vi.fn(),
  updateChatSessionAgent: vi.fn(),
  updateChatSessionWatchMode: vi.fn(),
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  persistPartialChatMessage: vi.fn().mockResolvedValue(undefined),
  finishArtifactRuns: vi.fn().mockResolvedValue(0),
  loopSessionFinish: vi.fn().mockResolvedValue(undefined),
  toastError: vi.fn(),
}));

import {
  cancelChatMessage,
  chatTurnInFlight,
  persistPartialChatMessage,
} from "../lib/ipc";
import { useChatStore } from "../state/chat";

const id = "sess-watchdog";
const PARTIAL = "let me check the build output";

function seed() {
  useChatStore.setState({
    sessions: [
      { id, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never,
    ],
    activeChatSessionId: id,
    messages: [],
    streaming: { [id]: "" },
    chatStatus: {},
    streamingChatSessionId: id,
    messageQueue: {},
    stoppedPartial: {},
  });
}

/** Let the fire path's async chain (probe → cancelStream → persist) settle. */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  seed();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("no-output watchdog", () => {
  it("keeps the turn while any liveness arrives — perf heartbeats re-arm it", async () => {
    const store = useChatStore.getState();
    store.onToken(id, PARTIAL);

    // A long tool call: no tokens for 5 minutes, but the backend heartbeat
    // (chat:perf, every 500ms while the turn is registered) keeps flowing.
    for (let i = 0; i < 5; i++) {
      await settle(60_000);
      useChatStore.getState().onPerf({
        chatSessionId: id,
        llmTimeMs: 1000,
        toolTimeMs: 60_000 * (i + 1),
        ttftMs: 900,
        tokensPerSecond: 40,
        outputTokens: 12,
        inputTokens: 100,
        cacheHitRate: null,
        elapsedMs: 60_000 * (i + 1),
      } as never);
    }

    // The reply the user is watching never vanished, and nothing was stopped.
    expect(useChatStore.getState().streaming[id]).toBe(PARTIAL);
    expect(chatTurnInFlight).not.toHaveBeenCalled();
    expect(cancelChatMessage).not.toHaveBeenCalled();
  });

  it("keeps the turn (and its Stop button) when the backend still owns it", async () => {
    vi.mocked(chatTurnInFlight).mockResolvedValue(true);
    const store = useChatStore.getState();
    store.onToken(id, PARTIAL);

    await settle(120_000);
    expect(chatTurnInFlight).toHaveBeenCalledWith(id);
    expect(useChatStore.getState().streaming[id]).toBe(PARTIAL);
    expect(cancelChatMessage).not.toHaveBeenCalled();

    // The watchdog re-armed itself: another quiet window probes again.
    await settle(120_000);
    expect(chatTurnInFlight).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().streaming[id]).toBe(PARTIAL);
  });

  it("releases a turn the backend has finished — partial persisted, turn stopped", async () => {
    vi.mocked(chatTurnInFlight).mockResolvedValue(false);
    const store = useChatStore.getState();
    store.onToken(id, PARTIAL);

    await settle(120_000);

    // Released, but honestly: the text the user watched is persisted and the
    // backend turn is actually stopped, so the next send is not rejected.
    expect(useChatStore.getState().streaming[id]).toBeUndefined();
    expect(persistPartialChatMessage).toHaveBeenCalledWith(id, PARTIAL);
    expect(cancelChatMessage).toHaveBeenCalledWith(id);
  });

  it("keeps the turn when the liveness probe fails — never hide on a guess", async () => {
    vi.mocked(chatTurnInFlight).mockRejectedValue(new Error("ipc down"));
    const store = useChatStore.getState();
    store.onToken(id, PARTIAL);

    await settle(120_000);

    expect(useChatStore.getState().streaming[id]).toBe(PARTIAL);
    expect(cancelChatMessage).not.toHaveBeenCalled();
  });
});
