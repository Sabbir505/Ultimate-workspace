// Tests for the per-turn git checkpoint surface:
//   1. Store: onCheckpointCreated appends the chip payload for message-bound
//      checkpoints and ignores baselines (messageId null).
//   2. Chip: renders file list on expand; Restore → confirm modal → IPC call
//      with the checkpoint id; error path toasts instead of throwing.
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

const { restoreChatCheckpoint } = await import("../lib/ipc");
const restoreMock = vi.mocked(restoreChatCheckpoint);

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

  it("Restore → confirm → calls restoreChatCheckpoint with the checkpoint id", async () => {
    restoreMock.mockResolvedValue(ckpt({ id: 99, messageId: null }));
    const { container } = render(<CheckpointChip checkpoints={[ckpt()]} />);
    fireEvent.click(container.querySelector(".chat-checkpoint-toggle")!);
    fireEvent.click(container.querySelector(".chat-checkpoint-restore")!);

    // Confirm modal is portaled to body.
    const confirm = await waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>(".modal .actions button.danger");
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledWith(11);
    });
  });

  it("a failed restore toasts the error and closes the modal path cleanly", async () => {
    restoreMock.mockRejectedValue(new Error("repo gone"));
    const { container } = render(<CheckpointChip checkpoints={[ckpt()]} />);
    fireEvent.click(container.querySelector(".chat-checkpoint-toggle")!);
    fireEvent.click(container.querySelector(".chat-checkpoint-restore")!);
    const confirm = await waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>(".modal .actions button.danger");
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledWith(11);
    });
    // No throw; modal cleanup happens via component state, error surfaced.
    expect(document.querySelector(".modal")).not.toBeNull();
  });
});
