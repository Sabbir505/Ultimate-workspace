// Composer HUD tests — verifies the telemetry HUD (ComposerMetrics) renders
// a FIXED chip grid across every state: fresh chat, idle aggregate, idle
// last-turn, and live streaming. The grid is the contract: the same chips in
// the same order at all times (em-dash when there is no data), so turn
// boundaries never reflow the row, and a metric the backend hasn't measured
// yet in a new turn CARRIES OVER the last turn's value instead of resetting
// to zero. Chips fed by the current turn's live snapshot pulse (is-live).
//
// Also checks that each chip carries a hover tooltip (role=tooltip) explaining
// the metric, so the HUD is self-documenting.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ComposerMetrics } from "../components/chat/ComposerMetrics";
import { useChatStore } from "../state/chat";

afterEach(() => {
  cleanup();
  // Reset the metrics slices so tests don't bleed into each other.
  useChatStore.setState({ livePerf: {}, lastTurnPerf: {}, sessionMetrics: {} });
});

/** The chip labels in DOM order — the fixed grid under test. */
const chipLabels = (row: HTMLElement): string[] =>
  Array.from(row.querySelectorAll(".composer-metrics-chip-label")).map(
    (el) => el.textContent ?? "",
  );

describe("ComposerMetrics HUD", () => {
  it("renders placeholder chips with em-dashes on a fresh chat", () => {
    useChatStore.setState({ livePerf: {}, lastTurnPerf: {}, sessionMetrics: {} });
    render(<ComposerMetrics chatSessionId="s1" streaming={false} variant="hud" />);
    // The HUD bar itself.
    const row = screen.getByRole("status");
    expect(row.className).toContain("is-hud");
    expect(row.className).toContain("is-empty");
    // Every chip shows an em-dash value.
    const chips = within(row).getAllByText("—");
    expect(chips.length).toBeGreaterThanOrEqual(7);
    // Labels are present and uppercase.
    expect(within(row).getByText("in")).toBeTruthy();
    expect(within(row).getByText("cache")).toBeTruthy();
  });

  it("shows session aggregates with cache and speed tones when idle", () => {
    useChatStore.setState({
      livePerf: {},
      lastTurnPerf: {},
      sessionMetrics: {
        s1: {
          chatSessionId: "s1",
          inputTokens: 15400,
          outputTokens: 3200,
          llmTimeMs: 4200,
          toolTimeMs: 1100,
          ttftAvgMs: 380,
          tokensPerSecond: 48,
          cacheHitRate: 0.42,
          turnCount: 3,
        },
      },
    });
    render(<ComposerMetrics chatSessionId="s1" streaming={false} variant="hud" />);
    const row = screen.getByRole("status");
    expect(row.className).not.toContain("is-empty");
    // Token values are formatted (15k tok, 3.2k tok — 15400 rounds to 15k
    // since fmtTokens drops decimals at >=10k).
    expect(within(row).getByText("15k tok")).toBeTruthy();
    expect(within(row).getByText("3.2k tok")).toBeTruthy();
    // Cache renders as a percentage with the cache tone class.
    const cacheChip = within(row).getByText("42%").closest(".composer-metrics-chip");
    expect(cacheChip?.className).toContain("tone-cache");
    // Speed renders with the speed tone.
    const speedChip = within(row).getByText("48 tok/s").closest(".composer-metrics-chip");
    expect(speedChip?.className).toContain("tone-speed");
    // Turn count is surfaced (appended after the fixed grid).
    expect(within(row).getByText("3")).toBeTruthy();
    // The aggregate has no per-turn elapsed — the slot shows an em-dash,
    // it does not disappear.
    const elapsedChip = within(row).getByText("elapsed").closest(".composer-metrics-chip");
    expect(elapsedChip?.textContent).toContain("—");
  });

  it("pulses live-fed chips while streaming and keeps every chip in place", () => {
    useChatStore.setState({
      livePerf: {
        s1: {
          chatSessionId: "s1",
          llmTimeMs: 800,
          toolTimeMs: 0,
          ttftMs: 350,
          tokensPerSecond: 12,
          outputTokens: 96,
          elapsedMs: 1200,
          inputTokens: null,
          cacheHitRate: null,
        },
      },
      lastTurnPerf: {},
      sessionMetrics: {},
    });
    render(<ComposerMetrics chatSessionId="s1" streaming={true} variant="hud" />);
    const row = screen.getByRole("status");
    // Output tokens + speed are live (is-live class on the chip).
    const outChip = within(row).getByText("96 tok").closest(".composer-metrics-chip");
    expect(outChip?.className).toContain("is-live");
    const speedChip = within(row).getByText("12 tok/s").closest(".composer-metrics-chip");
    expect(speedChip?.className).toContain("is-live");
    // TTFT renders when present.
    expect(within(row).getByText("350 ms")).toBeTruthy();
    // FIXED GRID: in/cache stay in place even before the provider reports
    // round usage — they hold an em-dash instead of vanishing.
    const inChip = within(row).getByText("in").closest(".composer-metrics-chip");
    expect(inChip?.textContent).toContain("—");
    const cacheChip = within(row).getByText("cache").closest(".composer-metrics-chip");
    expect(cacheChip?.textContent).toContain("—");
  });

  it("carries last-turn values into a new turn instead of resetting to zero", () => {
    // Idle after a completed turn…
    useChatStore.setState({
      livePerf: {},
      lastTurnPerf: {
        s1: {
          llmTimeMs: 5000,
          toolTimeMs: 900,
          ttftMs: 420,
          tokensPerSecond: 40,
          outputTokens: 500,
          inputTokens: 15400,
          cacheHitRate: 0.5,
          elapsedMs: 7000,
        },
      },
      sessionMetrics: {},
    });
    // …then a new turn starts streaming: nothing measured yet (zeros/nulls).
    useChatStore.setState({
      livePerf: {
        s1: {
          chatSessionId: "s1",
          llmTimeMs: 0,
          toolTimeMs: 0,
          ttftMs: null,
          tokensPerSecond: null,
          outputTokens: 0,
          elapsedMs: 400,
          inputTokens: null,
          cacheHitRate: null,
        },
      },
    });
    render(<ComposerMetrics chatSessionId="s1" streaming={true} variant="hud" />);
    const row = screen.getByRole("status");
    // Every not-yet-measured metric keeps the last turn's value…
    expect(within(row).getByText("15k tok")).toBeTruthy(); // in
    expect(within(row).getByText("500 tok")).toBeTruthy(); // out
    expect(within(row).getByText("40 tok/s")).toBeTruthy(); // speed
    expect(within(row).getByText("420 ms")).toBeTruthy(); // ttft
    expect(within(row).getByText("50%")).toBeTruthy(); // cache
    // …while the live elapsed clock already ticks for THIS turn, and the
    // carried chips do NOT claim to be live (no pulse).
    expect(within(row).getByText("400 ms")).toBeTruthy();
    const inChip = within(row).getByText("15k tok").closest(".composer-metrics-chip");
    expect(inChip?.className).not.toContain("is-live");
  });

  it("flips carried chips to live values once the backend reports them", () => {
    useChatStore.setState({
      lastTurnPerf: {
        s1: {
          llmTimeMs: 5000,
          toolTimeMs: 0,
          ttftMs: 420,
          tokensPerSecond: 40,
          outputTokens: 500,
          inputTokens: 15400,
          cacheHitRate: 0.5,
          elapsedMs: 7000,
        },
      },
      livePerf: {
        s1: {
          chatSessionId: "s1",
          llmTimeMs: 900,
          toolTimeMs: 0,
          ttftMs: 380,
          tokensPerSecond: 21,
          outputTokens: 84,
          elapsedMs: 1500,
          inputTokens: 16200,
          cacheHitRate: 0.61,
        },
      },
      sessionMetrics: {},
    });
    render(<ComposerMetrics chatSessionId="s1" streaming={true} variant="hud" />);
    const row = screen.getByRole("status");
    // Live numbers replace the carried ones in place.
    expect(within(row).getByText("16k tok")).toBeTruthy(); // in
    expect(within(row).getByText("84 tok")).toBeTruthy(); // out
    expect(within(row).getByText("21 tok/s")).toBeTruthy(); // speed
    expect(within(row).getByText("61%")).toBeTruthy(); // cache
    const inChip = within(row).getByText("16k tok").closest(".composer-metrics-chip");
    expect(inChip?.className).toContain("is-live");
  });

  it("renders the SAME chip order while idle and while streaming", () => {
    useChatStore.setState({
      livePerf: {},
      lastTurnPerf: {
        s1: {
          llmTimeMs: 5000,
          toolTimeMs: 900,
          ttftMs: 420,
          tokensPerSecond: 40,
          outputTokens: 500,
          inputTokens: 15400,
          cacheHitRate: 0.5,
          elapsedMs: 7000,
        },
      },
      sessionMetrics: {},
    });
    const idle = render(<ComposerMetrics chatSessionId="s1" streaming={false} variant="hud" />);
    const idleOrder = chipLabels(idle.getByRole("status"));
    idle.unmount();

    useChatStore.setState({
      livePerf: {
        s1: {
          chatSessionId: "s1",
          llmTimeMs: 800,
          toolTimeMs: 0,
          ttftMs: 350,
          tokensPerSecond: 12,
          outputTokens: 96,
          elapsedMs: 1200,
          inputTokens: null,
          cacheHitRate: null,
        },
      },
    });
    const live = render(<ComposerMetrics chatSessionId="s1" streaming={true} variant="hud" />);
    const liveOrder = chipLabels(live.getByRole("status"));
    live.unmount();

    expect(idleOrder.length).toBeGreaterThan(0);
    expect(liveOrder).toEqual(idleOrder);
  });

  it("shows IN and CACHE live once round-boundary usage lands", () => {
    useChatStore.setState({
      livePerf: {
        s1: {
          chatSessionId: "s1",
          llmTimeMs: 2000,
          toolTimeMs: 600,
          ttftMs: 410,
          tokensPerSecond: 55,
          outputTokens: 110,
          elapsedMs: 3200,
          inputTokens: 15400,
          cacheHitRate: 0.66,
        },
      },
      lastTurnPerf: {},
      sessionMetrics: {},
    });
    render(<ComposerMetrics chatSessionId="s1" streaming={true} variant="hud" />);
    const row = screen.getByRole("status");
    // IN renders the accumulated round usage (15400 → 15k tok) with the
    // token tone, CACHE renders the normalized hit rate.
    const inChip = within(row).getByText("15k tok").closest(".composer-metrics-chip");
    expect(inChip?.className).toContain("tone-tokens");
    const cacheChip = within(row).getByText("66%").closest(".composer-metrics-chip");
    expect(cacheChip?.className).toContain("tone-cache");
  });

  it("renders a hover tooltip on every chip", () => {
    useChatStore.setState({ livePerf: {}, lastTurnPerf: {}, sessionMetrics: {} });
    render(<ComposerMetrics chatSessionId="s1" streaming={false} variant="hud" />);
    const tooltips = screen.getAllByRole("tooltip");
    expect(tooltips.length).toBeGreaterThanOrEqual(7);
    // Each tooltip has non-empty text.
    for (const t of tooltips) {
      expect(t.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it("renders nothing when there is no active chat session", () => {
    const { container } = render(
      <ComposerMetrics chatSessionId={null} streaming={false} variant="hud" />,
    );
    expect(container.firstChild).toBeNull();
  });
});
