// Tests for the chat store changes in this round:
// 1. Canvas multi-tab state (previewArtifacts + activePreviewPath): open-or-focus
//    semantics, close-with-neighbor-activation.
// 2. Artifact chips for background chats: onDone must attribute pending
//    artifacts to the last assistant message even when that session is NOT the
//    one being viewed (previously silently discarded).
// 3. Client-side derived title: sendMessage fills in a title for an untitled
//    session via update_chat_session_title WITHOUT marking it manually renamed,
//    so the LLM generateChatTitle refinement still fires on turn 1/3.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  listChatSessions: vi.fn().mockResolvedValue([]),
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn(),
  generateChatTitle: vi.fn().mockResolvedValue(null),
  getChatConfig: vi.fn(),
  sendChatMessage: vi.fn().mockResolvedValue(undefined),
  setChatApiKey: vi.fn(),
  deleteChatApiKey: vi.fn(),
  setChatSessionStarred: vi.fn(),
  setChatSessionUnread: vi.fn().mockResolvedValue(undefined),
  updateChatSessionModel: vi.fn(),
  updateChatSessionTitle: vi.fn().mockResolvedValue(undefined),
  updateChatSessionWatchMode: vi.fn(),
  cancelChatMessage: vi.fn(),
}));

import { generateChatTitle, getChatMessages, updateChatSessionTitle } from "../lib/ipc";
import { useChatStore } from "../state/chat";

function session(id: string, title: string | null = null) {
  return { id, title, provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never;
}

function assistantMsg(id: number, chatSessionId: string) {
  return {
    id,
    chatSessionId,
    role: "assistant",
    content: "done",
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt: 0,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    sessions: [],
    activeChatSessionId: null,
    messages: [],
    streaming: {},
    streamingChatSessionId: null,
    artifactsByMessage: {},
    pendingArtifacts: {},
    previewArtifacts: [],
    activePreviewPath: null,
  });
});

describe("Canvas multi-tab preview state", () => {
  const a1 = { path: "/tmp/a.py", filename: "a.py" };
  const a2 = { path: "/tmp/b.md", filename: "b.md" };
  const a3 = { path: "/tmp/c.csv", filename: "c.csv" };

  it("opens artifacts as tabs and focuses the newest one", () => {
    const s = useChatStore.getState();
    s.setPreviewArtifact(a1);
    s.setPreviewArtifact(a2);
    const now = useChatStore.getState();
    expect(now.previewArtifacts).toEqual([a1, a2]);
    expect(now.activePreviewPath).toBe(a2.path);
  });

  it("re-opening an existing artifact focuses it instead of duplicating", () => {
    const s = useChatStore.getState();
    s.setPreviewArtifact(a1);
    s.setPreviewArtifact(a2);
    s.setPreviewArtifact(a1);
    const now = useChatStore.getState();
    expect(now.previewArtifacts).toEqual([a1, a2]);
    expect(now.activePreviewPath).toBe(a1.path);
  });

  it("null closes all tabs", () => {
    const s = useChatStore.getState();
    s.setPreviewArtifact(a1);
    s.setPreviewArtifact(null);
    const now = useChatStore.getState();
    expect(now.previewArtifacts).toEqual([]);
    expect(now.activePreviewPath).toBeNull();
  });

  it("closing the focused middle tab activates the neighbor in its slot", () => {
    const s = useChatStore.getState();
    s.setPreviewArtifact(a1);
    s.setPreviewArtifact(a2);
    s.setPreviewArtifact(a3);
    s.setPreviewArtifact(a2); // focus middle
    useChatStore.getState().closePreviewArtifact(a2.path);
    const now = useChatStore.getState();
    expect(now.previewArtifacts.map((a) => a.path)).toEqual([a1.path, a3.path]);
    expect(now.activePreviewPath).toBe(a3.path);
  });

  it("closing the focused last tab activates the new last tab", () => {
    const s = useChatStore.getState();
    s.setPreviewArtifact(a1);
    s.setPreviewArtifact(a2);
    useChatStore.getState().closePreviewArtifact(a2.path);
    expect(useChatStore.getState().activePreviewPath).toBe(a1.path);
  });

  it("closing a background tab keeps the focused tab", () => {
    const s = useChatStore.getState();
    s.setPreviewArtifact(a1);
    s.setPreviewArtifact(a2);
    useChatStore.getState().closePreviewArtifact(a1.path);
    const now = useChatStore.getState();
    expect(now.previewArtifacts.map((a) => a.path)).toEqual([a2.path]);
    expect(now.activePreviewPath).toBe(a2.path);
  });

  it("closing the only tab leaves no focused tab", () => {
    const s = useChatStore.getState();
    s.setPreviewArtifact(a1);
    useChatStore.getState().closePreviewArtifact();
    const now = useChatStore.getState();
    expect(now.previewArtifacts).toEqual([]);
    expect(now.activePreviewPath).toBeNull();
  });
});

describe("onDone artifact attribution for background chats", () => {
  it("attributes pending artifacts to the last assistant message even when viewing another chat", async () => {
    useChatStore.setState({
      sessions: [session("sess-A"), session("sess-B")],
      activeChatSessionId: "sess-A", // user is viewing A…
      pendingArtifacts: { "sess-B": [{ path: "/tmp/out.py", filename: "out.py" }] },
      messages: [assistantMsg(1, "sess-A")],
    });
    vi.mocked(getChatMessages).mockResolvedValueOnce([
      assistantMsg(41, "sess-B"),
      assistantMsg(42, "sess-B"),
    ] as never);

    await useChatStore.getState().onDone("sess-B", 1, 1, null);

    const now = useChatStore.getState();
    // Chips attributed to B's last assistant message despite B being inactive…
    expect(now.artifactsByMessage[42]).toEqual([{ path: "/tmp/out.py", filename: "out.py" }]);
    // …while the visible message list stays on session A.
    expect(now.messages).toEqual([assistantMsg(1, "sess-A")]);
    // Buffer cleared either way.
    expect(now.pendingArtifacts["sess-B"]).toBeUndefined();
  });

  it("keeps the active-session behavior unchanged", async () => {
    useChatStore.setState({
      sessions: [session("sess-A")],
      activeChatSessionId: "sess-A",
      pendingArtifacts: { "sess-A": [{ path: "/tmp/out.py", filename: "out.py" }] },
      messages: [],
    });
    const msgs = [assistantMsg(7, "sess-A")];
    vi.mocked(getChatMessages).mockResolvedValueOnce(msgs as never);

    await useChatStore.getState().onDone("sess-A", 1, 1, null);

    const now = useChatStore.getState();
    expect(now.artifactsByMessage[7]).toEqual([{ path: "/tmp/out.py", filename: "out.py" }]);
    expect(now.messages).toEqual(msgs);
  });
});

describe("sendMessage derived title", () => {
  it("titles an untitled session from the first user message (without blocking auto-titling)", async () => {
    useChatStore.setState({
      sessions: [session("sess-A", null)],
      activeChatSessionId: "sess-A",
      messages: [],
    });

    await useChatStore.getState().sendMessage("fix the auth middleware");

    const now = useChatStore.getState();
    expect(now.sessions[0].title).toBe("fix the auth middleware");
    expect(updateChatSessionTitle).toHaveBeenCalledWith("sess-A", "fix the auth middleware");

    // The derived title must NOT count as a manual rename: the LLM
    // generateChatTitle refinement still fires on the first completed turn.
    vi.mocked(getChatMessages).mockResolvedValueOnce([assistantMsg(9, "sess-A")] as never);
    await useChatStore.getState().onDone("sess-A", 1, 1, null);
    expect(generateChatTitle).toHaveBeenCalledWith("sess-A");
  });

  it("truncates long prompts to ~40 chars with an ellipsis", async () => {
    useChatStore.setState({
      sessions: [session("sess-A", "")],
      activeChatSessionId: "sess-A",
      messages: [],
    });

    await useChatStore
      .getState()
      .sendMessage("please refactor the entire authentication middleware layer to support token refresh");

    const title = useChatStore.getState().sessions[0].title!;
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(41);
  });

  it("does not overwrite an existing title", async () => {
    useChatStore.setState({
      sessions: [session("sess-A", "My chat")],
      activeChatSessionId: "sess-A",
      messages: [],
    });

    await useChatStore.getState().sendMessage("something else entirely");

    expect(useChatStore.getState().sessions[0].title).toBe("My chat");
    expect(updateChatSessionTitle).not.toHaveBeenCalled();
  });
});
