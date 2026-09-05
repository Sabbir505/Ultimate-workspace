// Phase 0 of auto model routing — the "re-choose a model every launch" fix.
//
// Every committed composer pick (builtin, harness, ACP, local — including the
// Settings "Use this model" flow) must persist a `chat.last_selection` blob,
// and every new-chat entry point must seed from it: provider + model AND the
// agent, so a fresh chat opens ready-to-send on what the user last used
// instead of falling back to a keyless provider with an empty model.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  // Worktree gate ("false" skips ensure entirely) and the last_selection
  // blob both ride getSetting/setSetting.
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
  getChatConfig: vi.fn().mockResolvedValue(null),
  createChatSession: vi.fn(),
  listChatSessions: vi.fn().mockResolvedValue([]),
  updateChatSessionAgent: vi.fn().mockResolvedValue(undefined),
  updateChatSessionProvider: vi.fn().mockResolvedValue(undefined),
  updateChatSessionModel: vi.fn().mockResolvedValue(undefined),
  setChatSessionPermissionMode: vi.fn().mockResolvedValue(undefined),
  cancelAgentChatMessage: vi.fn().mockResolvedValue(undefined),
}));

import {
  createChatSession,
  getChatConfig,
  getSetting,
  setChatSessionPermissionMode,
  setSetting,
  updateChatSessionAgent,
} from "../lib/ipc";
import { seedSelectionFrom } from "../lib/lastSelection";
import { useChatStore } from "../state/chat";

function seedActiveEmptyChat(id: string) {
  useChatStore.setState({
    sessions: [
      {
        id,
        title: "t",
        provider: "openai_compatible",
        model: "",
        createdAt: 0,
        lastActiveAt: 0,
        agent: null,
      } as never,
    ],
    activeChatSessionId: id,
    // Empty buffer OWNED by the active session → newChat takes the reuse path.
    messages: [],
    messagesSessionId: id,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSetting).mockResolvedValue(null);
  useChatStore.setState({
    sessions: [],
    activeChatSessionId: null,
    messages: [],
    messagesSessionId: null,
    sessionProjects: {},
    config: null,
    lastSelection: null,
  });
});

describe("seedSelectionFrom", () => {
  it("prefers the last selection over the legacy config", () => {
    expect(
      seedSelectionFrom(
        { agent: "harness:claude_code", provider: null, model: "claude-sonnet-4-5" },
        { provider: "openai", model: "gpt-4o" },
      ),
    ).toEqual({
      provider: "openai", // harness picks carry no provider — keep the config default
      model: "claude-sonnet-4-5",
      agent: "harness:claude_code",
    });
  });

  it("keeps a local pick intact — the send path auto-warms a dead sidecar", () => {
    expect(
      seedSelectionFrom(
        { agent: "local", provider: "local_gguf", model: "Qwen3-8B-Q4_K_M.gguf" },
        null,
      ),
    ).toEqual({ provider: "local_gguf", model: "Qwen3-8B-Q4_K_M.gguf", agent: "local" });
  });

  it("falls back to the legacy config when nothing was ever picked", () => {
    expect(seedSelectionFrom(null, { provider: "anthropic", model: "claude-x" })).toEqual({
      provider: "anthropic",
      model: "claude-x",
      agent: null,
    });
    // No config either (fresh install): the old keyless openai_compatible seed.
    expect(seedSelectionFrom(null, null)).toEqual({
      provider: "openai_compatible",
      model: "",
      agent: null,
    });
  });
});

describe("rememberSelection", () => {
  it("updates state and persists the blob", async () => {
    useChatStore.getState().rememberSelection({
      agent: "builtin",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
    });
    expect(useChatStore.getState().lastSelection).toEqual({
      agent: "builtin",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
    });
    await vi.waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith(
        "chat.last_selection",
        JSON.stringify({ agent: "builtin", provider: "openrouter", model: "anthropic/claude-sonnet-4.5" }),
      );
    });
  });

  it("survives a persist failure — the in-memory value still seeds this run", async () => {
    vi.mocked(setSetting).mockRejectedValueOnce(new Error("db locked"));
    useChatStore.getState().rememberSelection({ agent: "local", provider: "local_gguf", model: "m.gguf" });
    expect(useChatStore.getState().lastSelection?.model).toBe("m.gguf");
    await vi.waitFor(() => expect(setSetting).toHaveBeenCalled());
  });
});

describe("loadConfig", () => {
  it("loads the config and the last selection together", async () => {
    vi.mocked(getChatConfig).mockResolvedValue({
      provider: "anthropic",
      baseUrl: null,
      model: "claude-x",
      hasKey: true,
    } as never);
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "chat.last_selection"
        ? JSON.stringify({ agent: "builtin", provider: "anthropic", model: "claude-x" })
        : null,
    );
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().lastSelection).toEqual({
      agent: "builtin",
      provider: "anthropic",
      model: "claude-x",
    });
  });

  it("treats a corrupt blob as no selection instead of throwing", async () => {
    vi.mocked(getSetting).mockResolvedValue("{not json");
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().lastSelection).toBeNull();
  });
});

describe("newChat agent seeding", () => {
  it("applies the seeded agent on the create path (harness gets permission-mode init)", async () => {
    vi.mocked(createChatSession).mockImplementation(async (provider, model) => ({
      id: "fresh",
      title: null,
      provider,
      model,
      createdAt: 0,
      lastActiveAt: 0,
      agent: null,
    } as never));

    const session = await useChatStore
      .getState()
      .newChat("openai_compatible", "claude-sonnet-4-5", undefined, "harness:claude_code");

    expect(updateChatSessionAgent).toHaveBeenCalledWith("fresh", "harness:claude_code");
    expect(setChatSessionPermissionMode).toHaveBeenCalled(); // harness posture init
    expect(session?.agent).toBe("harness:claude_code");
    expect(useChatStore.getState().sessions.find((s) => s.id === "fresh")?.agent).toBe(
      "harness:claude_code",
    );
  });

  it("does NOT duplicate the session when a background relist lands during the agent apply", async () => {
    // Regression: the seeded-agent apply is an awaited IPC round-trip. A
    // relist (loadSessions after the empty-chat sweep, onDone's
    // touch-then-relist) can land inside it and already include the new row;
    // prepending afterwards used to create TWO copies — the React
    // duplicate-key warning in the sidebar, and sessions.find returning the
    // STALE copy (old provider/model) so the chip ignored the Auto pick.
    vi.mocked(createChatSession).mockImplementation(async (provider, model) => {
      const row = {
        id: "fresh",
        title: null,
        provider,
        model,
        createdAt: 0,
        lastActiveAt: 0,
        agent: null,
      } as never;
      // Simulate: the agent-apply IPC below resolves AFTER a wholesale
      // relist has already replaced the list with backend data (which
      // contains the new session).
      return row;
    });
    vi.mocked(updateChatSessionAgent).mockImplementation(async () => {
      // Wholesale relist landing mid-await (loadSessions / onDone relist):
      // the backend already has the row (the INSERT committed), so the
      // relist REPLACES the store list with a backend-shaped copy — with the
      // agent still null if it read before the agent UPDATE committed. In
      // the buggy ordering (insert AFTER this await) the insert then
      // prepended a second copy.
      useChatStore.setState((s) => ({
        sessions: [
          ...s.sessions.filter((x) => x.id !== "fresh"),
          {
            id: "fresh",
            title: null,
            provider: "openai_compatible",
            model: "claude-sonnet-4-5",
            createdAt: 0,
            lastActiveAt: 0,
            agent: null,
          } as never,
        ],
      }));
    });

    await useChatStore
      .getState()
      .newChat("openai_compatible", "claude-sonnet-4-5", undefined, "builtin");

    const rows = useChatStore.getState().sessions.filter((s) => s.id === "fresh");
    expect(rows).toHaveLength(1);
    expect(useChatStore.getState().activeChatSessionId).toBe("fresh");
  });

  it("re-targets an existing empty chat's agent on the reuse path", async () => {
    seedActiveEmptyChat("empty");
    await useChatStore
      .getState()
      .newChat("openai_compatible", "gpt-4o", undefined, "local");
    expect(updateChatSessionAgent).toHaveBeenCalledWith("empty", "local");
    expect(useChatStore.getState().sessions.find((s) => s.id === "empty")?.agent).toBe("local");
    // No duplicate session was created.
    expect(createChatSession).not.toHaveBeenCalled();
  });

  it("leaves the agent alone when no seed agent is passed (legacy callers)", async () => {
    seedActiveEmptyChat("empty");
    await useChatStore.getState().newChat("openai_compatible", "gpt-4o");
    expect(updateChatSessionAgent).not.toHaveBeenCalled();
  });
});
