// Budget/spend alerts panel (roadmap #10): renders per-project spend against
// configured budgets, shows the used-percent, marks over-budget rows, and
// lets the user set/remove a budget (mocked ipc). Also covers removing
// auto-added (unbudgeted) projects from the Cost page and restoring them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listBudgetsMock = vi.fn();
const setBudgetMock = vi.fn();
const removeBudgetMock = vi.fn();
const listProjectsMock = vi.fn();
const listHiddenCostProjectsMock = vi.fn();
const hideCostProjectMock = vi.fn();
const unhideCostProjectMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  listBudgets: (...a: unknown[]) => listBudgetsMock(...a),
  setBudget: (...a: unknown[]) => setBudgetMock(...a),
  removeBudget: (...a: unknown[]) => removeBudgetMock(...a),
  listProjects: (...a: unknown[]) => listProjectsMock(...a),
  listHiddenCostProjects: (...a: unknown[]) => listHiddenCostProjectsMock(...a),
  hideCostProject: (...a: unknown[]) => hideCostProjectMock(...a),
  unhideCostProject: (...a: unknown[]) => unhideCostProjectMock(...a),
  toastError: () => {},
}));

import { BudgetPanel } from "../components/cost-dashboard/BudgetPanel";
import type { ProjectCostRollup } from "../types";

const proj: ProjectCostRollup = {
  projectId: "p1",
  totalCostUsd: 40,
  totalInputTokens: 1_000_000,
  totalOutputTokens: 500_000,
};

describe("BudgetPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBudgetsMock.mockResolvedValue([]);
    setBudgetMock.mockResolvedValue([{ projectId: "p1", monthlyUsd: 50, thresholdPct: 100 }]);
    removeBudgetMock.mockResolvedValue(undefined);
    listProjectsMock.mockResolvedValue([{ id: "p1", name: "Test Project" }]);
    listHiddenCostProjectsMock.mockResolvedValue([]);
    hideCostProjectMock.mockResolvedValue(undefined);
    unhideCostProjectMock.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("does not render without any projects", () => {
    const { container } = render(<BudgetPanel perProject={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows spend and a Set budget button when no budget configured", async () => {
    render(<BudgetPanel perProject={[proj]} />);
    expect(await screen.findByText(/\$40\.00/)).toBeTruthy();
    expect(screen.getByText("Set budget")).toBeTruthy();
  });

  it("renders used-percent when a budget exists", async () => {
    listBudgetsMock.mockResolvedValue([{ projectId: "p1", monthlyUsd: 50, thresholdPct: 100 }]);
    render(<BudgetPanel perProject={[proj]} />);
    // $40 / $50 = 80% of $50.
    expect(await screen.findByText(/80\.0% of \$50/)).toBeTruthy();
  });

  it("marks an over-budget row", async () => {
    listBudgetsMock.mockResolvedValue([{ projectId: "p1", monthlyUsd: 30, thresholdPct: 100 }]);
    render(<BudgetPanel perProject={[proj]} />);
    // $40 / $30 = 133.3% — over budget.
    const pct = await screen.findByText(/133\.3% of \$30/);
    expect(pct.classList.contains("over")).toBe(true);
  });

  it("saves a new budget and refreshes the list", async () => {
    render(<BudgetPanel perProject={[proj]} />);
    fireEvent.click(screen.getByText("Set budget"));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "75" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(setBudgetMock).toHaveBeenCalledWith("p1", 75));
    await waitFor(() => expect(listBudgetsMock).toHaveBeenCalled());
  });

  it("removes a configured budget", async () => {
    listBudgetsMock.mockResolvedValue([{ projectId: "p1", monthlyUsd: 50, thresholdPct: 100 }]);
    render(<BudgetPanel perProject={[proj]} />);
    fireEvent.click(await screen.findByText("Remove"));
    await waitFor(() => expect(removeBudgetMock).toHaveBeenCalledWith("p1"));
  });

  it("hides an auto-added project from the Cost page", async () => {
    render(<BudgetPanel perProject={[proj]} />);
    const remove = await screen.findByTitle("Remove from Cost page");
    fireEvent.click(remove);
    await waitFor(() => expect(hideCostProjectMock).toHaveBeenCalledWith("p1"));
    // The row disappears from the list once hidden.
    await waitFor(() => expect(screen.queryByText(/\$40\.00/)).toBeNull());
  });

  it("filters out previously hidden projects and offers restore", async () => {
    listHiddenCostProjectsMock.mockResolvedValue(["p1"]);
    render(<BudgetPanel perProject={[proj]} />);
    // The hidden row must not render…
    await waitFor(() => expect(screen.queryByText(/\$40\.00/)).toBeNull());
    // …but the restore footer lists it.
    fireEvent.click(screen.getByText("Show removed (1)"));
    expect(screen.getByText("Test Project")).toBeTruthy();
    fireEvent.click(screen.getByText("Restore"));
    await waitFor(() => expect(unhideCostProjectMock).toHaveBeenCalledWith("p1"));
    // Unhiding brings the row back.
    expect(await screen.findByText(/\$40\.00/)).toBeTruthy();
  });

  it("stays mounted to offer restore when every row is hidden", async () => {
    listHiddenCostProjectsMock.mockResolvedValue(["p1"]);
    const { container } = render(<BudgetPanel perProject={[proj]} />);
    await waitFor(() => expect(screen.queryByText(/\$40\.00/)).toBeNull());
    expect(container.querySelector(".budget-panel")).toBeTruthy();
    expect(screen.getByText("Show removed (1)")).toBeTruthy();
  });

  it("does not show the restore footer when nothing is hidden", async () => {
    render(<BudgetPanel perProject={[proj]} />);
    await screen.findByText(/\$40\.00/);
    expect(screen.queryByText(/Show removed/)).toBeNull();
  });
});
