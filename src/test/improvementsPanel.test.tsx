// ImprovementsPanel (SELF_IMPROVING_ARTIFACTS.md P1 UI): renders proposals
// with status-gated actions, runs the sweep, and exposes the kill switch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  listImproveArtifacts: vi.fn(),
  listImprovementProposals: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  runImprovementSweep: vi.fn(),
  evaluateImprovementProposal: vi.fn(),
  applyImprovementProposal: vi.fn(),
  rejectImprovementProposal: vi.fn(),
  listImproveVersions: vi.fn(),
  setImproveChannel: vi.fn(),
  setImproveAutonomy: vi.fn(),
  getImproveAutonomy: vi.fn(),
  checkImprovementCanaries: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../lib/ipc", () => mocks);

import { ImprovementsPanel } from "../components/settings/ImprovementsPanel";

const artifact = {
  id: "a1",
  kind: "skill",
  refKey: "docx",
  name: "Docx skill",
  createdAt: 1,
};
const openProposal = {
  id: "p1",
  artifactId: "a1",
  baseVersion: 1,
  candidateVersion: 2,
  changeSummary: "Tighten the output-format instructions",
  rootCausesJson: null,
  expectedEffect: "fewer format failures",
  riskNotes: null,
  status: "open" as const,
  evalRunId: null,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listImproveArtifacts.mockResolvedValue([artifact]);
  mocks.listImprovementProposals.mockResolvedValue([openProposal]);
  mocks.getSetting.mockResolvedValue("true");
  mocks.runImprovementSweep.mockResolvedValue([]);
  mocks.evaluateImprovementProposal.mockResolvedValue("passed");
  mocks.applyImprovementProposal.mockResolvedValue(undefined);
  mocks.rejectImprovementProposal.mockResolvedValue(undefined);
  mocks.setSetting.mockResolvedValue(undefined);
  mocks.listImproveVersions.mockResolvedValue([
    { id: "v1", artifactId: "a1", version: 1, body: "old", metaJson: null, origin: "user", parentVersion: null, createdAt: 1 },
    { id: "v2", artifactId: "a1", version: 2, body: "new", metaJson: null, origin: "auto_proposal", parentVersion: 1, createdAt: 2 },
  ]);
  mocks.setImproveChannel.mockResolvedValue(undefined);
  mocks.setImproveAutonomy.mockResolvedValue(undefined);
  mocks.getImproveAutonomy.mockResolvedValue("manual");
  mocks.checkImprovementCanaries.mockResolvedValue([]);
});
afterEach(cleanup);

describe("ImprovementsPanel", () => {
  it("renders the open proposal with its summary and status", async () => {
    render(<ImprovementsPanel />);
    expect(await screen.findByText("Tighten the output-format instructions")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText(/v1 → v2/)).toBeTruthy();
    // Open proposals can be evaluated and rejected, but not applied.
    expect(screen.getByText("Evaluate")).toBeTruthy();
    expect(screen.getByTestId("reject-proposal")).toBeTruthy();
    expect(screen.queryByTestId("apply-proposal")).toBeNull();
  });

  it("running the sweep calls the backend and refreshes", async () => {
    render(<ImprovementsPanel />);
    const sweep = await screen.findByTestId("run-sweep");
    fireEvent.click(sweep);
    await waitFor(() => expect(mocks.runImprovementSweep).toHaveBeenCalled());
    // Mount refresh + canary-check refresh + post-sweep refresh.
    await waitFor(() => expect(mocks.listImprovementProposals.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("evaluating a passed proposal unlocks Apply", async () => {
    render(<ImprovementsPanel />);
    // Re-arm the refreshed list BEFORE clicking so the post-evaluate refresh
    // already sees the passed state.
    mocks.listImprovementProposals.mockResolvedValue([{ ...openProposal, status: "passed" }]);
    fireEvent.click(await screen.findByText("Evaluate"));
    expect(await screen.findByTestId("apply-proposal")).toBeTruthy();
  });

  it("apply and reject route to the backend", async () => {
    mocks.listImprovementProposals.mockResolvedValue([{ ...openProposal, status: "passed" }]);
    render(<ImprovementsPanel />);
    fireEvent.click(await screen.findByTestId("apply-proposal"));
    await waitFor(() => expect(mocks.applyImprovementProposal).toHaveBeenCalledWith("p1"));
    fireEvent.click(screen.getByTestId("reject-proposal"));
    await waitFor(() => expect(mocks.rejectImprovementProposal).toHaveBeenCalledWith("p1"));
  });

  it("kill switch off disables the sweep and persists the setting", async () => {
    mocks.getSetting.mockResolvedValue("false");
    render(<ImprovementsPanel />);
    const sweep = await screen.findByTestId("run-sweep");
    expect((sweep as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByTestId("improve-kill-switch"));
    await waitFor(() => expect(mocks.setSetting).toHaveBeenCalledWith("improvements.enabled", "true"));
  });

  it("version history expands and rolls back by re-pointing active", async () => {
    render(<ImprovementsPanel />);
    const rows = await screen.findAllByTestId("artifact-row");
    fireEvent.click(rows[0]);
    expect(await screen.findByText("v2")).toBeTruthy();
    const buttons = screen.getAllByText("Set active");
    fireEvent.click(buttons[1]); // v2
    await waitFor(() => expect(mocks.setImproveChannel).toHaveBeenCalledWith("a1", "active", 2));
  });

  it("changes the per-artifact autonomy tier", async () => {
    render(<ImprovementsPanel />);
    const rows = await screen.findAllByTestId("artifact-row");
    fireEvent.click(rows[0]);
    const select = await screen.findByTestId("tier-a1") as HTMLSelectElement;
    expect(select.value).toBe("manual");
    fireEvent.change(select, { target: { value: "canary" } });
    await waitFor(() => expect(mocks.setImproveAutonomy).toHaveBeenCalledWith("a1", "canary"));
  });

  it("resolves matured canary windows on open", async () => {
    render(<ImprovementsPanel />);
    await waitFor(() => expect(mocks.checkImprovementCanaries).toHaveBeenCalled());
  });
});
