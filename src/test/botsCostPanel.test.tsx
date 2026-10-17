// The Usage page's Bots cost section: one row per bot, a range total, and no
// panel at all when there are no bots.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const getBotCosts = vi.fn();
vi.mock("../lib/ipc/bots", () => ({
  getBotCosts: (...args: unknown[]) => getBotCosts(...args),
}));
vi.mock("../lib/ipc", () => ({ toastError: vi.fn() }));

import { BotsCostPanel } from "../components/cost-dashboard/BotsCostPanel";

beforeEach(() => getBotCosts.mockReset());

describe("BotsCostPanel", () => {
  it("lists each bot's spend and totals the range", async () => {
    getBotCosts.mockResolvedValue([
      { botId: "b1", name: "Atlas", emoji: "🛰️", enabled: true, runs: 3, jobs: 1, inputTokens: 12_000, outputTokens: 3_400, cacheReadTokens: 8_000, costUsd: 0.42 },
      { botId: "b2", name: "Scout", emoji: "🤖", enabled: false, runs: 0, jobs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    ]);
    render(<BotsCostPanel rangeDays={30} />);
    const table = await screen.findByTestId("bots-cost-table");
    expect(table.textContent).toContain("Atlas");
    expect(table.textContent).toContain("Scout");
    expect(table.textContent).toContain("$0.42");
    expect(table.textContent).toContain("disabled");
    expect(getBotCosts).toHaveBeenCalledWith(30);
    expect(screen.getByTestId("bots-cost-panel").textContent).toContain("$0.42 total");
  });

  it("renders nothing when there are no bots", async () => {
    getBotCosts.mockResolvedValue([]);
    render(<BotsCostPanel rangeDays={7} />);
    await waitFor(() => expect(getBotCosts).toHaveBeenCalledWith(7));
    expect(screen.queryByTestId("bots-cost-panel")).toBeNull();
  });
});
