// Composer HUD tests — verifies the telemetry HUD (ComposerMetrics) renders
// the correct chip set across the three states that matter:
//  1. Fresh chat (no data) → placeholder chips with em-dashes, same silhouette.
//  2. Idle chat with past turns → session aggregates, with cache/speed tones.
//  3. Live streaming → live chips pulse, output tokens + speed always shown.
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
  useChatStore.setState({ livePerf: {}, sessionMetrics: {} });
});

describe("ComposerMetrics HUD", () => {
  it("renders placeholder chips with em-dashes on a fresh chat", () => {
    useChatStore.setState({ livePerf: {}, sessionMetrics: {} });
    render(<ComposerMetrics chatSessionId="s1" streaming={false} variant="hud" />);
    // The HUD bar itself.
    const row = screen.getByRole("status");
    expect(row.className).toContain("is-hud");
    expect(row.className).toContain("is-empty");
    // Seven placeholder chips, each showing an em-dash value.
    const chips = within(row).getAllByText("—");
    expect(chips.length).toBeGreaterThanOrEqual(7);
    // Labels are present and uppercase.
    expect(within(row).getByText("in")).toBeTruthy();
    expect(within(row).getByText("cache")).toBeTruthy();
  });

  it("shows session aggregates with cache and speed tones when idle", () => {
    useChatStore.setState({
      livePerf: {},
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
    // Turn count is surfaced.
    expect(within(row).getByText("3")).toBeTruthy();
  });

  it("pulses output + speed chips while streaming and always shows them", () => {
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
        },
      },
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
  });

  it("renders a hover tooltip on every chip", () => {
    useChatStore.setState({ livePerf: {}, sessionMetrics: {} });
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
