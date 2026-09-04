// Tests for the Settings → Memory panel (MEMORY_DESIGN_ARCHITECTURE.md §12.2).
// Outside the Tauri runtime `safeInvoke` resolves null, so the panel must
// render its empty/off states without exploding; with mocked ipc responses it
// lists memories, applies filters, and exercises edit/retire flows.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** Status mock pre-filled with the document fields the panel now renders.
 *  The document text is deliberately distinct from any record content so
 *  getByText assertions stay unambiguous. */
function status(overrides: Partial<ipc.MemoryStatusView> = {}): ipc.MemoryStatusView {
  return {
    enabled: true,
    activeCount: 1,
    document: "# Profile\n\n- example memory document line",
    documentStored: false,
    documentUpdatedAt: null,
    documentBudget: 2200,
    extractModel: "",
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
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue(status({ activeCount: 2 }));
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
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue(status());
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
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue(status());
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

  it("shows the effective memory document with its token budget", async () => {
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue(status());
    vi.spyOn(ipc, "memoryList").mockResolvedValue([mem()]);
    render(<MemoryPanel />);
    const editor = await screen.findByTestId("memory-doc");
    const ta = editor.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta.value).toContain("example memory document line");
    // Rough estimate (4 chars/token) against the 2200 budget.
    expect(editor.textContent).toContain(`~${Math.ceil(ta.value.length / 4)} / 2200 tokens`);
  });

  it("saves an edited document via memorySetDocument", async () => {
    const setDoc = vi.spyOn(ipc, "memorySetDocument").mockResolvedValue(null);
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue(status());
    vi.spyOn(ipc, "memoryList").mockResolvedValue([mem()]);
    render(<MemoryPanel />);
    const ta = (await screen.findByTestId("memory-doc")).querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).not.toBe(""));
    await act(async () => {
      fireEvent.change(ta, { target: { value: "# Profile\n\n- Edited by hand" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Save document"));
    });
    expect(setDoc).toHaveBeenCalledWith("# Profile\n\n- Edited by hand");
  });

  it("blocks saving when the document is over the injection budget", async () => {
    const setDoc = vi.spyOn(ipc, "memorySetDocument").mockResolvedValue(null);
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue(status({ document: "" }));
    vi.spyOn(ipc, "memoryList").mockResolvedValue([]);
    render(<MemoryPanel />);
    const ta = (await screen.findByTestId("memory-doc")).querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe(""));
    const over = "x".repeat(2200 * 4 + 100); // past the 2200-token budget
    await act(async () => {
      fireEvent.change(ta, { target: { value: over } });
    });
    const save = screen.getByText("Save document") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(setDoc).not.toHaveBeenCalled();
  });

  it("confirms the purge in an in-app modal gated on typing DELETE", async () => {
    const purge = vi.spyOn(ipc, "memoryPurge").mockResolvedValue(3);
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue(status());
    vi.spyOn(ipc, "memoryList").mockResolvedValue([mem()]);
    render(<MemoryPanel />);
    await act(async () => {
      fireEvent.click(screen.getByText("Delete all…"));
    });
    // No native prompt: a modal opens, disabled until DELETE is typed.
    const dialog = await screen.findByRole("dialog");
    const confirmBtn = within(dialog).getByText("Delete everything") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    const input = within(dialog).getByPlaceholderText(/Type DELETE to confirm/);
    await act(async () => {
      fireEvent.change(input, { target: { value: "DELETE" } });
    });
    expect(confirmBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    expect(purge).toHaveBeenCalled();
    // Modal closes after confirming.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancels the purge without deleting", async () => {
    const purge = vi.spyOn(ipc, "memoryPurge").mockResolvedValue(0);
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue(status());
    vi.spyOn(ipc, "memoryList").mockResolvedValue([mem()]);
    render(<MemoryPanel />);
    await act(async () => {
      fireEvent.click(screen.getByText("Delete all…"));
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByText("Cancel"));
    });
    expect(purge).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("switches to the audit log tab and lists recent ops", async () => {
    vi.spyOn(ipc, "memoryStatus").mockResolvedValue(status());
    vi.spyOn(ipc, "memoryList").mockResolvedValue([mem()]);
    const opsFn = vi.spyOn(ipc, "memoryRecentOps").mockResolvedValue([
      {
        id: 1,
        ts: 1_700_000_000,
        actor: "judge",
        sessionId: null,
        candidate: "User prefers concise answers",
        operation: "ADD",
        targetIds: ["mem_abc12345"],
        rationale: "",
      },
    ]);
    render(<MemoryPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Audit log" }));
    });
    await waitFor(() => {
      expect(screen.getByText("ADD")).toBeTruthy();
    });
    expect(opsFn).toHaveBeenCalled();
  });
});
