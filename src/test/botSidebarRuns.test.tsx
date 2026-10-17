// The bot activity rail's "Recent runs" rows must call onOpenRun with the run
// (so the center can open that run's transcript). Regression guard: a run row
// that renders but does nothing on click is the reported bug.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/ipc/artifacts", () => ({
  listArtifacts: vi.fn().mockResolvedValue([]),
}));

import { BotSidebar } from "../components/bots/BotSidebar";

afterEach(() => cleanup());

describe("BotSidebar recent runs", () => {
  it("opens a run when its row is clicked", () => {
    const onOpenRun = vi.fn();
    render(
      <BotSidebar
        approvals={[]}
        jobs={[]}
        runs={[
          {
            id: "r1",
            botId: "b1",
            sessionId: "s-run-1",
            jobId: null,
            jobName: "Manual run",
            source: "manual",
            startedAt: 0,
            finishedAt: 1,
            status: "ok",
            summary: "",
            pendingApprovals: 0,
          },
        ]}
        running={false}
        botSessions={["s-run-1"]}
        onResolveApproval={vi.fn()}
        onAddJob={vi.fn()}
        onOpenRun={onOpenRun}
      />,
    );
    fireEvent.click(screen.getByText("Manual run"));
    expect(onOpenRun).toHaveBeenCalledTimes(1);
    expect(onOpenRun.mock.calls[0][0].sessionId).toBe("s-run-1");
  });
});
