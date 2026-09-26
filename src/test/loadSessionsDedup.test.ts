// loadSessions dedups CONCURRENT calls: Sidebar, ProjectsSidebar and ChatView
// all fire it on mount when !loaded, which used to be three identical
// listChatSessions IPC calls on every boot. Sequential calls must still
// refetch — the post-mutation relists (selectSession's touch-then-relist,
// deleteChat's sweep) depend on that.
import { beforeEach, describe, expect, it, vi } from "vitest";

const listChatSessionsMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  listChatSessions: (...a: unknown[]) => listChatSessionsMock(...a),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  listChatCheckpoints: vi.fn().mockResolvedValue([]),
  getChatSessionMetrics: vi.fn().mockResolvedValue(null),
}));

import { useChatStore } from "../state/chat";

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    loaded: false,
    sessions: [],
    sessionProjects: {},
    cwdOverrides: {},
  });
});

describe("loadSessions concurrent dedup", () => {
  it("shares one fetch between concurrent calls", async () => {
    let resolveFetch!: (v: unknown[]) => void;
    listChatSessionsMock.mockReturnValue(
      new Promise((r) => {
        resolveFetch = r;
      }),
    );
    const a = useChatStore.getState().loadSessions();
    const b = useChatStore.getState().loadSessions();
    resolveFetch([
      { id: "s1", title: "t", provider: "p", model: "m", createdAt: 0, lastActiveAt: 0 },
    ]);
    await Promise.all([a, b]);
    expect(listChatSessionsMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().loaded).toBe(true);
    expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("refetches on sequential calls", async () => {
    listChatSessionsMock.mockResolvedValue([]);
    await useChatStore.getState().loadSessions();
    await useChatStore.getState().loadSessions();
    expect(listChatSessionsMock).toHaveBeenCalledTimes(2);
  });
});
