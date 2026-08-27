// Tests for the consolidated per-turn changes row (TurnChangesRow) — the
// single card that replaced the stacked FilesChangedSummary + artifact chip +
// CheckpointChip under an assistant turn:
//   1. Store: onCheckpointCreated appends message-bound checkpoints and
//      ignores baselines (messageId null).
//   2. Header: "N files changed +adds −dels" + Undo; duplicate diff blocks
//      for one path merge into a single row with summed stats.
//   3. Expand: per-file rows with Review / Open; checkpoint-only files (no
//      diff block, e.g. shell-made edits) show A/M/D pills and no Review.
//   4. Open: artifact files route to onPreviewArtifact (preview pane);
//      everything else opens the file preview as a tool-panel tab, resolving
//      stale paths (relative → project root, missing → basename search).
//   5. Undo → confirm modal (checkbox default ON) → IPC restore with the
//      checkpoint id + rollback flag; success refetches the conversation and
//      toasts the rolled-back message count; errors toast instead of throwing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  restoreChatCheckpoint: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  getGitStatus: vi.fn(),
  listChatCheckpoints: vi.fn(),
  getFileMtime: vi.fn(),
  findFileByBasename: vi.fn(),
}));

const { restoreChatCheckpoint, toastSuccess, toastError, getGitStatus, listChatCheckpoints } =
  await import("../lib/ipc");
const { getFileMtime, findFileByBasename } = await import("../lib/ipc");
const restoreMock = vi.mocked(restoreChatCheckpoint);
const toastSuccessMock = vi.mocked(toastSuccess);
const toastErrorMock = vi.mocked(toastError);
const getGitStatusMock = vi.mocked(getGitStatus);
const listCheckpointsMock = vi.mocked(listChatCheckpoints);

import { useChatStore } from "../state/chat";
import { useProjectsStore } from "../state/projects";
import { useUiStore } from "../state/ui";
import {
  sameTurnFile,
  TurnChangesRow,
  type TurnFileChange,
} from "../components/chat/TurnChangesRow";
import type { EditPayload } from "../components/chat/DiffCard";
import type { ChatCheckpoint } from "../lib/ipc";
import type { ChatArtifact } from "../state/chat";

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

const replace = (find: string, replacement: string): EditPayload => ({
  mode: "replace",
  find,
  replace: replacement,
});

function diffFiles(): TurnFileChange[] {
  return [
    // +2 −1
    { path: "src/main.rs", edit: replace("fn old() {}", "fn new() {}\nfn extra() {}") },
    // +2 −0
    { path: "docs/new.md", edit: { mode: "write", content: "# hi\nmore" } },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ checkpointsByMessage: {} });
  useProjectsStore.setState({
    selectedProjectId: "p1",
    projects: [{ id: "p1", path: "D:/proj" } as never],
    gitStatuses: { p1: { isRepo: true, branch: "main", dirty: true, ahead: 0, behind: 0 } },
  });
  useUiStore.setState({ openTabs: [], activeTabId: null, nextTabId: 1, diffPanelFile: null, diffPanelCwd: null });
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

describe("TurnChangesRow header", () => {
  it("renders one row with the file count, +/- stats and an Undo button", () => {
    const { container } = render(
      <TurnChangesRow files={diffFiles()} checkpoints={[ckpt()]} />,
    );
    const toggle = container.querySelector<HTMLButtonElement>(".chat-turn-changes-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toContain("2 files changed");
    expect(toggle!.textContent).toContain("+4");
    expect(toggle!.textContent).toContain("−1");
    // The checkpoint surfaces as the row's Undo button, not a separate chip.
    expect(container.querySelector(".chat-turn-changes-undo")).not.toBeNull();
    // Collapsed by default — no file list yet.
    expect(container.querySelectorAll(".chat-files-row")).toHaveLength(0);
  });

  it("merges duplicate diff blocks for the same path into one row with summed stats", () => {
    const files: TurnFileChange[] = [
      { path: "a.ts", edit: replace("x", "y\nz") }, // +2 −1
      { path: "a.ts", edit: replace("w", "v") }, // +1 −1
    ];
    const { container } = render(<TurnChangesRow files={files} checkpoints={[]} />);
    expect(container.querySelector(".chat-turn-changes-toggle")!.textContent).toContain(
      "1 file changed",
    );
    expect(container.querySelector(".chat-turn-changes-toggle")!.textContent).toContain("+3");
    expect(container.querySelector(".chat-turn-changes-toggle")!.textContent).toContain("−2");
  });

  it("renders a checkpoint-only turn (no diff blocks) with the checkpoint label", () => {
    const { container } = render(<TurnChangesRow files={[]} checkpoints={[ckpt()]} />);
    const toggle = container.querySelector<HTMLButtonElement>(".chat-turn-changes-toggle");
    expect(toggle!.textContent).toContain("Checkpoint ·");
    expect(container.querySelector(".chat-turn-changes-undo")).not.toBeNull();
  });

  it("renders neither stats nor undo without files or checkpoints", () => {
    const { container } = render(<TurnChangesRow files={[]} checkpoints={[]} />);
    expect(container.querySelector(".chat-turn-changes")).toBeNull();
  });
});

describe("TurnChangesRow expanded file list", () => {
  it("lists each changed file with stats and Review / Open buttons", () => {
    const { container } = render(
      <TurnChangesRow files={diffFiles()} checkpoints={[ckpt()]} />,
    );
    fireEvent.click(container.querySelector(".chat-turn-changes-toggle")!);

    const rows = container.querySelectorAll(".chat-files-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("main.rs");
    expect(rows[0].textContent).toContain("+2");
    expect(rows[0].textContent).toContain("−1");
    expect(rows[0].querySelector(".chat-files-review")).not.toBeNull();
    expect(rows[0].querySelector(".chat-files-open")).not.toBeNull();
    expect(rows[1].textContent).toContain("new.md");
  });

  it("checkpoint-only files show status pills and Open but no Review", () => {
    const { container } = render(<TurnChangesRow files={[]} checkpoints={[ckpt()]} />);
    fireEvent.click(container.querySelector(".chat-turn-changes-toggle")!);

    const rows = container.querySelectorAll(".chat-files-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("modified");
    expect(rows[1].textContent).toContain("added");
    expect(rows[0].querySelector(".chat-files-review")).toBeNull();
    expect(rows[0].querySelector(".chat-files-open")).not.toBeNull();
  });

  it("Open routes artifact files to onPreviewArtifact", () => {
    const artifact: ChatArtifact = { path: "D:/proj/site/js/engine.js", filename: "engine.js" };
    const onPreviewArtifact = vi.fn();
    const files: TurnFileChange[] = [
      { path: "site/js/engine.js", edit: { mode: "write", content: "x" } },
    ];
    const { container } = render(
      <TurnChangesRow
        files={files}
        checkpoints={[]}
        artifacts={[artifact]}
        onPreviewArtifact={onPreviewArtifact}
      />,
    );
    fireEvent.click(container.querySelector(".chat-turn-changes-toggle")!);
    fireEvent.click(container.querySelector(".chat-files-open")!);
    expect(onPreviewArtifact).toHaveBeenCalledWith(artifact);
  });

  it("Open sends non-artifact files to the tool-panel preview tab (not the peek overlay)", async () => {
    useProjectsStore.setState({
      selectedProjectId: "p1",
      projects: [{ id: "p1", path: "D:/proj" } as never],
    });
    const { container } = render(<TurnChangesRow files={diffFiles()} checkpoints={[]} />);
    fireEvent.click(container.querySelector(".chat-turn-changes-toggle")!);
    const openButtons = container.querySelectorAll<HTMLButtonElement>(".chat-files-open");
    fireEvent.click(openButtons[1]); // docs/new.md — no artifact match

    // Same destination as artifacts: a named tab in the right-side tool panel
    // showing the file preview. The peek overlay is not the "Open" target.
    await waitFor(() => {
      const ui = useUiStore.getState();
      const tab = ui.openTabs.find((t) => t.artifactPath?.endsWith("docs/new.md"));
      expect(tab).toBeDefined();
      expect(ui.activeTabId).toBe(tab!.instanceId);
      expect(ui.toolPanelCollapsed).toBe(false);
      expect(ui.peek.open).toBe(false);
    });
  });

  it("Open anchors a relative change path to the project root", async () => {
    useProjectsStore.setState({
      selectedProjectId: "p1",
      projects: [{ id: "p1", path: "D:/proj" } as never],
    });
    vi.mocked(getFileMtime).mockResolvedValue(42); // file exists at the joined path
    const { container } = render(
      <TurnChangesRow
        files={[{ path: "docs/new.md", edit: { mode: "write", content: "x" } }]}
        checkpoints={[]}
      />,
    );
    fireEvent.click(container.querySelector(".chat-turn-changes-toggle")!);
    fireEvent.click(container.querySelector(".chat-files-open")!);

    await waitFor(() => {
      const tab = useUiStore
        .getState()
        .openTabs.find((t) => t.artifactPath === "D:/proj/docs/new.md");
      expect(tab).toBeDefined();
    });
    // Existed on disk at the anchored path — no basename search needed.
    expect(findFileByBasename).not.toHaveBeenCalled();
  });

  it("Open recovers a stale recorded path via the project basename search", async () => {
    useProjectsStore.setState({
      selectedProjectId: "p1",
      projects: [{ id: "p1", path: "D:/proj" } as never],
    });
    // The recorded path is gone from disk; the real file lives elsewhere in
    // the project (the model stated a destination it didn't write to).
    vi.mocked(getFileMtime).mockResolvedValue(null);
    vi.mocked(findFileByBasename).mockResolvedValue("D:/proj/a3/deep/traffic.mmd");
    const { container } = render(
      <TurnChangesRow
        files={[{ path: "D:/elsewhere/traffic.mmd", edit: { mode: "write", content: "x" } }]}
        checkpoints={[]}
      />,
    );
    fireEvent.click(container.querySelector(".chat-turn-changes-toggle")!);
    fireEvent.click(container.querySelector(".chat-files-open")!);

    await waitFor(() => {
      const tab = useUiStore
        .getState()
        .openTabs.find((t) => t.artifactPath === "D:/proj/a3/deep/traffic.mmd");
      expect(tab).toBeDefined();
    });
  });
});

describe("TurnChangesRow review routing", () => {
  function clickFirstReview(container: HTMLElement) {
    fireEvent.click(container.querySelector(".chat-files-review")!);
  }

  it("opens the Changes tab when the project is a git repo", () => {
    const { container } = render(<TurnChangesRow files={diffFiles()} checkpoints={[]} />);
    fireEvent.click(container.querySelector(".chat-turn-changes-toggle")!);
    clickFirstReview(container);

    const ui = useUiStore.getState();
    expect(ui.diffPanelFile).toBe("src/main.rs");
    expect(ui.openTabs.some((t) => t.kind === "files")).toBe(true);
  });

  it("opens the file as a named tab when the folder is not a git repo", () => {
    useProjectsStore.setState({
      gitStatuses: { p1: { isRepo: false, branch: null, dirty: false, ahead: 0, behind: 0 } },
    });
    const { container } = render(<TurnChangesRow files={diffFiles()} checkpoints={[]} />);
    fireEvent.click(container.querySelector(".chat-turn-changes-toggle")!);
    clickFirstReview(container);

    const ui = useUiStore.getState();
    // No Changes tab, no diff target — the file itself opens as a tab whose
    // label is the filename + extension.
    expect(ui.openTabs.some((t) => t.kind === "files")).toBe(false);
    expect(ui.diffPanelFile).toBeNull();
    const artifactTab = ui.openTabs.find((t) => t.kind === "artifact");
    expect(artifactTab?.artifactPath).toBe("src/main.rs");
    expect(artifactTab?.artifactFilename).toBe("main.rs");
  });

  it("asks the backend when the git-status cache is empty, then routes", async () => {
    useProjectsStore.setState({ gitStatuses: {} });
    getGitStatusMock.mockResolvedValue({
      isRepo: false,
      branch: null,
      dirty: false,
      ahead: 0,
      behind: 0,
    });
    const { container } = render(<TurnChangesRow files={diffFiles()} checkpoints={[]} />);
    fireEvent.click(container.querySelector(".chat-turn-changes-toggle")!);
    clickFirstReview(container);

    await waitFor(() => {
      expect(useUiStore.getState().openTabs.some((t) => t.kind === "artifact")).toBe(true);
    });
    expect(getGitStatusMock).toHaveBeenCalledWith("D:/proj");
  });
});

describe("TurnChangesRow undo (checkpoint restore)", () => {
  // The session timeline the backend would return: a baseline taken before
  // the first turn, then this turn's own checkpoint (id 11).
  const baseline = ckpt({ id: 10, messageId: null, files: [] });

  /** Click Undo and return the modal's danger button. */
  async function openConfirm(container: HTMLElement) {
    fireEvent.click(container.querySelector(".chat-turn-changes-undo")!);
    return waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>(".modal .actions button.danger");
      expect(btn).not.toBeNull();
      return btn!;
    });
  }

  it("Undo → confirm → restores the PREVIOUS checkpoint (state before the turn)", async () => {
    listCheckpointsMock.mockResolvedValue([baseline, ckpt()]);
    restoreMock.mockResolvedValue({ safety: ckpt({ id: 99, messageId: null }), deletedMessages: 0 });
    vi.spyOn(useChatStore.getState(), "loadMessages").mockResolvedValue(undefined);
    const { container } = render(<TurnChangesRow files={diffFiles()} checkpoints={[ckpt()]} />);

    const confirm = await openConfirm(container);
    // The rollback checkbox is checked by default.
    const box = document.querySelector<HTMLInputElement>(".chat-checkpoint-rollback input");
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(true);

    fireEvent.click(confirm);

    // The turn's OWN checkpoint (11) must NOT be the restore target — undoing
    // it would be a no-op since it already contains the turn's file changes.
    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledWith(10, true);
    });
    expect(restoreMock).not.toHaveBeenCalledWith(11, expect.anything());
  });

  it("unchecking the rollback box restores the tree only", async () => {
    listCheckpointsMock.mockResolvedValue([baseline, ckpt()]);
    restoreMock.mockResolvedValue({ safety: ckpt({ id: 99, messageId: null }), deletedMessages: 0 });
    vi.spyOn(useChatStore.getState(), "loadMessages").mockResolvedValue(undefined);
    const { container } = render(<TurnChangesRow files={diffFiles()} checkpoints={[ckpt()]} />);

    const confirm = await openConfirm(container);
    fireEvent.click(document.querySelector(".chat-checkpoint-rollback input")!);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledWith(10, false);
    });
  });

  it("a successful restore refetches the conversation and toasts the message count", async () => {
    listCheckpointsMock.mockResolvedValue([baseline, ckpt()]);
    restoreMock.mockResolvedValue({ safety: ckpt({ id: 99, messageId: null }), deletedMessages: 2 });
    const loadMessages = vi
      .spyOn(useChatStore.getState(), "loadMessages")
      .mockResolvedValue(undefined);
    const { container } = render(<TurnChangesRow files={diffFiles()} checkpoints={[ckpt()]} />);

    const confirm = await openConfirm(container);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(loadMessages).toHaveBeenCalledWith("s1");
    });
    expect(toastSuccessMock).toHaveBeenCalled();
    const [title, detail] = toastSuccessMock.mock.calls[0];
    expect(title).toBe("Turn undone — workspace rolled back");
    expect(detail).toContain("2 messages rolled back");
  });

  it("a failed restore toasts the error and leaves the modal open", async () => {
    listCheckpointsMock.mockResolvedValue([baseline, ckpt()]);
    restoreMock.mockRejectedValue(new Error("repo gone"));
    const { container } = render(<TurnChangesRow files={diffFiles()} checkpoints={[ckpt()]} />);

    const confirm = await openConfirm(container);
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    // No throw; modal cleanup happens via component state, error surfaced.
    expect(document.querySelector(".modal")).not.toBeNull();
  });

  it("the earliest checkpoint has nothing to undo — error toast, no restore call", async () => {
    listCheckpointsMock.mockResolvedValue([ckpt()]);
    const { container } = render(<TurnChangesRow files={diffFiles()} checkpoints={[ckpt()]} />);

    const confirm = await openConfirm(container);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Nothing to undo", expect.any(String));
    });
    expect(restoreMock).not.toHaveBeenCalled();
    // The modal closed after reporting.
    await waitFor(() => {
      expect(document.querySelector(".modal.modal-checkpoint")).toBeNull();
    });
  });
});

describe("sameTurnFile", () => {
  it("matches relative and absolute spellings of the same file", () => {
    expect(sameTurnFile("site/js/engine.js", "D:/proj/site/js/engine.js")).toBe(true);
    expect(sameTurnFile("D:\\proj\\index.html", "index.html")).toBe(true);
    expect(sameTurnFile("index.html", "./index.html")).toBe(true);
    // Last-segment semantics: a bare filename matches a deeper path with the
    // same basename. write_file artifacts carry the tool call's exact path so
    // exact matching covers real traffic; the suffix rule only tolerates
    // absolute/relative drift.
    expect(sameTurnFile("index.html", "other/index.html")).toBe(true);
    expect(sameTurnFile("a.ts", "b.ts")).toBe(false);
  });
});
