// C7 (ISSUES.md): MemoryPanel's toggle/retire/saveEdit/add awaited IPC without
// try/finally — one rejection left `busy` stuck true, disabling the whole
// panel (and surfacing nothing). All four paths must release the flag and
// raise a toast, matching saveDoc.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi, beforeEach, describe, expect, it } from "vitest";

import { MemoryPanel } from "../components/settings/MemoryPanel";
import * as ipc from "../lib/ipc";
import { useUiStore } from "../state/ui";

function mem(overrides: Partial<ipc.MemoryRecordView> = {}): ipc.MemoryRecordView {
  return {
    id: "mem_abc12345",
    kind: "preference",
    profile: "default",
    projectId: null,
    subject: "user",
    content: "User prefers concise answers",
    keywords: [],
    importance: 7,
    confidence: 0.9,
    status: "active",
    supersededBy: null,
    validFrom: 1_700_000_000,
    validUntil: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    origin: "extracted",
    reflected: false,
    ...overrides,
  };
}

function status(overrides: Partial<ipc.MemoryStatusView> = {}): ipc.MemoryStatusView {
  return {
    enabled: true,
    activeCount: 1,
    document: "# Profile",
    documentStored: false,
    documentUpdatedAt: null,
    documentBudget: 2200,
    extractModel: "",
    ...overrides,
  };
}

function seedPanel() {
  vi.spyOn(ipc, "memoryStatus").mockResolvedValue(status());
  vi.spyOn(ipc, "memoryList").mockResolvedValue([mem()]);
}

describe("MemoryPanel — IPC failure releases busy (C7)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUiStore.setState({ toasts: [] });
  });

  it("toggle: rejects → toast shown and the control re-enables", async () => {
    seedPanel();
    const toast = vi.spyOn(ipc, "toastError").mockImplementation(() => {});
    vi.spyOn(ipc, "memorySetEnabled").mockRejectedValue(new Error("boom"));
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByTestId("memory-panel")).toBeTruthy());
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    await act(async () => {
      fireEvent.click(checkbox);
    });
    expect(toast).toHaveBeenCalledWith("Couldn't change the memory setting", expect.anything());
    expect(checkbox.disabled).toBe(false);
  });

  it("retire: rejects → toast shown and Forget re-enables", async () => {
    seedPanel();
    const toast = vi.spyOn(ipc, "toastError").mockImplementation(() => {});
    vi.spyOn(ipc, "memoryDelete").mockRejectedValue(new Error("boom"));
    render(<MemoryPanel />);
    const forget = await screen.findByText("Forget");
    await act(async () => {
      fireEvent.click(forget);
    });
    expect(toast).toHaveBeenCalledWith("Couldn't forget that memory", expect.anything());
    expect((forget as HTMLButtonElement).disabled).toBe(false);
  });

  it("saveEdit: rejects → toast shown and Save re-enables", async () => {
    seedPanel();
    const toast = vi.spyOn(ipc, "toastError").mockImplementation(() => {});
    vi.spyOn(ipc, "memoryUpdate").mockRejectedValue(new Error("boom"));
    render(<MemoryPanel />);
    fireEvent.click(await screen.findByText("Edit"));
    const save = await screen.findByText("Save");
    await act(async () => {
      fireEvent.click(save);
    });
    expect(toast).toHaveBeenCalledWith("Couldn't save the edit", expect.anything());
    expect((save as HTMLButtonElement).disabled).toBe(false);
    // Still in edit mode — the edit was NOT silently dropped.
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("add: rejects → toast shown and Add re-enables", async () => {
    seedPanel();
    const toast = vi.spyOn(ipc, "toastError").mockImplementation(() => {});
    vi.spyOn(ipc, "memoryCreate").mockRejectedValue(new Error("boom"));
    render(<MemoryPanel />);
    const input = await screen.findByPlaceholderText(/Add a fact yourself/);
    fireEvent.change(input, { target: { value: "Prefers tabs" } });
    const add = screen.getByText("Add");
    await act(async () => {
      fireEvent.click(add);
    });
    expect(toast).toHaveBeenCalledWith("Couldn't add the memory", expect.anything());
    expect((add as HTMLButtonElement).disabled).toBe(false);
  });
});
