// Auto mode store plumbing: setSessionAuto flips the persisted flag + the
// in-memory mirror, and a manual pick path (setSessionProvider) coexists
// with it. The backend owns resolution; the store only tracks the mode.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  setChatSessionAuto: vi.fn().mockResolvedValue(undefined),
  updateChatSessionProvider: vi.fn().mockResolvedValue(undefined),
  updateChatSessionModel: vi.fn().mockResolvedValue(undefined),
  setChatDefaultModel: vi.fn().mockResolvedValue(undefined),
}));

import { setChatSessionAuto } from "../lib/ipc";
import { useChatStore } from "../state/chat";

function seed(id: string, autoModel = false, provider = "anthropic") {
  useChatStore.setState({
    sessions: [
      {
        id,
        title: "t",
        provider,
        model: autoModel ? "auto" : "claude-x",
        createdAt: 0,
        lastActiveAt: 0,
        agent: "builtin",
        autoModel,
      } as never,
    ],
    activeChatSessionId: id,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ sessions: [], activeChatSessionId: null });
});

describe("setSessionAuto", () => {
  it("entering Auto persists the flag and resets provider/model to placeholders", async () => {
    seed("s1");
    await useChatStore.getState().setSessionAuto("s1", true);
    expect(setChatSessionAuto).toHaveBeenCalledWith("s1", true);
    const s = useChatStore.getState().sessions.find((x) => x.id === "s1");
    expect(s?.autoModel).toBe(true);
    expect(s?.provider).toBe("auto");
    expect(s?.model).toBe("auto");
  });

  it("leaving Auto clears the flag but leaves provider/model for the manual pick to overwrite", async () => {
    seed("s1", true, "auto");
    await useChatStore.getState().setSessionAuto("s1", false);
    expect(setChatSessionAuto).toHaveBeenCalledWith("s1", false);
    const s = useChatStore.getState().sessions.find((x) => x.id === "s1");
    expect(s?.autoModel).toBe(false);
    expect(s?.provider).toBe("auto"); // the pick flow overwrites it next
  });
});
