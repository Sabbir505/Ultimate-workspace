import { describe, expect, it, beforeEach } from "vitest";
import {
  useBrowserTrustStore,
  agentActiveWithin,
  type BrowserTimelineEntry,
} from "../state/browserTrust";

function entry(partial: Partial<BrowserTimelineEntry>): BrowserTimelineEntry {
  return {
    tsMs: Date.now(),
    op: "click",
    target: "the button",
    outcome: "ok",
    ...partial,
  };
}

describe("browserTrust store", () => {
  beforeEach(() => {
    useBrowserTrustStore.setState({
      confirm: null,
      takeover: null,
      paused: {},
      timeline: {},
      timelineOpen: {},
      lastAgentActivity: {},
    });
  });

  it("gates lifecycle: set and clear the confirm request", () => {
    const s = useBrowserTrustStore.getState();
    s.setConfirm({
      reqId: 7,
      paneId: "p1",
      op: "click",
      target: "Place Order",
      url: "https://shop.example/",
      riskClass: "payment",
      reason: "looks like a payment action",
    });
    expect(useBrowserTrustStore.getState().confirm?.riskClass).toBe("payment");
    useBrowserTrustStore.getState().setConfirm(null);
    expect(useBrowserTrustStore.getState().confirm).toBeNull();
  });

  it("appends timeline entries and caps the client projection", () => {
    const s = useBrowserTrustStore.getState();
    for (let i = 0; i < 250; i++) {
      s.appendTimeline("p1", entry({ tsMs: i, op: `op-${i}` }));
    }
    const list = useBrowserTrustStore.getState().timeline.p1;
    expect(list).toHaveLength(200);
    expect(list[0].op).toBe("op-50"); // oldest evicted
    expect(list[199].op).toBe("op-249");
    // Panes are isolated.
    s.appendTimeline("p2", entry({ op: "other" }));
    expect(useBrowserTrustStore.getState().timeline.p1).toHaveLength(200);
    expect(useBrowserTrustStore.getState().timeline.p2).toHaveLength(1);
  });

  it("tracks pause + takeover per pane", () => {
    const s = useBrowserTrustStore.getState();
    s.setPaused("p1", true);
    expect(useBrowserTrustStore.getState().paused.p1).toBe(true);
    expect(useBrowserTrustStore.getState().paused.p2).toBeUndefined();
    s.setTakeover({ paneId: "p1", reason: "password field", url: "", target: "" });
    expect(useBrowserTrustStore.getState().takeover?.paneId).toBe("p1");
  });

  it("toggles the timeline panel per pane", () => {
    const s = useBrowserTrustStore.getState();
    s.toggleTimeline("p1");
    expect(useBrowserTrustStore.getState().timelineOpen.p1).toBe(true);
    s.toggleTimeline("p1");
    expect(useBrowserTrustStore.getState().timelineOpen.p1).toBe(false);
  });

  it("agentActiveWithin honours the TTL", () => {
    const now = 1_000_000;
    expect(agentActiveWithin(undefined, now)).toBe(false);
    expect(agentActiveWithin(now - 5_000, now)).toBe(false);
    expect(agentActiveWithin(now - 3_999, now)).toBe(true);
  });
});
