// P0 self-improving artifacts telemetry (SELF_IMPROVING_ARTIFACTS.md §4/§5):
//  - startLoop/stopLoop/advanceLoop persist loop sessions to the backend
//    (fire-and-forget: telemetry failures must never break loop control);
//  - onDone closes the session's open artifact runs as `applied`, onError as
//    `failed` with the classified error code, cancelStream as `abandoned`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loopSessionStart, loopSessionAdvance, loopSessionFinish, finishArtifactRuns } = vi.hoisted(() => ({
  loopSessionStart: vi.fn(),
  loopSessionAdvance: vi.fn(),
  loopSessionFinish: vi.fn(),
  finishArtifactRuns: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    sendChatMessage: vi.fn(),
    sendAgentChatMessage: vi.fn(),
    cancelChatMessage: vi.fn(),
    cancelAgentChatMessage: vi.fn(),
    getChatMessages: vi.fn().mockResolvedValue([]),
    listChatSessions: vi.fn().mockResolvedValue([]),
    listChatArtifacts: vi.fn().mockResolvedValue([]),
    touchChatSession: vi.fn().mockResolvedValue(undefined),
    createChatSession: vi.fn(),
    generateChatTitle: vi.fn().mockResolvedValue(null),
    getChatConfig: vi.fn(),
    getChatSessionMetrics: vi.fn(),
    setChatSessionUnread: vi.fn(),
    setChatSessionStarred: vi.fn(),
    setChatSessionProject: vi.fn(),
    updateChatSessionTitle: vi.fn(),
    updateChatSessionModel: vi.fn(),
    updateChatSessionProvider: vi.fn(),
    updateChatSessionAgent: vi.fn(),
    updateChatSessionWatchMode: vi.fn(),
    deleteChatSession: vi.fn(),
    deleteAllChatSessions: vi.fn(),
    deleteChatMessage: vi.fn(),
    persistPartialChatMessage: vi.fn(),
    setChatApiKey: vi.fn(),
    deleteChatApiKey: vi.fn(),
    readArtifactPreview: vi.fn(),
    emitMobileSessionChatEvent: vi.fn(),
    loopSessionStart,
    loopSessionAdvance,
    loopSessionFinish,
    finishArtifactRuns,
  };
});

import { GOAL_LOOP_MAX, useChatStore } from "../state/chat";

function armLoop(sessionId = "s1") {
  useChatStore.setState({
    activeChatSessionId: sessionId,
    loopState: { [sessionId]: { goal: "fix tests", iteration: 0, max: GOAL_LOOP_MAX, active: true, backendId: "loop-1" } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  loopSessionStart.mockResolvedValue({ id: "loop-1", chatSessionId: "s1", goal: "g", iteration: 0, maxIterations: 10, status: "running", runId: "run-1" });
  loopSessionAdvance.mockResolvedValue(undefined);
  loopSessionFinish.mockResolvedValue(undefined);
  finishArtifactRuns.mockResolvedValue(1);
  useChatStore.setState({ loopState: {}, activeChatSessionId: "s1", streaming: {} });
});

describe("loop backend persistence", () => {
  it("startLoop records a loop session and stores the backend id", async () => {
    useChatStore.setState({ loopState: {} });
    useChatStore.getState().startLoop("ship it", "s1");
    expect(loopSessionStart).toHaveBeenCalledWith("s1", "ship it", GOAL_LOOP_MAX);
    // backendId lands once the fire-and-forget promise resolves.
    await vi.waitFor(() => {
      expect(useChatStore.getState().loopState["s1"]?.backendId).toBe("loop-1");
    });
  });

  it("startLoop still arms the loop when the backend call fails", async () => {
    loopSessionStart.mockRejectedValueOnce(new Error("db closed"));
    useChatStore.setState({ loopState: {} });
    useChatStore.getState().startLoop("ship it", "s1");
    // Loop is armed synchronously regardless.
    expect(useChatStore.getState().loopState["s1"]?.active).toBe(true);
    await vi.waitFor(() => expect(loopSessionStart).toHaveBeenCalled());
    await Promise.resolve();
    expect(useChatStore.getState().loopState["s1"]?.backendId).toBeUndefined();
  });

  it("advanceLoop with continue persists the iteration", () => {
    armLoop("s1");
    const decision = useChatStore.getState().advanceLoop("s1", "working…\nLOOP_STATUS: continue");
    expect(decision).toBe("continue");
    expect(loopSessionAdvance).toHaveBeenCalledWith("loop-1", 1);
  });

  it("advanceLoop terminal complete finishes the backend session", () => {
    armLoop("s1");
    const decision = useChatStore.getState().advanceLoop("s1", "done\nLOOP_STATUS: complete");
    expect(decision).toBe("complete");
    expect(loopSessionFinish).toHaveBeenCalledWith("loop-1", "complete");
  });

  it("advanceLoop terminal blocked finishes with blocked", () => {
    armLoop("s1");
    const decision = useChatStore.getState().advanceLoop("s1", "need a key\nLOOP_STATUS: blocked");
    expect(decision).toBe("blocked");
    expect(loopSessionFinish).toHaveBeenCalledWith("loop-1", "blocked");
  });

  it("cap reached finishes with maxed", () => {
    useChatStore.setState({
      loopState: { s1: { goal: "g", iteration: GOAL_LOOP_MAX - 1, max: GOAL_LOOP_MAX, active: true, backendId: "loop-1" } },
    });
    const decision = useChatStore.getState().advanceLoop("s1", "LOOP_STATUS: continue");
    expect(decision).toBe("stop");
    expect(loopSessionFinish).toHaveBeenCalledWith("loop-1", "maxed");
  });

  it("stopLoop finishes with stopped", () => {
    armLoop("s1");
    useChatStore.getState().stopLoop("s1");
    expect(loopSessionFinish).toHaveBeenCalledWith("loop-1", "stopped");
    expect(useChatStore.getState().loopState["s1"]?.active).toBe(false);
  });
});

describe("turn outcome telemetry", () => {
  it("onDone closes open runs as applied", async () => {
    useChatStore.setState({ streamingChatSessionId: "s1", messages: [], activeChatSessionId: "s1" });
    await useChatStore.getState().onDone("s1", 1, 1, null);
    expect(finishArtifactRuns).toHaveBeenCalledWith("s1", "applied");
  });

  it("onError closes open runs as failed with the error code", () => {
    useChatStore.setState({ activeChatSessionId: "s1" });
    useChatStore.getState().onError("s1", "boom", "context_overflow");
    expect(finishArtifactRuns).toHaveBeenCalledWith("s1", "failed", "context_overflow");
  });

  it("telemetry failures never break the turn handlers", async () => {
    finishArtifactRuns.mockRejectedValueOnce(new Error("db closed"));
    useChatStore.setState({ activeChatSessionId: "s1", error: null, errorCode: null });
    await expect(useChatStore.getState().onDone("s1", 1, 1, null)).resolves.toBeUndefined();
    expect(useChatStore.getState().error).toBeNull();
  });
});
