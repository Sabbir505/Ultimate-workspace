// B5 (ISSUES.md): PeekPanel's async reads had no stale-guard. Clicking file A
// (slow read) then file B started both reads; when A's finally resolved LAST
// it overwrote B's content and the panel showed the wrong file. Each effect
// run must be invalidated by its cleanup so only the LATEST read may write.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFileText: vi.fn(),
  getGitDiff: vi.fn(),
  getGitFileDiff: vi.fn(),
}));

import { readFileText } from "../lib/ipc";
import { PeekPanel } from "../components/peek/PeekPanel";
import { useUiStore } from "../state/ui";
import { useProjectsStore } from "../state/projects";

const readFileMock = vi.mocked(readFileText);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({
    peek: { open: false, mode: "file", projectId: null, filePath: null, cwd: null },
  });
});

/** Deferred per path: lets the test control resolution ORDER (slow A, fast B). */
function deferReadsByPath() {
  const pending = new Map<string, Array<(v: string) => void>>();
  readFileMock.mockImplementation(
    (path: string) =>
      new Promise<string>((resolve) => {
        const q = pending.get(path) ?? [];
        q.push(resolve);
        pending.set(path, q);
      }),
  );
  return {
    resolve(path: string, value: string) {
      const q = pending.get(path) ?? [];
      const next = q.shift();
      if (next) next(value);
    },
  };
}

function openPeek(filePath: string) {
  act(() => {
    useUiStore.getState().openPeek({ mode: "file", projectId: "p1", filePath, cwd: null });
  });
}

describe("PeekPanel async read stale-guard", () => {
  it("shows target B's content when a slow read for A resolves last", async () => {
    useProjectsStore.setState({
      selectedProjectId: "p1",
      projects: [
        { id: "p1", name: "P1", path: "D:/proj", isGitRepo: false, createdAt: 1, lastOpenedAt: null } as never,
      ],
    });
    const reads = deferReadsByPath();
    openPeek("D:/proj/a.txt");
    render(<PeekPanel />);

    // The A read started (slow — still pending) and the panel shows loading.
    await waitFor(() => {
      expect(readFileMock).toHaveBeenCalledWith("D:/proj/a.txt");
    });
    expect(screen.getByText("Loading…")).toBeTruthy();

    // Switch the peek target to B; its read resolves immediately.
    openPeek("D:/proj/b.txt");
    await waitFor(() => {
      expect(readFileMock).toHaveBeenCalledWith("D:/proj/b.txt");
    });
    reads.resolve("D:/proj/b.txt", "content of B");
    await waitFor(() => {
      expect(screen.getByText("content of B")).toBeTruthy();
    });

    // NOW the slow A read resolves — it must NOT overwrite B's content.
    await act(async () => {
      reads.resolve("D:/proj/a.txt", "stale content of A");
      await Promise.resolve();
    });
    expect(screen.getByText("content of B")).toBeTruthy();
    expect(screen.queryByText("stale content of A")).toBeNull();
  });
});
