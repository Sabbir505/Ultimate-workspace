// A6 (ISSUES.md): fire-and-forget IPC calls without `.catch` turned any IPC
// failure into an unhandled rejection (crashing the worker / spamming the
// console). Each listed site is exercised with a REJECTING IPC mock; the
// process-level "unhandledRejection" hook must stay silent.
//
// NOTE: vi.fn() mocks attach a noop catch to their rejected results, which
// would make EVERY call look handled. The seams under test therefore use
// plain recording functions returning RAW rejected promises.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Plain function (no vitest mock protection) that records its args and
 *  rejects with a raw Promise rejection. Created inside vi.hoisted so the
 *  hoisted vi.mock factory can reference it. */
const {
  setChatSessionProject,
  setChatSessionUnread,
  setSetting,
  killPty,
  browserClosePane,
  unregisterBrowserPaneProject,
} = vi.hoisted(() => {
  function rejectRecorder() {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
      return Promise.reject(new Error("ipc down"));
    };
    return Object.assign(fn, { calls });
  }
  return {
    setChatSessionProject: rejectRecorder(),
    setChatSessionUnread: rejectRecorder(),
    setSetting: rejectRecorder(),
    killPty: rejectRecorder(),
    browserClosePane: rejectRecorder(),
    unregisterBrowserPaneProject: rejectRecorder(),
  };
});

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setChatSessionProject,
  setChatSessionUnread,
  setSetting,
  killPty,
  browserClosePane,
  unregisterBrowserPaneProject,
  // Non-asserted seams used by the stores under test.
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  listChatCheckpoints: vi.fn().mockResolvedValue([]),
  listChatSessions: vi.fn().mockResolvedValue([]),
  getChatSessionMetrics: vi.fn().mockResolvedValue(null),
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  cancelChatMessage: vi.fn().mockResolvedValue(undefined),
  cancelAgentChatMessage: vi.fn().mockResolvedValue(undefined),
  generateChatTitle: vi.fn().mockResolvedValue(null),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  loopSessionStart: vi.fn().mockResolvedValue(null),
  loopSessionAdvance: vi.fn().mockResolvedValue(undefined),
  loopSessionFinish: vi.fn().mockResolvedValue(undefined),
  finishArtifactRuns: vi.fn().mockResolvedValue(0),
  getSetting: vi.fn().mockResolvedValue(null),
}));

import { useChatStore } from "../state/chat";
import { usePanesStore } from "../state/panes";
import { useSettingsStore } from "../state/settings";

let unhandled: unknown[] = [];
let onUnhandled: (reason: unknown) => void = () => {};

const settle = () => new Promise((r) => setTimeout(r, 100));

beforeEach(() => {
  unhandled = [];
  onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  usePanesStore.setState({ panes: [], focusedPaneId: null, useCounter: 1 });
  useChatStore.setState({ sessions: [], activeChatSessionId: null, streaming: {}, streamingChatSessionId: null, messageQueue: {}, sessionProjects: {}, cwdOverrides: {} });
  useSettingsStore.setState({ browserPaneState: { paneTabs: {} } });
});

describe("A6: fire-and-forget IPC failures are swallowed, not unhandled", () => {
  it("chat.unbindProject survives a rejecting setChatSessionProject", async () => {
    useChatStore.setState({
      sessions: [{ id: "s1", title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 } as never],
      activeChatSessionId: "s1",
      sessionProjects: { s1: "p1" },
      cwdOverrides: { s1: "D:/x" },
    });

    useChatStore.getState().unbindProject("s1");
    await settle();

    expect(setChatSessionProject.calls).toEqual([["s1", null]]);
    expect(unhandled).toHaveLength(0);
    // The local (authoritative) state still cleared.
    expect(useChatStore.getState().sessionProjects.s1).toBeUndefined();
  });

  it("chat.selectSession survives a rejecting setChatSessionUnread", async () => {
    useChatStore.setState({
      sessions: [{ id: "s1", title: "t", provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0, unread: true } as never],
      activeChatSessionId: null,
      messagesSessionId: null,
    });

    await useChatStore.getState().selectSession("s1");

    expect(setChatSessionUnread.calls).toEqual([["s1", false]]);
    expect(unhandled).toHaveLength(0);
  });

  it("panes closePane survives rejecting killPty (terminal) and browserClosePane (browser)", async () => {
    usePanesStore.setState({
      useCounter: 3,
      panes: [
        { paneId: "term-1", state: "idle", lastUsedAt: 1, lastInputAt: 0, activity: null, data: { kind: "terminal", sessionId: null, harness: null, label: "sh", spawn: { type: "shell", cwd: "D:/x", command: "sh" }, exited: false, exitCode: null } } as never,
        { paneId: "web-1", state: "idle", lastUsedAt: 2, lastInputAt: 0, activity: null, data: { kind: "browser", url: "https://x", projectId: null, collapsed: false, tabs: [{ tabId: "t", url: "https://x", title: "" }], activeTabIndex: 0 } } as never,
      ],
    });

    usePanesStore.getState().closePane("term-1");
    usePanesStore.getState().closePane("web-1");
    await settle();

    expect(killPty.calls).toEqual([["term-1"]]);
    expect(browserClosePane.calls).toEqual([["web-1"]]);
    expect(unhandled).toHaveLength(0);
  });

  it("ipc.writePtySubmit survives rejecting writePty (both the text and the delayed Enter write)", async () => {
    // writePtySubmit closes over the module-internal writePty, so mocking the
    // export can't intercept it. Simulate the real rejection path instead:
    // a present Tauri runtime whose invoke always rejects.
    let writeCalls = 0;
    const prevInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: (...args: unknown[]) => {
        if (args[0] === "write_pty") writeCalls++;
        return Promise.reject(new Error("tauri down"));
      },
      transformCallback: () => 1,
    };
    try {
      const { writePtySubmit } = await import("../lib/ipc");
      writePtySubmit("pane-1", "hello");
      // The standalone Enter write fires 250ms later.
      await new Promise((r) => setTimeout(r, 350));

      expect(writeCalls).toBe(2);
      expect(unhandled).toHaveLength(0);
    } finally {
      if (prevInternals === undefined) {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      } else {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = prevInternals;
      }
    }
  }, 10000);

  it("settings persists survive a rejecting setSetting", async () => {
    useSettingsStore.getState().setTheme("dark");
    useSettingsStore.getState().setDnd(true);
    await settle();

    expect(setSetting.calls.length).toBeGreaterThanOrEqual(3); // theme + customThemeId + dnd
    expect(unhandled).toHaveLength(0);
  });
});
