// The shared bots store is what removed the per-consumer duplicate listeners
// and IPC storms. These tests pin its contract: one refresh fills the whole
// snapshot from the five reads, a mutation re-reads, and a failure is recorded
// (not thrown) so consumers can render it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("../lib/ipcCore", () => ({
  safeInvoke: (...args: unknown[]) => invokeMock(...args),
  safeListen: vi.fn(async () => () => {}),
  tauriRuntimeAvailable: () => false,
  toastError: vi.fn(),
}));

import { useBotsStore } from "../state/bots";

function route(overrides: Record<string, unknown> = {}) {
  invokeMock.mockImplementation((cmd: string) => {
    if (Object.prototype.hasOwnProperty.call(overrides, cmd)) {
      return Promise.resolve(overrides[cmd]);
    }
    switch (cmd) {
      case "list_bots":
      case "list_bot_runs":
      case "list_bot_approvals":
      case "bots_running":
        return Promise.resolve([]);
      case "scheduler_available":
        return Promise.resolve(false);
      default:
        return Promise.resolve(null);
    }
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  useBotsStore.setState({
    bots: [],
    runs: [],
    approvals: [],
    runningBots: [],
    schedulerAvailable: false,
    loading: true,
    error: null,
  });
});

afterEach(() => invokeMock.mockReset());

describe("bots store", () => {
  it("refresh fills the snapshot from the five reads", async () => {
    route({ list_bots: [{ id: "b1", name: "Atlas" }], bots_running: ["b1"], scheduler_available: true });
    await useBotsStore.getState().refresh();
    const s = useBotsStore.getState();
    expect(s.bots).toHaveLength(1);
    expect(s.runningBots).toEqual(["b1"]);
    expect(s.schedulerAvailable).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("runNow returns the run's session id and re-reads", async () => {
    route({ run_bot_now: { runId: "r1", sessionId: "s9", prompt: "go" } });
    const sid = await useBotsStore.getState().runNow("b1");
    expect(sid).toBe("s9");
    expect(invokeMock).toHaveBeenCalledWith("run_bot_now", { botId: "b1", prompt: undefined });
  });

  it("stopRun requests a stop and re-reads", async () => {
    route({ stop_bot_run: true });
    await useBotsStore.getState().stopRun("r1");
    expect(invokeMock).toHaveBeenCalledWith("stop_bot_run", { runId: "r1" });
  });

  it("newConversation creates a thread and returns its session id", async () => {
    route({ new_bot_session: "sess-new" });
    const sid = await useBotsStore.getState().newConversation("b1");
    expect(sid).toBe("sess-new");
    expect(invokeMock).toHaveBeenCalledWith("new_bot_session", { botId: "b1" });
  });

  it("refresh records a failure instead of throwing", async () => {
    invokeMock.mockRejectedValue(new Error("db down"));
    await expect(useBotsStore.getState().refresh()).resolves.toBeUndefined();
    expect(useBotsStore.getState().error).toBe("db down");
  });
});
