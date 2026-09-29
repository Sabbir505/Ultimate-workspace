// The Subagents page's "Native subagents" section (NativeSubagents): the
// per-harness listing of the CLI harnesses' own markdown stores, the
// one-click Import onto the registry, and the inline empty/error states.
// The ipc module is mocked with an explicit export list (the acpAgents.test
// pattern — the real state/subagents store imports from it at module load,
// so every name it touches must exist); the zustand store itself stays REAL
// so the post-import registry refresh through store.load() is exercised, not
// assumed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listHarnessSubagentsMock = vi.fn();
const createSubagentMock = vi.fn();
const listSubagentsMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  // Exactly the exports the component and state/subagents.ts import — an
  // unknown name here is a load-time failure, which is the point of the
  // explicit list.
  createSubagent: (...a: unknown[]) => createSubagentMock(...a),
  listSubagents: (...a: unknown[]) => listSubagentsMock(...a),
  updateSubagent: vi.fn().mockResolvedValue(null),
  deleteSubagent: vi.fn().mockResolvedValue(undefined),
  runSubagent: vi.fn().mockResolvedValue(null),
  listSubagentRuns: vi.fn().mockResolvedValue([]),
  listHarnessSubagents: (...a: unknown[]) => listHarnessSubagentsMock(...a),
}));

import { NativeSubagents } from "../components/subagents/NativeSubagents";
import { useSubagentStore } from "../state/subagents";
import type { HarnessSubagentInfo } from "../lib/ipc";
import type { Subagent } from "../lib/ipc/subagents";

function native(over: Partial<HarnessSubagentInfo> = {}): HarnessSubagentInfo {
  return {
    name: "code-reviewer",
    description: "Reviews diffs",
    tools: ["read_file", "search_content"],
    model: "claude-sonnet-4",
    sourcePath: "C:\\Users\\dev\\.claude\\agents\\code-reviewer.md",
    promptMd: "You review code.",
    ...over,
  };
}

function registryAgent(over: Partial<Subagent> = {}): Subagent {
  return {
    id: "agent-1",
    name: "existing",
    description: "",
    promptMd: "",
    tools: null,
    engine: null,
    model: null,
    effort: null,
    sandboxPolicy: "read_only",
    approvalPolicy: "on_request",
    worktreePolicy: "inherit",
    maxRounds: 100,
    maxConcurrent: 2,
    builtin: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function expand() {
  fireEvent.click(screen.getByRole("button", { name: "Show native stores" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  listSubagentsMock.mockResolvedValue([]);
  createSubagentMock.mockImplementation(async () =>
    registryAgent({ id: "agent-new", name: "imported" }),
  );
  useSubagentStore.setState({
    agents: [],
    error: null,
    busy: {},
    loaded: true,
    runs: {},
    runsLoaded: false,
  });
});
afterEach(cleanup);

describe("NativeSubagents", () => {
  it("fetches on expand, renders the rows, and imports with the mapped payload", async () => {
    listHarnessSubagentsMock.mockImplementation(async (harnessId: string) =>
      harnessId === "claude_code"
        ? [native({ mode: "subagent" }), native({ name: "doc-writer", description: "Writes docs", tools: ["read_file"], model: undefined, promptMd: "You write docs.", sourcePath: "C:\\Users\\dev\\.claude\\agents\\doc-writer.md" })]
        : [],
    );
    render(<NativeSubagents />);
    // Collapsed by default: no probe until the user asks for the stores.
    expect(listHarnessSubagentsMock).not.toHaveBeenCalled();
    expect(screen.queryByText("code-reviewer")).toBeNull();

    expand();
    expect(await screen.findByText("code-reviewer")).toBeTruthy();
    expect(screen.getByText("doc-writer")).toBeTruthy();
    // Per-row facts: tool counts, the mode badge (first row only), model.
    expect(screen.getByText(/2 tools/)).toBeTruthy();
    expect(screen.getByText(/1 tool/)).toBeTruthy();
    expect(screen.getByText("subagent")).toBeTruthy();
    expect(screen.getByText("claude-sonnet-4")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Import code-reviewer"));
    await waitFor(() => expect(createSubagentMock).toHaveBeenCalledTimes(1));
    expect(createSubagentMock.mock.calls[0][0]).toEqual({
      name: "code-reviewer",
      description: "Reviews diffs",
      promptMd: "You review code.",
      tools: ["read_file", "search_content"],
      engine: "harness:claude_code",
      model: "claude-sonnet-4",
      effort: null,
      sandboxPolicy: "read_only",
      approvalPolicy: "on_request",
      worktreePolicy: "inherit",
      maxRounds: 100,
      maxConcurrent: 2,
    });
    // The registry list refreshed through the store after the import.
    await waitFor(() => expect(listSubagentsMock).toHaveBeenCalled());
    // The imported row is marked and its button disabled.
    const mark = await screen.findByText("Imported");
    expect(mark).toBeTruthy();
    expect(
      (screen.getByLabelText("Import code-reviewer") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("suffixes a native name that collides with an existing registry row", async () => {
    useSubagentStore.setState({
      agents: [registryAgent({ id: "agent-1", name: "code-reviewer" })],
    });
    listHarnessSubagentsMock.mockImplementation(async (harnessId: string) =>
      harnessId === "claude_code" ? [native()] : [],
    );
    render(<NativeSubagents />);
    expand();
    fireEvent.click(await screen.findByLabelText("Import code-reviewer"));
    await waitFor(() => expect(createSubagentMock).toHaveBeenCalledTimes(1));
    expect(createSubagentMock.mock.calls[0][0].name).toBe("code-reviewer-2");
  });

  it("shows the shortened-dir empty state and the omp unpack hint", async () => {
    listHarnessSubagentsMock.mockResolvedValue([]);
    render(<NativeSubagents />);
    expand();
    expect(
      await screen.findByText(/No native subagents found in ~\/\.omp\/agent\/agents/),
    ).toBeTruthy();
    // Only omp gets the unpack hint (its bundled agents need materializing).
    expect(screen.getByText("omp agents unpack")).toBeTruthy();
    expect(screen.getByText(/No native subagents found in ~\/\.claude\/agents/)).toBeTruthy();
  });

  it("keeps the section alive when one harness's probe fails", async () => {
    listHarnessSubagentsMock.mockImplementation(async (harnessId: string) => {
      if (harnessId === "claude_code") throw new Error("store walk failed");
      return [];
    });
    render(<NativeSubagents />);
    expand();
    // The failure is scoped to its harness…
    expect(await screen.findByText(/Couldn't list Claude Code's native subagents/)).toBeTruthy();
    expect(screen.getByText(/store walk failed/)).toBeTruthy();
    // …while the other stores still render their own empty states.
    expect(screen.getByText(/No native subagents found in ~\/\.omp\/agent\/agents/)).toBeTruthy();
    expect(
      screen.queryByText(/No native subagents found in ~\/\.claude\/agents/),
    ).toBeNull();
  });

  it("shows the import error inline when the backend refuses the row", async () => {
    createSubagentMock.mockRejectedValue(new Error("name is reserved"));
    listHarnessSubagentsMock.mockImplementation(async (harnessId: string) =>
      harnessId === "claude_code" ? [native()] : [],
    );
    render(<NativeSubagents />);
    expand();
    fireEvent.click(await screen.findByLabelText("Import code-reviewer"));
    expect(await screen.findByText(/Couldn't import code-reviewer: name is reserved/)).toBeTruthy();
    // A refused import does not mark the row imported.
    expect(screen.getByLabelText("Import code-reviewer")).toBeTruthy();
  });
});
