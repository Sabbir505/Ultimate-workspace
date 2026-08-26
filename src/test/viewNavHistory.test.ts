// View back/forward history (browser-style navigation) driven by setActiveView
// and consumed by the sidebar header arrows + collapsed-rail arrows.
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../state/ui";

describe("view nav history", () => {
  beforeEach(() => {
    useUiStore.setState({ activeView: "chat", viewHistory: ["chat"], viewIndex: 0 });
  });

  it("pushes visited views and truncates the forward branch on a new jump", () => {
    const { setActiveView, navBack, navForward } = useUiStore.getState();
    setActiveView("settings");
    setActiveView("skills");
    expect(useUiStore.getState().viewHistory).toEqual(["chat", "settings", "skills"]);
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
    expect(useUiStore.getState().viewHistory).toEqual(["chat", "cost"]);
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
    expect(useUiStore.getState().viewHistory).toEqual(["chat"]);
    set("settings");
    set("settings");
    expect(useUiStore.getState().viewHistory).toEqual(["chat", "settings"]);
  });
});
