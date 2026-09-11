// Stop-button + live-duration tests: an in-flight run must show its elapsed
// time ticking from started_at (not "—" until it ends) and offer Stop in both
// the table row and (via the store) the controls row; a stopped run records
// the neutral "stopped" status — never rendered as a failure.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const stopAutomationRunMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  createAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  listAutomations: vi.fn().mockResolvedValue([]),
  runAutomationNow: vi.fn(),
  setAutomationEnabled: vi.fn(),
  stopAutomationRun: (...a: unknown[]) => stopAutomationRunMock(...a),
  toastError: (...a: unknown[]) => toastErrorMock(...a),
  updateAutomation: vi.fn(),
}));

// AutomationRunTable imports lib/ipc types only (erased) — no mock needed.
import { AutomationRunTable } from "../components/automations/AutomationRunTable";
import { isFailureStatus, STOPPED_STATUS } from "../components/automations/shared";
import { useAutomationsStore } from "../state/automations";

const nowSec = Math.floor(Date.now() / 1000);

const run = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "r1",
  automationId: "a1",
  startedAt: nowSec - 90,
  finishedAt: null,
  status: "running",
  summary: "In progress…",
  chatSessionId: "c1",
  source: "manual",
  ...over,
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  stopAutomationRunMock.mockResolvedValue(true);
});

describe("AutomationRunTable live duration", () => {
  it("ticks elapsed time for a running row instead of showing an em-dash", () => {
    render(
      <AutomationRunTable
        runs={[run()]}
        loading={false}
        onOpenRunLog={() => {}}
      />,
    );
    expect(screen.getByText("1m 30s")).toBeTruthy();
  });

  it("finished rows still show their recorded duration", () => {
    render(
      <AutomationRunTable
        runs={[run({ finishedAt: nowSec - 30, status: "ok", summary: "Completed" })]}
        loading={false}
        onOpenRunLog={() => {}}
      />,
    );
    expect(screen.getByText("1m")).toBeTruthy();
  });
});

describe("AutomationRunTable stop button", () => {
  it("offers Stop on the running row and calls the handler once", () => {
    const onStopRun = vi.fn();
    render(
      <AutomationRunTable
        runs={[run()]}
        loading={false}
        onOpenRunLog={() => {}}
        onStopRun={onStopRun}
      />,
    );
    fireEvent.click(screen.getByTitle("Stop this run"));
    expect(onStopRun).toHaveBeenCalledTimes(1);
  });

  it("shows a stopping spinner and disables the button while stopping", () => {
    render(
      <AutomationRunTable
        runs={[run()]}
        loading={false}
        onOpenRunLog={() => {}}
        onStopRun={() => {}}
        stopping
      />,
    );
    const btn = screen.getByTitle("Stop this run") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText("Stopping…")).toBeTruthy();
  });

  it("offers no Stop once the run ended", () => {
    render(
      <AutomationRunTable
        runs={[run({ status: "ok", summary: "Completed", finishedAt: nowSec - 1 })]}
        loading={false}
        onOpenRunLog={() => {}}
        onStopRun={() => {}}
      />,
    );
    expect(screen.queryByTitle("Stop this run")).toBeNull();
  });
});

describe("stopped status rendering", () => {
  it("is a neutral outcome, not a failure", () => {
    expect(isFailureStatus(STOPPED_STATUS)).toBe(false);
    expect(isFailureStatus("ok")).toBe(false);
    expect(isFailureStatus("cmd.exe exited with exit code: 1")).toBe(true);
  });

  it("renders a Stopped badge on the row", () => {
    render(
      <AutomationRunTable
        runs={[run({ status: STOPPED_STATUS, summary: "Stopped", finishedAt: nowSec - 5 })]}
        loading={false}
        onOpenRunLog={() => {}}
      />,
    );
    // "Stopped" appears at least in the badge (the summary echoes it too).
    expect(screen.getAllByText("Stopped").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Error")).toBeNull();
  });
});

describe("automations store stopRun", () => {
  it("invokes the backend stop, clears the spinner, refreshes on success", async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    useAutomationsStore.setState({ loaded: true, load, stoppingNow: {} });
    await useAutomationsStore.getState().stopRun("a1");
    expect(stopAutomationRunMock).toHaveBeenCalledWith("a1");
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(useAutomationsStore.getState().stoppingNow["a1"]).toBeUndefined();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("explains itself when no run is stoppable in this app", async () => {
    stopAutomationRunMock.mockResolvedValue(false);
    const load = vi.fn().mockResolvedValue(undefined);
    useAutomationsStore.setState({ loaded: true, load, stoppingNow: {} });
    await useAutomationsStore.getState().stopRun("a1");
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(toastErrorMock.mock.calls[0][0]).toBe("Couldn't stop the run");
  });
});
