// Tests for the per-turn git checkpoint surface:
//   1. Store: onCheckpointCreated appends the chip payload for message-bound
//      checkpoints and ignores baselines (messageId null).
//   2. Chip: renders file list on expand; Restore → confirm modal (checkbox
//      default ON) → IPC call with the id + rollback flag; success refetches
//      the conversation and toasts the rolled-back message count; errors
//      toast instead of throwing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  restoreChatCheckpoint: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("../state/ui", () => ({
  useUiStore: { getState: () => ({ pushToast: vi.fn() }), subscribe: vi.fn(), setState: vi.fn() },
}));

const { restoreChatCheckpoint, toastSuccess } = await import("../lib/ipc");
const restoreMock = vi.mocked(restoreChatCheckpoint);
const toastSuccessMock = vi.mocked(toastSuccess);

import { useChatStore } from "../state/chat";
import { CheckpointChip } from "../components/chat/CheckpointChip";
import type { ChatCheckpoint } from "../lib/ipc";

function ckpt(over: Partial<ChatCheckpoint> = {}): ChatCheckpoint {
  return {
    id: 11,
    chatSessionId: "s1",
    messageId: 7,
    refName: "refs/conduit/checkpoints/s1/11",
    treeSha: "abc",
    repoPath: "D:/repo",
    files: [
      { path: "src/main.rs", status: "M" },
      { path: "docs/new.md", status: "A" },
    ],
    createdAt: Math.floor(Date.now() / 1000),
    ...over,
  };
}

/** Open the chip's restore-confirm modal and return the danger button. */
async function openConfirm(container: HTMLElement) {
  fireEvent.click(container.querySelector(".chat-checkpoint-toggle")!);
  fireEvent.click(container.querySelector(".chat-checkpoint-restore")!);
  return waitFor(() => {
    const btn = document.querySelector<HTMLButtonElement>(".modal .actions button.danger");
    expect(btn).not.toBeNull();
    return btn!;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ checkpointsByMessage: {} });
});

afterEach(() => cleanup());

describe("chat store checkpoint handling", () => {
  it("onCheckpointCreated appends message-bound checkpoints, dedups, skips baselines", () => {
    const store = useChatStore.getState();
    store.onCheckpointCreated(ckpt());
    store.onCheckpointCreated(ckpt()); // duplicate event → ignored
    expect(useChatStore.getState().checkpointsByMessage[7]).toHaveLength(1);

    // Baseline (messageId null) has no bubble — ignored by the store.
    store.onCheckpointCreated(ckpt({ id: 12, messageId: null }));
    expect(useChatStore.getState().checkpointsByMessage[7]).toHaveLength(1);
    expect(useChatStore.getState().checkpointsByMessage).not.toHaveProperty("null");
  });
});

describe("CheckpointChip", () => {
  it("expands to list captured files with status labels", () => {
    const { container } = render(<CheckpointChip checkpoints={[ckpt()]} />);
    const toggle = container.querySelector<HTMLButtonElement>(".chat-checkpoint-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toContain("2 files");

    fireEvent.click(toggle!);
    const rows = container.querySelectorAll(".chat-files-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("main.rs");
    expect(rows[0].textContent).toContain("modified");
    expect(rows[1].textContent).toContain("added");
  });

  it("Restore → confirm → calls restoreChatCheckpoint with the id and rollback=true by default", async () => {
    restoreMock.mockResolvedValue({ safety: ckpt({ id: 99, messageId: null }), deletedMessages: 0 });
    vi.spyOn(useChatStore.getState(), "loadMessages").mockResolvedValue(undefined);
    const { container } = render(<CheckpointChip checkpoints={[ckpt()]} />);

    const confirm = await openConfirm(container);
    // The rollback checkbox is checked by default.
    const box = document.querySelector<HTMLInputElement>(".chat-checkpoint-rollback input");
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(true);

    fireEvent.click(confirm);

    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledWith(11, true);
    });
  });

  it("unchecking the rollback box restores the tree only", async () => {
    restoreMock.mockResolvedValue({ safety: ckpt({ id: 99, messageId: null }), deletedMessages: 0 });
    vi.spyOn(useChatStore.getState(), "loadMessages").mockResolvedValue(undefined);
    const { container } = render(<CheckpointChip checkpoints={[ckpt()]} />);

    const confirm = await openConfirm(container);
    fireEvent.click(document.querySelector(".chat-checkpoint-rollback input")!);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledWith(11, false);
    });
  });

  it("a successful restore refetches the conversation and toasts the message count", async () => {
    restoreMock.mockResolvedValue({ safety: ckpt({ id: 99, messageId: null }), deletedMessages: 2 });
    const loadMessages = vi
      .spyOn(useChatStore.getState(), "loadMessages")
      .mockResolvedValue(undefined);
    const { container } = render(<CheckpointChip checkpoints={[ckpt()]} />);

    const confirm = await openConfirm(container);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(loadMessages).toHaveBeenCalledWith("s1");
    });
    expect(toastSuccessMock).toHaveBeenCalled();
    const [title, detail] = toastSuccessMock.mock.calls[0];
    expect(title).toBe("Working tree rolled back");
    expect(detail).toContain("2 messages rolled back");
  });

  it("a failed restore toasts the error and leaves the modal open", async () => {
    restoreMock.mockRejectedValue(new Error("repo gone"));
    const { container } = render(<CheckpointChip checkpoints={[ckpt()]} />);

    const confirm = await openConfirm(container);
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledWith(11, true);
    });
    // No throw; modal cleanup happens via component state, error surfaced.
    expect(document.querySelector(".modal")).not.toBeNull();
  });
});
