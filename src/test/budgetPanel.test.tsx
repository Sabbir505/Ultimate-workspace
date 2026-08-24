// Budget/spend alerts panel (roadmap #10): renders per-project spend against
// configured budgets, shows the used-percent, marks over-budget rows, and
// lets the user set/remove a budget (mocked ipc).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listBudgetsMock = vi.fn();
const setBudgetMock = vi.fn();
const removeBudgetMock = vi.fn();
const listProjectsMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  listBudgets: (...a: unknown[]) => listBudgetsMock(...a),
  setBudget: (...a: unknown[]) => setBudgetMock(...a),
  removeBudget: (...a: unknown[]) => removeBudgetMock(...a),
  listProjects: (...a: unknown[]) => listProjectsMock(...a),
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
    listProjectsMock.mockResolvedValueOnce([{ id: "p1", name: "Test Project" }]);
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
});
