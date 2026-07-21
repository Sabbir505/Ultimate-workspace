import { describe, expect, it } from "vitest";
import { activeTerminalId, cycleTerminalId } from "../state/panes";
import type { Pane } from "../state/panes";

function term(paneId: string, lastUsedAt: number, lastInputAt = 0): Pane {
  return {
    paneId,
    state: "idle",
    lastUsedAt,
    lastInputAt,
    data: {
      kind: "terminal",
      sessionId: paneId,
      harness: "claude_code",
      label: paneId,
      spawn: { type: "agent", sessionId: paneId },
      exited: false,
      exitCode: null,
    },
  };
}

function browser(paneId: string, lastUsedAt: number): Pane {
  return {
    paneId,
    state: "idle",
    lastUsedAt,
    lastInputAt: 0,
    data: {
      kind: "browser",
      url: "http://localhost:3000",
      projectId: null,
      collapsed: false,
      tabs: [{ tabId: "default", url: "http://localhost:3000", title: "" }],
      activeTabIndex: 0,
    },
  };
}

describe("activeTerminalId (split-layout spotlight)", () => {
  it("returns null with no terminals", () => {
    expect(activeTerminalId([browser("b1", 1)], null)).toBeNull();
    expect(activeTerminalId([], null)).toBeNull();
  });

  it("defaults to the terminal with the most recent input, then focus recency", () => {
    const panes = [term("t1", 5), term("t2", 3, 10), browser("b1", 99)];
    // t2 typed more recently even though t1 was focused later and the
    // browser was used most recently of all — browsers never spotlight.
    expect(activeTerminalId(panes, null)).toBe("t2");
  });

  it("explicit override wins while that pane still exists", () => {
    const panes = [term("t1", 5), term("t2", 9)];
    expect(activeTerminalId(panes, "t1")).toBe("t1");
    // Stale override (pane closed) falls back to recency.
    expect(activeTerminalId(panes, "t3")).toBe("t2");
  });
});

describe("cycleTerminalId", () => {
  const panes = [term("t1", 1), browser("b1", 2), term("t2", 3), term("t3", 4)];

  it("cycles forward and wraps", () => {
    expect(cycleTerminalId(panes, "t1", 1)).toBe("t2");
    expect(cycleTerminalId(panes, "t2", 1)).toBe("t3");
    expect(cycleTerminalId(panes, "t3", 1)).toBe("t1");
  });

  it("cycles backward and wraps", () => {
    expect(cycleTerminalId(panes, "t1", -1)).toBe("t3");
    expect(cycleTerminalId(panes, "t2", -1)).toBe("t1");
  });

  it("starts at an end when the current id is unknown", () => {
    expect(cycleTerminalId(panes, null, 1)).toBe("t1");
    expect(cycleTerminalId(panes, null, -1)).toBe("t3");
  });

  it("returns null with no terminals", () => {
    expect(cycleTerminalId([browser("b1", 1)], null, 1)).toBeNull();
  });
});
