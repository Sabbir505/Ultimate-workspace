// Tests for the /goal / /loop autonomous-iteration feature:
//  - `parseLoopStatus` reads the `LOOP_STATUS: <state>` sentinel out of a
//    reply (the host uses it to decide whether to issue another turn).
//  - store actions `startLoop` / `advanceLoop` / `stopLoop` arm/inspect
//    disarm a per-session loop.
// Missing/malformed sentinel must always resolve to "stop" so the host can
// never drive an infinite loop on an uncooperative model.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  // None of the loop actions send messages directly, but importing the store
  // pulls in the IPC module, so stub the few constructors touched at module
  // load. sendMessage is mocked so the onDone-continuation test does not
  // actually fire a real backend call.
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
}));

import {
  parseLoopStatus,
  useChatStore,
  GOAL_LOOP_MAX,
} from "../state/chat";

describe("parseLoopStatus", () => {
  it("reads a trailing continue sentinel", () => {
    expect(parseLoopStatus("Did step 1.\nSTATUS: 1/3 done.\nLOOP_STATUS: continue")).toBe("continue");
  });
  it("reads a trailing complete sentinel", () => {
    expect(parseLoopStatus("All done.\nSTATUS: complete.\nLOOP_STATUS: complete")).toBe("complete");
  });
  it("reads a trailing blocked sentinel", () => {
    expect(parseLoopStatus("Need an API key.\nLOOP_STATUS: blocked")).toBe("blocked");
  });
  it("is case-insensitive", () => {
    expect(parseLoopStatus("LOOP_STATUS: Continue")).toBe("continue");
  });
  it("tolerates a sentinel wrapped in a markdown blockquote", () => {
    expect(parseLoopStatus("> LOOP_STATUS: continue")).toBe("continue");
  });
  it("uses the LAST sentinel when multiple appear", () => {
    expect(parseLoopStatus("LOOP_STATUS: continue\n...\nLOOP_STATUS: complete")).toBe("complete");
  });
  it("returns stop when the sentinel is missing", () => {
    expect(parseLoopStatus("Just a normal reply with no sentinel.")).toBe("stop");
  });
  it("returns stop on a malformed sentinel", () => {
    expect(parseLoopStatus("LOOP_STATUS: yes")).toBe("stop");
    expect(parseLoopStatus("LOOP_STATUS:continueextra")).toBe("stop");
  });
  it("does not match a sentinel embedded in a word", () => {
    expect(parseLoopStatus("fooLOOP_STATUS: continue")).toBe("stop");
  });
});

describe("loop store actions", () => {
  const id = "sess-loop";

  beforeEach(() => {
    useChatStore.setState({
      sessions: [
        { id, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never,
      ],
      activeChatSessionId: id,
      messages: [],
      streaming: {},
      streamingChatSessionId: null,
      loopState: {},
    });
  });

  it("startLoop arms a fresh loop with iteration 0 and the default cap", () => {
    useChatStore.getState().startLoop("refactor the auth module");
    const loop = useChatStore.getState().loopState[id];
    expect(loop).toEqual({
      goal: "refactor the auth module",
      iteration: 0,
      max: GOAL_LOOP_MAX,
      active: true,
    });
  });

  it("advanceLoop returns continue and ticks iteration on a continue reply", () => {
    useChatStore.getState().startLoop("g");
    const decision = useChatStore.getState().advanceLoop(id, "work done\nLOOP_STATUS: continue");
    expect(decision).toBe("continue");
    expect(useChatStore.getState().loopState[id].iteration).toBe(1);
    expect(useChatStore.getState().loopState[id].active).toBe(true);
  });

  it("advanceLoop disarms on a complete reply", () => {
    useChatStore.getState().startLoop("g");
    const decision = useChatStore.getState().advanceLoop(id, "all done\nLOOP_STATUS: complete");
    expect(decision).toBe("complete");
    expect(useChatStore.getState().loopState[id].active).toBe(false);
  });

  it("advanceLoop disarms on a blocked reply", () => {
    useChatStore.getState().startLoop("g");
    const decision = useChatStore.getState().advanceLoop(id, "stuck\nLOOP_STATUS: blocked");
    expect(decision).toBe("blocked");
    expect(useChatStore.getState().loopState[id].active).toBe(false);
  });

  it("advanceLoop returns stop and disarms when the sentinel is missing", () => {
    useChatStore.getState().startLoop("g");
    const decision = useChatStore.getState().advanceLoop(id, "no sentinel here");
    expect(decision).toBe("stop");
    expect(useChatStore.getState().loopState[id].active).toBe(false);
  });

  it("advanceLoop stops at the iteration cap even if the model says continue", () => {
    useChatStore.getState().startLoop("g");
    // Force the loop to the very edge of the cap, then try to continue.
    useChatStore.setState((s) => ({
      loopState: { ...s.loopState, [id]: { ...s.loopState[id], iteration: GOAL_LOOP_MAX - 1 } },
    }));
    const decision = useChatStore.getState().advanceLoop(id, "LOOP_STATUS: continue");
    expect(decision).toBe("stop");
    expect(useChatStore.getState().loopState[id].active).toBe(false);
  });

  it("advanceLoop is a no-op (stop) when no loop is armed", () => {
    useChatStore.setState({ loopState: {} });
    expect(useChatStore.getState().advanceLoop(id, "LOOP_STATUS: continue")).toBe("stop");
  });

  it("stopLoop disarms without changing the goal/iteration (so the chip leaves)", () => {
    useChatStore.getState().startLoop("g");
    useChatStore.getState().stopLoop();
    const loop = useChatStore.getState().loopState[id];
    expect(loop.active).toBe(false);
    expect(loop.goal).toBe("g");
    expect(loop.iteration).toBe(0);
  });
});

describe("onDone loop continuation", () => {
  const id = "sess-loop2";

  beforeEach(() => {
    useChatStore.setState({
      sessions: [
        { id, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never,
      ],
      activeChatSessionId: id,
      messages: [],
      streaming: {},
      streamingChatSessionId: null,
      loopState: {},
    });
  });

  it("emits a continuation sendMessage on a continue reply", async () => {
    useChatStore.getState().startLoop("iterate this goal");
    // Simulate the finished turn having an assistant message with a continue
    // sentinel. onDone re-reads messages from getChatMessages, so seed the
    // mock to return it.
    const { getChatMessages, sendChatMessage, sendAgentChatMessage } = await import("../lib/ipc");
    vi.mocked(getChatMessages).mockResolvedValue([
      {
        id: 1,
        chatSessionId: id,
        role: "assistant",
        content: "did step\nLOOP_STATUS: continue",
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        createdAt: 0,
        startedAt: null,
        completedAt: null,
      } as never,
    ]);

    // The store's sendMessage is the seam: spy on it so we don't exercise the
    // real IPC send path. setAddress its implementation to no-op.
    const sendSpy = vi.spyOn(useChatStore.getState(), "sendMessage").mockResolvedValue(undefined);

    await useChatStore.getState().onDone(id, null, null, null);

    // Drain the microtask the continuation is deferred onto.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendSpy).toHaveBeenCalled();
    const body = sendSpy.mock.calls[0][0] as string;
    expect(body).toContain("[loop iteration");
    expect(body).toContain("iterate this goal");

    sendSpy.mockRestore();
    // Untouched: just to keep the linter aware these mocks are referenced.
    expect(sendChatMessage).toBeDefined();
    expect(sendAgentChatMessage).toBeDefined();
  });

  it("does NOT continue on a complete reply", async () => {
    useChatStore.getState().startLoop("g");
    const { getChatMessages } = await import("../lib/ipc");
    vi.mocked(getChatMessages).mockResolvedValue([
      {
        id: 1,
        chatSessionId: id,
        role: "assistant",
        content: "all done\nLOOP_STATUS: complete",
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        createdAt: 0,
        startedAt: null,
        completedAt: null,
      } as never,
    ]);
    const sendSpy = vi.spyOn(useChatStore.getState(), "sendMessage").mockResolvedValue(undefined);

    await useChatStore.getState().onDone(id, null, null, null);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(useChatStore.getState().loopState[id].active).toBe(false);
    sendSpy.mockRestore();
  });
});
