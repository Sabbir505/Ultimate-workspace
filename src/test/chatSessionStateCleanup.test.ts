// A1 (ISSUES.md): clearSessionState stripped 22 per-session maps but skipped
// lastTurnPerf / citationReports / stoppedPartial / artifactProposals — those
// survived deleteChat forever (stoppedPartial alone can hold ~200KB of partial
// reply per deleted chat). deleteAllChats reset lastTurnPerf but likewise
// omitted the other three.
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
  deleteAllChatSessions: vi.fn().mockResolvedValue(1),
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

import { useChatStore } from "../state/chat";

const id = "sess-leak";

function seedMaps() {
  useChatStore.setState({
    sessions: [{ id, title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never],
    // One entry per audited map, keyed to the session about to be deleted.
    lastTurnPerf: { [id]: { llmTimeMs: 1, toolTimeMs: 1, ttftMs: null, tokensPerSecond: null, outputTokens: 1, inputTokens: null, cacheHitRate: null, elapsedMs: null } } as never,
    citationReports: { [id]: { chatSessionId: id } } as never,
    stoppedPartial: { [id]: "x".repeat(2048) } as never,
    artifactProposals: { [id]: [{ id: "p1", proposal: {}, state: "ready" }] } as never,
  });
}

describe("A1: per-session maps are cleared with their session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      sessions: [],
      activeChatSessionId: null,
      streaming: {},
      chatStatus: {},
      messageQueue: {},
      loopState: {},
    });
    seedMaps();
  });

  it("deleteChat removes lastTurnPerf/citationReports/stoppedPartial/artifactProposals", async () => {
    await useChatStore.getState().deleteChat(id);

    const s = useChatStore.getState();
    expect(id in s.lastTurnPerf).toBe(false);
    expect(id in s.citationReports).toBe(false);
    // The big one: a deleted chat's partial reply must not sit in memory
    // for the rest of the app run.
    expect(id in s.stoppedPartial).toBe(false);
    expect(id in s.artifactProposals).toBe(false);
  });

  it("deleteAllChats resets citationReports/stoppedPartial/artifactProposals too", async () => {
    await useChatStore.getState().deleteAllChats();

    const s = useChatStore.getState();
    expect(s.lastTurnPerf).toEqual({});
    expect(s.citationReports).toEqual({});
    expect(s.stoppedPartial).toEqual({});
    expect(s.artifactProposals).toEqual({});
  });

  it("deleteChat keeps OTHER sessions' entries (per-session, not global wipe)", async () => {
    const other = "sess-keep";
    useChatStore.setState((s) => ({
      sessions: [...s.sessions, { id: other, title: "k", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never],
      stoppedPartial: { ...s.stoppedPartial, [other]: "still streaming later" },
    }));

    await useChatStore.getState().deleteChat(id);

    expect(useChatStore.getState().stoppedPartial[other]).toBe("still streaming later");
  });
});
