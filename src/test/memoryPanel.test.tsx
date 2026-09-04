// Tests for the Settings → Memory panel (MEMORY_DESIGN_ARCHITECTURE.md §12.2).
// Outside the Tauri runtime `safeInvoke` resolves null, so the panel must
// render its empty/off states without exploding; with mocked ipc responses it
// lists memories, applies filters, and exercises edit/retire flows.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi, beforeEach, describe, expect, it } from "vitest";

import { MemoryPanel } from "../components/settings/MemoryPanel";
import * as ipc from "../lib/ipc";

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

describe("MemoryPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the empty state when the backend returns nothing (non-Tauri)", async () => {
    render(<MemoryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("memory-panel")).toBeTruthy();
    });
    expect(screen.getByText(/Memory is off|Nothing here yet/)).toBeTruthy();
  });

  it("lists memories with kind and confidence and supports the status filter", async () => {
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue({ enabled: true, activeCount: 2 });
    vi.spyOn(ipc, "memoryList").mockResolvedValue([
      mem(),
      mem({
        id: "mem_old9999",
        kind: "fact",
        content: "User used npm before switching",
        status: "superseded",
        confidence: 0.8,
      }),
    ]);
    render(<MemoryPanel />);
    await waitFor(() => {
      expect(screen.getByText(/User prefers concise answers/)).toBeTruthy();
    });
    // "all" shows both the active and the superseded row; "active" hides the
    // superseded one.
    fireEvent.click(screen.getByText("all", { exact: true }));
    expect(screen.getByText(/User used npm before switching/)).toBeTruthy();
    fireEvent.click(screen.getByText("active", { exact: true }));
    expect(screen.queryByText(/User used npm before switching/)).toBeNull();
    expect(screen.getByText(/User prefers concise answers/)).toBeTruthy();
  });

  it("retires a memory via the Forget button", async () => {
    const del = vi.spyOn(ipc, "memoryDelete").mockResolvedValue(null);
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue({ enabled: true, activeCount: 1 });
    vi.spyOn(ipc, "memoryList")
      .mockResolvedValueOnce([mem()])
      .mockResolvedValueOnce([mem({ status: "retired" })]);
    render(<MemoryPanel />);
    await waitFor(() => {
      expect(screen.getByText(/User prefers concise answers/)).toBeTruthy();
    });
    // Switch to "all" so the retired row stays visible after the refresh.
    fireEvent.click(screen.getByText("all", { exact: true }));
    await act(async () => {
      fireEvent.click(screen.getByText("Forget"));
    });
    expect(del).toHaveBeenCalledWith("mem_abc12345");
    await waitFor(() => {
      expect(screen.getByText(/· retired/)).toBeTruthy();
    });
  });

  it("adds a user-created memory", async () => {
    const create = vi.spyOn(ipc, "memoryCreate").mockResolvedValue(mem());
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue({ enabled: true, activeCount: 1 });
    vi.spyOn(ipc, "memoryList").mockResolvedValue([mem()]);
    render(<MemoryPanel />);
    const input = await screen.findByPlaceholderText(/Add a fact yourself/);
    await act(async () => {
      fireEvent.change(input, { target: { value: "Prefers tabs" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Add"));
    });
    const call = create.mock.calls[0];
    expect(call?.[0]).toBe("Prefers tabs");
    expect(call?.[1]).toBe("fact");
  });
});
