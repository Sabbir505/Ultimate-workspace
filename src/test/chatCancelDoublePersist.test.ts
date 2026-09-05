// A2 (ISSUES.md): cancelStream used to persist the partial, then AWAIT the
// cancel, and only afterwards clear the session's `streaming` entry. The
// harness cancel emits a terminal chat:error while those IPC round-trips are
// still in flight — onError passed its "still streaming" guard and persisted
// the SAME partial again (the backend insert is not deduped), producing a
// duplicate assistant bubble after every reload. The fix clears the
// streaming/chatStatus entries SYNCHRONOUSLY before the first await, so the
// late chat:error sees no entry and no-ops the persist.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  sendChatMessage: vi.fn(),
  sendAgentChatMessage: vi.fn(),
  cancelChatMessage: vi.fn().mockResolvedValue(undefined),
  cancelAgentChatMessage: vi.fn().mockResolvedValue(undefined),
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
  deleteAllChatSessions: vi.fn().mockResolvedValue(0),
  deleteChatMessage: vi.fn(),
  persistPartialChatMessage: vi.fn().mockResolvedValue(undefined),
  setChatApiKey: vi.fn(),
  deleteChatApiKey: vi.fn(),
  readArtifactPreview: vi.fn(),
  loopSessionStart: vi.fn().mockResolvedValue(null),
  loopSessionAdvance: vi.fn().mockResolvedValue(undefined),
  loopSessionFinish: vi.fn().mockResolvedValue(undefined),
  finishArtifactRuns: vi.fn().mockResolvedValue(0),
}));

import { cancelChatMessage, persistPartialChatMessage } from "../lib/ipc";
import { useChatStore } from "../state/chat";

const id = "sess-harness";

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    sessions: [{ id, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never],
    activeChatSessionId: id,
    messages: [],
    streaming: { [id]: "partial reply text" },
    chatStatus: {},
    streamingChatSessionId: id,
    messageQueue: {},
    loopState: {},
    stoppedPartial: {},
  });
});

describe("A2: chat:error landing mid-cancel must not double-persist the partial", () => {
  it("persists the partial exactly once when onError fires while the cancel is in flight", async () => {
    // Hold the persist and the cancel in flight, like real IPC round-trips.
    let resolvePersist: (v: void) => void = () => {};
    let resolveCancel: (v: void) => void = () => {};
    vi.mocked(persistPartialChatMessage).mockImplementation(
      () => new Promise<void>((r) => (resolvePersist = r)),
    );
    vi.mocked(cancelChatMessage).mockImplementation(
      () => new Promise<void>((r) => (resolveCancel = r)),
    );

    const cancelling = useChatStore.getState().cancelStream();

    // The FIX: the streaming entry is gone SYNCHRONOUSLY, before the first
    // await. (Pre-fix it survived until after the cancel resolved.)
    expect("s1" in useChatStore.getState().streaming).toBe(false);
    expect(id in useChatStore.getState().streaming).toBe(false);

    // The harness cancel emits its terminal chat:error NOW — while the
    // partial persist and the cancel IPC are both still pending.
    useChatStore.getState().onError(id, "aborted", null);

    // onError's guard sees no streaming entry → no second persist.
    expect(persistPartialChatMessage).toHaveBeenCalledTimes(1);
    expect(persistPartialChatMessage).toHaveBeenCalledWith(id, "partial reply text");

    resolvePersist();
    // cancelStream only CALLS cancelChatMessage once the persist await
    // resumes (a microtask later) — yield so the manual resolver is attached
    // to the actual in-flight promise before resolving it.
    await Promise.resolve();
    await Promise.resolve();
    resolveCancel();
    await cancelling;

    // Still exactly once after everything settles.
    expect(persistPartialChatMessage).toHaveBeenCalledTimes(1);
    // Cancel semantics intact: the streaming state stays cleared and the
    // partial bubble keeps its stopped content.
    const s = useChatStore.getState();
    expect(id in s.streaming).toBe(false);
    expect(s.stoppedPartial[id]).toBe("partial reply text");
    expect(s.streamingChatSessionId).toBeNull();
  });

  it("a second chat:error for the same turn persists nothing further", async () => {
    vi.mocked(persistPartialChatMessage).mockResolvedValue(undefined);
    vi.mocked(cancelChatMessage).mockResolvedValue(undefined);

    useChatStore.getState().onError(id, "boom", null);
    useChatStore.getState().onError(id, "boom (duplicate)", null);

    expect(persistPartialChatMessage).toHaveBeenCalledTimes(1);
  });
});
