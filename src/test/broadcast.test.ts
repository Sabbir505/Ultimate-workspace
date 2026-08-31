// Team broadcast (roadmap #18): broadcastToSessions sends one prompt to N
// sessions — the active session via sendMessage, background sessions via
// direct per-session sends that mark them streaming concurrently.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendChatMessageMock = vi.fn();
const sendAgentChatMessageMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  sendChatMessage: (...a: unknown[]) => sendChatMessageMock(...a),
  sendAgentChatMessage: (...a: unknown[]) => sendAgentChatMessageMock(...a),
  toastError: vi.fn(),
  // The store imports several other ipc members at module load; stub them so
  // the store module evaluates without a Tauri runtime.
  getChatMessages: vi.fn(),
  listChatSessions: vi.fn(),
  getChatConfig: vi.fn(),
  safeListen: vi.fn(() => Promise.resolve(() => {})),
}));

import { useChatStore } from "../state/chat";
import type { ChatSession } from "../lib/ipc";

const session = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    title: `chat ${id}`,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    createdAt: 1,
    lastActiveAt: 2,
    ...over,
  }) as ChatSession;

beforeEach(() => {
  vi.clearAllMocks();
  sendChatMessageMock.mockResolvedValue(undefined);
  sendAgentChatMessageMock.mockResolvedValue(undefined);
});

afterEach(() => {
  useChatStore.setState({
    sessions: [],
    activeChatSessionId: null,
    streaming: {},
    chatStatus: {},
    messageQueue: {},
    pendingArtifacts: {},
    // The tools-flags test flips these; restore the store defaults (true/true)
    // so the flip cannot leak into other tests in this file.
    toolsEnabled: true,
    codeExecEnabled: true,
  });
});

describe("broadcastToSessions", () => {
  it("sends to background sessions directly and marks each streaming", async () => {
    useChatStore.setState({
      activeChatSessionId: "a",
      sessions: [session("a"), session("b"), session("c")],
      streaming: {},
    });
    const sendMessage = vi.spyOn(useChatStore.getState(), "sendMessage").mockResolvedValue(undefined);

    await useChatStore.getState().broadcastToSessions(["a", "b", "c"], "hello team");

    // Active session went through the normal send path.
    expect(sendMessage).toHaveBeenCalledWith("hello team", undefined, undefined);
    // Background sessions got direct sends — carrying the store's tool flags
    // (audit B-22: omitted flags map to `false` in ipc.ts, which silently
    // disabled tools for every background target).
    expect(sendChatMessageMock).toHaveBeenCalledWith("b", "hello team", undefined, true, true, undefined, undefined, undefined, undefined);
    expect(sendChatMessageMock).toHaveBeenCalledWith("c", "hello team", undefined, true, true, undefined, undefined, undefined, undefined);
    // Both are marked streaming (session-keyed, concurrent).
    const s = useChatStore.getState();
    expect("b" in s.streaming).toBe(true);
    expect("c" in s.streaming).toBe(true);
  });

  it("routes a background harness session through sendAgentChatMessage", async () => {
    useChatStore.setState({
      activeChatSessionId: "a",
      sessions: [session("a"), session("h", { agent: "harness:claude_code" })],
    });
    await useChatStore.getState().broadcastToSessions(["h"], "run tests");
    expect(sendAgentChatMessageMock).toHaveBeenCalledWith(
      "h", "run tests", "claude_code", "claude-sonnet-4-5", undefined, undefined,
    );
  });

  it("skips unknown and already-streaming sessions", async () => {
    useChatStore.setState({
      activeChatSessionId: "a",
      sessions: [session("a")],
      streaming: { busy: "" },
    });
    await useChatStore.getState().broadcastToSessions(["ghost", "busy", "a"], "x");
    expect(sendChatMessageMock).not.toHaveBeenCalled();
  });

  it("clears streaming state when a background send fails", async () => {
    useChatStore.setState({
      activeChatSessionId: "a",
      sessions: [session("a"), session("b")],
    });
    sendChatMessageMock.mockRejectedValue(new Error("boom"));
    await useChatStore.getState().broadcastToSessions(["b"], "hello");
    expect("b" in useChatStore.getState().streaming).toBe(false);
  });

  it("passes the store's current toolsEnabled/codeExecEnabled to background sessions (audit B-22)", async () => {
    // Store defaults: tools + code exec ON — background targets must get the
    // same flags the single-session sendMessage path uses, not `false`.
    useChatStore.setState({
      activeChatSessionId: "a",
      sessions: [session("a"), session("b")],
      streaming: {},
    });
    await useChatStore.getState().broadcastToSessions(["b"], "hello");
    expect(sendChatMessageMock).toHaveBeenCalledWith("b", "hello", undefined, true, true, undefined, undefined, undefined, undefined);

    // A user who toggled tools off broadcasts that posture too.
    sendChatMessageMock.mockClear();
    // Reset streaming: the first broadcast left "b" marked streaming, and
    // broadcastToSessions skips in-flight sessions.
    useChatStore.setState({ toolsEnabled: false, codeExecEnabled: false, streaming: {} });
    await useChatStore.getState().broadcastToSessions(["b"], "hello again");
    expect(sendChatMessageMock).toHaveBeenCalledWith("b", "hello again", undefined, false, false, undefined, undefined, undefined, undefined);
  });
});
