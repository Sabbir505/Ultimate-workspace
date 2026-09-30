// The Subagents page's "Native subagents" section (NativeSubagents): the
// per-harness listing of the CLI harnesses' own markdown stores, importing a
// file into the registry as a LINKED row, and the inline empty/error states.
//
// The ipc module is mocked with an explicit export list (the acpAgents.test
// pattern — the real state/subagents store imports from it at module load,
// so every name it touches must exist); the zustand store itself stays REAL so
// the post-import registry refresh through store.load() is exercised, not
// assumed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listHarnessSubagentsMock = vi.fn();
const importHarnessSubagentMock = vi.fn();
const syncHarnessSubagentsMock = vi.fn();
const listSubagentsMock = vi.fn();

vi.mock("../lib/ipcCore", async (orig) => {
  const actual = await orig<typeof import("../lib/ipcCore")>();
  return { ...actual, safeListen: vi.fn().mockResolvedValue(() => {}) };
});

vi.mock("../lib/ipc", () => ({
  // Exactly the exports the component and state/subagents.ts import — an
  // unknown name here is a load-time failure, which is the point of the
  // explicit list.
  createSubagent: vi.fn().mockResolvedValue(null),
  listSubagents: (...a: unknown[]) => listSubagentsMock(...a),
  updateSubagent: vi.fn().mockResolvedValue(null),
  deleteSubagent: vi.fn().mockResolvedValue(undefined),
  runSubagent: vi.fn().mockResolvedValue(null),
  listSubagentRuns: vi.fn().mockResolvedValue([]),
  importHarnessSubagent: (...a: unknown[]) => importHarnessSubagentMock(...a),
  syncHarnessSubagents: (...a: unknown[]) => syncHarnessSubagentsMock(...a),
  unlinkNativeSubagent: vi.fn().mockResolvedValue(undefined),
  listHarnessSubagents: (...a: unknown[]) => listHarnessSubagentsMock(...a),
}));

// Backs the project-root lookup. `projects` is a mutable binding the
// project-root test reassigns before rendering.
const projectState: { selectedProjectId: string | null; projects: { id: string; path: string }[] } =
  { selectedProjectId: null, projects: [] };
vi.mock("../state/projects", () => ({
  useProjectsStore: (selector: (s: unknown) => unknown) => selector(projectState),
}));

import { NativeSubagents } from "../components/subagents/NativeSubagents";
import { useSubagentStore } from "../state/subagents";
import type { HarnessSubagentInfo } from "../lib/ipc";
import type { Subagent } from "../lib/ipc/subagents";

const REVIEWER_PATH = "C:\\Users\\dev\\.claude\\agents\\code-reviewer.md";

function native(over: Partial<HarnessSubagentInfo> = {}): HarnessSubagentInfo {
  return {
    name: "code-reviewer",
    description: "Reviews diffs",
    tools: ["read_file", "search_content"],
    model: "claude-sonnet-4",
    sourcePath: REVIEWER_PATH,
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

beforeEach(() => {
  vi.clearAllMocks();
  projectState.selectedProjectId = null;
  projectState.projects = [];
  listSubagentsMock.mockResolvedValue([]);
  importHarnessSubagentMock.mockImplementation(async () =>
    registryAgent({
      id: "agent-new",
      name: "code-reviewer",
      engine: "harness:claude_code",
      sourcePath: REVIEWER_PATH,
    }),
  );
  syncHarnessSubagentsMock.mockResolvedValue({
    created: ["code-reviewer"],
    updated: [],
    unchanged: [],
    missing: [],
  });
  useSubagentStore.setState({
    agents: [],
    error: null,
    busy: {},
    loaded: true,
    runs: {},
    runsLoaded: false,
    missingNative: [],
  });
});
afterEach(cleanup);

describe("NativeSubagents", () => {
  it("probes on mount, renders the rows with their per-file facts", async () => {
    listHarnessSubagentsMock.mockImplementation(async (harnessId: string) =>
      harnessId === "claude_code"
        ? [
            native({ mode: "subagent" }),
            native({
              name: "doc-writer",
              description: "Writes docs",
              tools: ["read_file"],
              model: undefined,
              sourcePath: "C:\\Users\\dev\\.claude\\agents\\doc-writer.md",
            }),
          ]
        : [],
    );
    render(<NativeSubagents />);

    // The card is open by default: an agent a harness just wrote has to be
    // visible without the user going looking for a disclosure.
    expect(await screen.findByText("code-reviewer")).toBeTruthy();
    expect(screen.getByText("doc-writer")).toBeTruthy();
    expect(screen.getByText(/2 tools/)).toBeTruthy();
    expect(screen.getByText(/1 tool/)).toBeTruthy();
    expect(screen.getByText("subagent")).toBeTruthy();
    expect(screen.getByText("claude-sonnet-4")).toBeTruthy();
  });

  it("imports through the backend so the row is LINKED to the file, not a copy", async () => {
    listHarnessSubagentsMock.mockImplementation(async (harnessId: string) =>
      harnessId === "claude_code" ? [native()] : [],
    );
    render(<NativeSubagents />);
    fireEvent.click(await screen.findByLabelText("Import code-reviewer"));

    await waitFor(() => expect(importHarnessSubagentMock).toHaveBeenCalledTimes(1));
    // The client names the FILE and the backend re-reads it, so nothing about
    // the row's content (slugged name, de-collided, allowlist) is decided here.
    expect(importHarnessSubagentMock).toHaveBeenCalledWith(
      "claude_code",
      REVIEWER_PATH,
      null,
    );
    // The registry list refreshed through the store after the import.
    await waitFor(() => expect(listSubagentsMock).toHaveBeenCalled());
  });

  it("marks a file as linked once a registry row points at it, and offers Update", async () => {
    useSubagentStore.setState({
      agents: [
        registryAgent({
          id: "agent-1",
          name: "code-reviewer",
          engine: "harness:claude_code",
          sourcePath: REVIEWER_PATH,
        }),
      ],
    });
    listHarnessSubagentsMock.mockImplementation(async (harnessId: string) =>
      harnessId === "claude_code" ? [native()] : [],
    );
    render(<NativeSubagents />);

    // "linked" comes from the REGISTRY, not from what this component instance
    // happens to have imported — so remounting can't offer a duplicate import.
    expect(await screen.findByText("linked")).toBeTruthy();
    expect(screen.getByLabelText("Update code-reviewer")).toBeTruthy();
    expect(screen.queryByLabelText("Import code-reviewer")).toBeNull();
  });

  it("counts unlinked files and imports them all in one action", async () => {
    listHarnessSubagentsMock.mockImplementation(async (harnessId: string) =>
      harnessId === "claude_code"
        ? [native(), native({ name: "doc-writer", sourcePath: "C:\\d.md" })]
        : [],
    );
    render(<NativeSubagents />);
    const bulk = await screen.findByRole("button", { name: /Import all \(2\)/ });
    fireEvent.click(bulk);
    await waitFor(() => expect(syncHarnessSubagentsMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Harness stores synced.")).toBeTruthy();
    // The registry reloads so the panel shows the rows the backend stored.
    await waitFor(() => expect(listSubagentsMock).toHaveBeenCalled());
  });

  it("hides the bulk action once every file is linked", async () => {
    useSubagentStore.setState({
      agents: [
        registryAgent({ id: "agent-1", name: "code-reviewer", sourcePath: REVIEWER_PATH }),
      ],
    });
    listHarnessSubagentsMock.mockImplementation(async (harnessId: string) =>
      harnessId === "claude_code" ? [native()] : [],
    );
    render(<NativeSubagents />);
    await screen.findByText("linked");
    expect(screen.queryByRole("button", { name: /Import all/ })).toBeNull();
  });

  it("passes the active project's root so project-scoped stores are walked", async () => {
    projectState.selectedProjectId = "p1";
    projectState.projects = [{ id: "p1", path: "/repo" }];
    listHarnessSubagentsMock.mockResolvedValue([]);
    render(<NativeSubagents />);
    await waitFor(() => expect(listHarnessSubagentsMock).toHaveBeenCalled());
    // Without this the backend only walks the `~/`-level stores, which is why a
    // project-scoped agent.md used to be invisible here.
    expect(listHarnessSubagentsMock).toHaveBeenCalledWith("claude_code", "/repo");
  });

  it("shows the shortened-dir empty state and the omp unpack hint", async () => {
    listHarnessSubagentsMock.mockResolvedValue([]);
    render(<NativeSubagents />);
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
    importHarnessSubagentMock.mockRejectedValue(new Error("name is reserved"));
    listHarnessSubagentsMock.mockImplementation(async (harnessId: string) =>
      harnessId === "claude_code" ? [native()] : [],
    );
    render(<NativeSubagents />);
    fireEvent.click(await screen.findByLabelText("Import code-reviewer"));
    expect(await screen.findByText(/Couldn't import code-reviewer: name is reserved/)).toBeTruthy();
    // A refused import leaves the row unlinked and still importable.
    expect(screen.getByLabelText("Import code-reviewer")).toBeTruthy();
  });
});
