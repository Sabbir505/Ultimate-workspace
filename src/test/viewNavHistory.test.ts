// View + chat back/forward history (browser-style navigation) driven by
// setActiveView / recordChatNav and consumed by the sidebar header arrows +
// collapsed-rail arrows (via useViewNav, which restores the entry's chat).
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../state/ui";

const entry = (view: "chat" | "settings" | "skills" | "cost", chatSessionId: string | null = null) => ({
  view,
  chatSessionId,
});

describe("view nav history", () => {
  beforeEach(() => {
    useUiStore.setState({
      activeView: "chat",
      baseView: "chat",
      viewHistory: [entry("chat")],
      viewIndex: 0,
    });
  });

  it("pushes visited views and truncates the forward branch on a new jump", () => {
    const { setActiveView, navBack, navForward } = useUiStore.getState();
    setActiveView("settings");
    setActiveView("skills");
    expect(useUiStore.getState().viewHistory).toEqual([
      entry("chat"),
      entry("settings"),
      entry("skills"),
    ]);
    expect(useUiStore.getState().viewIndex).toBe(2);

    // Back twice lands on chat; going back further is clamped.
    navBack();
    navBack();
    expect(useUiStore.getState().activeView).toBe("chat");
    expect(useUiStore.getState().viewIndex).toBe(0);
    useUiStore.getState().navBack();
    expect(useUiStore.getState().viewIndex).toBe(0);

    // A new navigation from the middle of history drops "forward" entries.
    const set = useUiStore.getState().setActiveView;
    set("cost");
    expect(useUiStore.getState().viewHistory).toEqual([entry("chat"), entry("cost")]);
    expect(useUiStore.getState().activeView).toBe("cost");
    // Forward branch is gone — navForward is a no-op past the end.
    const endIdx = useUiStore.getState().viewIndex;
    useUiStore.getState().navForward();
    expect(useUiStore.getState().viewIndex).toBe(endIdx);
  });

  it("navForward replays the branch until the end and no-ops past it", () => {
    const state = useUiStore.getState();
    state.setActiveView("settings");
    state.setActiveView("cost");
    useUiStore.setState({ viewIndex: 0 });
    const fwd = useUiStore.getState().navForward;
    fwd();
    expect(useUiStore.getState().activeView).toBe("settings");
    fwd();
    expect(useUiStore.getState().activeView).toBe("cost");
    const end = useUiStore.getState().viewIndex;
    fwd(); // already at the end — clamped no-op
    expect(useUiStore.getState().viewIndex).toBe(end);
  });

  it("re-selecting the current view does not create duplicate entries", () => {
    const set = useUiStore.getState().setActiveView;
    set("chat"); // same as current
    expect(useUiStore.getState().viewHistory).toEqual([entry("chat")]);
    set("settings");
    set("settings");
    expect(useUiStore.getState().viewHistory).toEqual([entry("chat"), entry("settings")]);
  });

  it("records chat switches in the same timeline as views", () => {
    const { recordChatNav, setActiveView, navBack } = useUiStore.getState();
    // Switching chats pushes chat-bearing entries.
    recordChatNav("a");
    recordChatNav("b");
    expect(useUiStore.getState().viewHistory).toEqual([entry("chat", "a"), entry("chat", "b")]);
    expect(useUiStore.getState().viewIndex).toBe(1);

    // A view visit is recorded too; Back from it returns to the chat entry.
    setActiveView("settings");
    expect(useUiStore.getState().viewHistory).toEqual([
      entry("chat", "a"),
      entry("chat", "b"),
      entry("settings"),
    ]);
    const landed = navBack();
    expect(landed).toEqual(entry("chat", "b"));
    expect(useUiStore.getState().activeView).toBe("chat");
  });

  it("replaces a chat-less chat-view top entry (boot auto-start) instead of pushing", () => {
    const { recordChatNav } = useUiStore.getState();
    // Boot: the initial entry names no session; the auto-started chat takes
    // its place so Back isn't a dead step at startup.
    recordChatNav("auto");
    expect(useUiStore.getState().viewHistory).toEqual([entry("chat", "auto")]);
    expect(useUiStore.getState().viewIndex).toBe(0);
    // Re-recording the same chat is not a navigation.
    recordChatNav("auto");
    expect(useUiStore.getState().viewHistory).toEqual([entry("chat", "auto")]);
  });

  it("a chat picked from a non-chat view pushes a chat entry", () => {
    useUiStore.getState().setActiveView("settings");
    useUiStore.getState().recordChatNav("a");
    expect(useUiStore.getState().viewHistory).toEqual([
      entry("chat"),
      entry("settings"),
      entry("chat", "a"),
    ]);
    expect(useUiStore.getState().viewIndex).toBe(2);
  });
});

// Overlays (settings/skills/cost) float above the real view; closing one
// must restore what was actually underneath — opening settings from the
// vault used to dump the user on the chat (2026-09-20 report).
describe("overlay open/close (baseView)", () => {
  beforeEach(() => {
    useUiStore.setState({
      activeView: "chat",
      baseView: "chat",
      viewHistory: [{ view: "chat", chatSessionId: null }],
      viewIndex: 0,
    });
  });

  it("closing settings from the vault returns to the vault, not chat", () => {
    const { setActiveView, closeOverlay } = useUiStore.getState();
    setActiveView("vault");
    expect(useUiStore.getState().baseView).toBe("vault");
    setActiveView("settings");
    expect(useUiStore.getState().baseView).toBe("vault");
    closeOverlay();
    expect(useUiStore.getState().activeView).toBe("vault");
  });

  it("opening an overlay does not change the base view", () => {
    const { setActiveView } = useUiStore.getState();
    setActiveView("automations");
    setActiveView("skills");
    setActiveView("cost");
    expect(useUiStore.getState().baseView).toBe("automations");
  });

  it("navigating to a real view moves the base view", () => {
    const { setActiveView } = useUiStore.getState();
    setActiveView("vault");
    setActiveView("settings");
    setActiveView("chat");
    // Settings → chat is a REAL navigation (e.g. "Run login"): base follows.
    expect(useUiStore.getState().baseView).toBe("chat");
  });

  it("closeOverlay is a no-op when no overlay is open", () => {
    useUiStore.getState().setActiveView("vault");
    useUiStore.getState().closeOverlay();
    expect(useUiStore.getState().activeView).toBe("vault");
  });
});
