// Cross-session gate for the app-initiated tool-panel opens:
// `chat:open-preview` (open_file routed a file to the in-app viewer) and
// `chat:open-browser` (the agent opened a page). The tool panel is ONE shared
// surface, so an event from a BACKGROUND chat used to yank the panel to that
// chat's file/page while the user was reading another chat — the other chat's
// work appearing in this one. Both now honor the payload's chatSessionId and
// open only when the producing session is the one the shared UI displays
// (focused split pane, else the active chat) — the same gate onArtifact uses
// for artifact auto-open.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const openBrowserSpy = vi.fn();
vi.mock("../lib/openBrowserPane", () => ({
  openInBrowserPane: (...a: unknown[]) => openBrowserSpy(...a),
}));
vi.mock("../hooks/useTtsAutoRead", () => ({
  autoReadFinishedTurn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/appFocus", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAppFocused: () => true,
}));

const listeners = new Map<string, (p: unknown) => void>();
vi.mock("../lib/ipcCore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tauriRuntimeAvailable: () => false,
  safeInvoke: vi.fn(async (): Promise<null> => null),
  safeListen: vi.fn((event: string, handler: (p: unknown) => void) => {
    listeners.set(event, handler);
    return Promise.resolve(() => {});
  }),
}));

import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";
import { useChatEvents } from "../hooks/useChatEvents";

beforeEach(() => {
  listeners.clear();
  openBrowserSpy.mockClear();
  useChatStore.setState({
    sessions: [] as never,
    activeChatSessionId: "chat-a",
    focusedChatSessionId: null,
    chatPaneTree: null,
    messages: [],
    streaming: {},
    chatStatus: {},
  });
  useUiStore.setState({
    openTabs: [],
    nextTabId: 1,
    activeTabId: null,
    toolPanelTab: "terminal",
    toolPanelCollapsed: true,
  });
});

describe("chat:open-preview cross-session gate", () => {
  it("opens the preview tab when the producing chat is the one on screen", () => {
    renderHook(() => useChatEvents());
    listeners.get("chat:open-preview")!({
      chatSessionId: "chat-a",
      path: "C:/out/report.md",
      filename: "report.md",
    });
    const tabs = useUiStore.getState().openTabs;
    expect(tabs).toHaveLength(1);
    // Tagged as app-opened for chat-a, so a later switch to another chat
    // sweeps it (closeForeignAutoTabs).
    expect(tabs[0].auto).toBe(true);
    expect(tabs[0].chatSessionId).toBe("chat-a");
    expect(useUiStore.getState().toolPanelCollapsed).toBe(false);
  });

  it("ignores a background chat's open_file", () => {
    renderHook(() => useChatEvents());
    listeners.get("chat:open-preview")!({
      chatSessionId: "chat-b",
      path: "C:/out/other-chat-report.md",
      filename: "other-chat-report.md",
    });
    expect(useUiStore.getState().openTabs).toHaveLength(0);
    expect(useUiStore.getState().toolPanelCollapsed).toBe(true);
  });

  it("follows the focused split pane, not just the active chat", () => {
    useChatStore.setState({ focusedChatSessionId: "chat-c" });
    renderHook(() => useChatEvents());
    // chat-c is pinned+focused while chat-a is the global active id: its own
    // file must still open.
    listeners.get("chat:open-preview")!({
      chatSessionId: "chat-c",
      path: "C:/out/pane-report.md",
      filename: "pane-report.md",
    });
    expect(useUiStore.getState().openTabs).toHaveLength(1);
    // …while a non-displayed session stays ignored.
    listeners.get("chat:open-preview")!({
      chatSessionId: "chat-b",
      path: "C:/out/third.md",
      filename: "third.md",
    });
    expect(useUiStore.getState().openTabs).toHaveLength(1);
  });
});

describe("chat:open-browser cross-session gate", () => {
  it("opens the pane for the on-screen chat and ignores a background one", () => {
    renderHook(() => useChatEvents());
    listeners.get("chat:open-browser")!({
      chatSessionId: "chat-b",
      url: "https://example.com/other-chat",
    });
    expect(openBrowserSpy).not.toHaveBeenCalled();

    listeners.get("chat:open-browser")!({
      chatSessionId: "chat-a",
      url: "https://example.com/this-chat",
    });
    expect(openBrowserSpy).toHaveBeenCalledWith("https://example.com/this-chat");
  });
});
