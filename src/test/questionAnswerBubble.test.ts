// Question-answer UX regression guards: resolving a question card must (1)
// surface the answer as a user bubble IMMEDIATELY (the follow-up turn
// dispatches on a backend thread — without the optimistic bubble nothing in
// the transcript showed the answer landed), (2) show the BARE answer, never
// the "You asked: … / Continue the task…" CLI scaffold, and (3) mirror the
// backend's compose_ask_display exactly so mergeOptimistic swaps the
// optimistic twin for the persisted row. The composer flip back to Stop is
// covered by beginRemoteTurn (automationRunLog.test.ts) driven by the
// chat:turn-started event the backend now emits before the spawn.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../state/chat";

const resolveAgentQuestionMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/ipc", () => ({
  loopSessionStart: vi.fn().mockResolvedValue(null),
  loopSessionAdvance: vi.fn().mockResolvedValue(undefined),
  loopSessionFinish: vi.fn().mockResolvedValue(undefined),
  finishArtifactRuns: vi.fn().mockResolvedValue(0),
  sendAgentChatMessage: vi.fn().mockResolvedValue(undefined),
  cancelAgentChatMessage: vi.fn().mockResolvedValue(undefined),
  sendChatMessage: vi.fn().mockResolvedValue(undefined),
  cancelChatMessage: vi.fn().mockResolvedValue(undefined),
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatSessions: vi.fn().mockResolvedValue([]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn(),
  generateChatTitle: vi.fn().mockResolvedValue(null),
  listChatModels: vi.fn().mockResolvedValue([]),
  listHarnessModels: vi.fn().mockResolvedValue(null),
  listChatInstances: vi.fn().mockResolvedValue([]),
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
  resolveAgentQuestion: (...a: unknown[]) => resolveAgentQuestionMock(...a),
  resolveToolAction: vi.fn().mockResolvedValue(undefined),
}));

function seedSession(id: string) {
  useChatStore.setState((s) => ({
    activeChatSessionId: id,
    messagesSessionId: id,
    messages: [],
    sessions: [
      ...s.sessions.filter((x) => x.id !== id),
      {
        id,
        title: "Q&A",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider: null,
        model: null,
        agent: "harness:commandcode",
      } as never,
    ],
    pendingQuestions: {
      ...s.pendingQuestions,
      [id]: {
        pendingId: "pending-1",
        questions: [{ question: "What should I focus on next?", options: [] }],
      },
    },
  }));
}

describe("resolveQuestion answer bubble", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentQuestionMock.mockResolvedValue(undefined);
  });

  it("appends the bare answer as an optimistic user bubble", async () => {
    seedSession("s1");
    await useChatStore
      .getState()
      .resolveQuestion("s1", { "What should I focus on next?": "Relay product" }, undefined);
    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Relay product");
    expect(msgs[0].id).toBeLessThan(0); // optimistic twin, swapped on refetch
    // The card's pendingId rode along to the backend.
    expect(resolveAgentQuestionMock).toHaveBeenCalledWith(
      "s1",
      "pending-1",
      { "What should I focus on next?": "Relay product" },
      undefined,
    );
  });

  it("renders a skip as the quiet dismissal marker", async () => {
    seedSession("s2");
    await useChatStore.getState().resolveQuestion("s2", {}, undefined);
    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("(skipped the question)");
  });

  it("never leaks the CLI scaffold into the bubble", async () => {
    seedSession("s3");
    await useChatStore
      .getState()
      .resolveQuestion("s3", { "Q?": "alpha, beta" }, "free text");
    const content = useChatStore.getState().messages[0]?.content ?? "";
    expect(content).toBe("alpha, beta\nfree text");
    expect(content).not.toContain("You asked");
    expect(content).not.toContain("Continue the task");
  });

  it("dismisses the card so it cannot be answered twice", async () => {
    seedSession("s4");
    await useChatStore.getState().resolveQuestion("s4", { Q: "yes" }, undefined);
    expect(useChatStore.getState().pendingQuestions["s4"]).toBeUndefined();
  });
});
