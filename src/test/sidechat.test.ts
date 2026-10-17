// Sidechat (/sidechat): openSidechat pins a private sub-thread of a chat —
// seeded by the backend from a history snapshot — as a second pane, reuses
// the same session on re-open (focus / re-pin), and never touches the main
// session. The backend's copy/reuse semantics are covered Rust-side
// (db/chat.rs :: open_sidechat_snapshots_once_and_reuses_the_row).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
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
  openSidechatSession: vi.fn(),
}));

import { getChatMessages, openSidechatSession } from "../lib/ipc";
import type { ChatMessageRecord } from "../lib/ipc";
import { useChatStore } from "../state/chat";
import { findPaneForSession } from "../state/chat/paneTree";

const row = (
  id: number,
  chatSessionId: string,
  role: "user" | "assistant",
  content: string,
): ChatMessageRecord => ({
  id,
  chatSessionId,
  role,
  content,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  createdAt: 1,
  startedAt: null,
  completedAt: null,
});

function session(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    provider: "openai",
    model: "m",
    createdAt: 0,
    lastActiveAt: 0,
    ...over,
  };
}

const sidechatRow = {
  id: "sc1",
  title: "s1 · sidechat",
  provider: "openai",
  model: "m",
  createdAt: 0,
  lastActiveAt: 0,
  origin: "side_of:s1",
  projectId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  (getChatMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (openSidechatSession as ReturnType<typeof vi.fn>).mockResolvedValue(sidechatRow);
  useChatStore.setState({
    sessions: [session("s1")],
    activeChatSessionId: "s1",
    messages: [row(1, "s1", "user", "hi")],
    messagesSessionId: "s1",
    chatPaneTree: null,
    paneBuffers: {},
    streaming: {},
    chatStatus: {},
    messageQueue: {},
    checkpointsByMessage: {},
    sessionProjects: {},
  } as never);
});

describe("openSidechat", () => {
  it("pins the backend's sidechat as a second pane, main untouched", async () => {
    const id = await useChatStore.getState().openSidechat("s1");
    expect(id).toBe("sc1");
    expect(openSidechatSession).toHaveBeenCalledWith("s1");
    const st = useChatStore.getState();
    expect(st.sessions.some((s) => s.id === "sc1")).toBe(true);
    const paneId = findPaneForSession(st.chatPaneTree, "sc1");
    expect(paneId).not.toBeNull();
    expect(st.paneBuffers[paneId!]?.sessionId).toBe("sc1");
    expect(st.focusedPaneId).toBe(paneId);
    expect(st.focusedChatSessionId).toBe("sc1");
    // The main chat stays active — its pane keeps running undisturbed.
    expect(st.activeChatSessionId).toBe("s1");
    expect(findPaneForSession(st.chatPaneTree, "s1")).toBeNull();
  });

  it("re-opening focuses the existing pane instead of stacking a second one", async () => {
    await useChatStore.getState().openSidechat("s1");
    const paneId = findPaneForSession(useChatStore.getState().chatPaneTree, "sc1")!;
    useChatStore.getState().setFocusedPane(null);
    const id = await useChatStore.getState().openSidechat("s1");
    expect(id).toBe("sc1");
    expect(openSidechatSession).toHaveBeenCalledTimes(1);
    const st = useChatStore.getState();
    expect(st.focusedPaneId).toBe(paneId);
    expect(findPaneForSession(st.chatPaneTree, "sc1")).toBe(paneId);
  });

  it("re-pins the existing session when its pane was closed (no second row)", async () => {
    await useChatStore.getState().openSidechat("s1");
    const paneId = findPaneForSession(useChatStore.getState().chatPaneTree, "sc1")!;
    useChatStore.getState().closeChatPane(paneId);
    expect(findPaneForSession(useChatStore.getState().chatPaneTree, "sc1")).toBeNull();
    const id = await useChatStore.getState().openSidechat("s1");
    expect(id).toBe("sc1");
    expect(openSidechatSession).toHaveBeenCalledTimes(1);
    expect(findPaneForSession(useChatStore.getState().chatPaneTree, "sc1")).not.toBeNull();
  });

  it("refuses to open a sidechat for an empty active chat", async () => {
    useChatStore.setState({ messages: [], messagesSessionId: "s1" } as never);
    const id = await useChatStore.getState().openSidechat("s1");
    expect(id).toBeNull();
    expect(openSidechatSession).not.toHaveBeenCalled();
  });

  it("only reuses a sidechat of the SAME source chat", async () => {
    useChatStore.setState({
      sessions: [session("s1"), session("scB", { origin: "side_of:sB" })],
    } as never);
    const id = await useChatStore.getState().openSidechat("s1");
    expect(id).toBe("sc1");
    expect(openSidechatSession).toHaveBeenCalledWith("s1");
  });

  it("defaults to the active chat when no session id is given", async () => {
    const id = await useChatStore.getState().openSidechat();
    expect(id).toBe("sc1");
    expect(openSidechatSession).toHaveBeenCalledWith("s1");
  });
});
