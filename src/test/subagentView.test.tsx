// Subagent view (Phase 2.5) — the Run surface.
//
// The stores are mocked as selector-callables over a mutable fixture (the
// subagentPanel.test.tsx style) so this covers the user-facing surface only:
// the runs list rendering, the Run modal's required-task gate, and what
// submitting actually calls. Store behavior lives in subagentRun.test.tsx and
// subagentStore.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// ---- subagent store fixture -------------------------------------------------
const load = vi.fn().mockResolvedValue(undefined);
const create = vi.fn().mockResolvedValue(null);
const update = vi.fn().mockResolvedValue(null);
const remove = vi.fn().mockResolvedValue(undefined);
const runNow = vi.fn().mockResolvedValue("sess-42");
const loadRuns = vi.fn().mockResolvedValue(undefined);

const subagentState = {
  loaded: true,
  agents: [] as unknown[],
  error: null as string | null,
  busy: {} as Record<string, boolean>,
  runs: {} as Record<string, unknown>,
  runsLoaded: true,
  load: (...a: unknown[]) => load(...a),
  create: (...a: unknown[]) => create(...a),
  update: (...a: unknown[]) => update(...a),
  remove: (...a: unknown[]) => remove(...a),
  runNow: (...a: unknown[]) => runNow(...a),
  loadRuns: (...a: unknown[]) => loadRuns(...a),
  ingestRun: vi.fn(),
  clearError: vi.fn(),
};
vi.mock("../state/subagents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/subagents")>();
  return {
    ...actual,
    useSubagentStore: Object.assign(
      (sel: (s: typeof subagentState) => unknown) => sel(subagentState),
      { getState: () => subagentState, setState: vi.fn() },
    ),
  };
});

// ---- projects / ui / chat fixtures --------------------------------------
const projectState = {
  loaded: true,
  projects: [
    { id: "proj-1", name: "Relay", path: "D:/projects/relay" },
    { id: "proj-2", name: "Site", path: "D:/projects/site" },
  ] as { id: string; name: string; path: string }[],
  loadAll: vi.fn().mockResolvedValue(undefined),
};
vi.mock("../state/projects", () => ({
  useProjectsStore: (sel: (s: typeof projectState) => unknown) => sel(projectState),
}));

const setActiveView = vi.fn();
const uiState = { setActiveView: (...a: unknown[]) => setActiveView(...a), setModalOpen: vi.fn() };
vi.mock("../state/ui", () => ({
  useUiStore: Object.assign(
    (sel: (s: typeof uiState) => unknown) => sel(uiState),
    { getState: () => uiState, setState: vi.fn(), subscribe: () => () => {} },
  ),
}));

const loadSessions = vi.fn().mockResolvedValue(undefined);
const selectSession = vi.fn().mockResolvedValue(undefined);
vi.mock("../state/chat", () => ({
  useChatStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ loadSessions, selectSession }),
    { getState: () => ({ loadSessions, selectSession }) },
  ),
}));

import { SubagentsView } from "../components/subagents/SubagentsView";
import type { Subagent, SubagentRun } from "../lib/ipc/subagents";

function agent(over: Partial<Subagent> = {}): Subagent {
  return {
    id: "agent-1",
    name: "doc-writer",
    description: "Writes and polishes user documentation",
    promptMd: "You are a doc writer.",
    tools: ["read_file"],
    engine: "builtin",
    model: "openrouter::x-ai/grok-4",
    effort: null,
    sandboxPolicy: "read_only",
    approvalPolicy: "on_request",
    worktreePolicy: "inherit",
    maxRounds: 40,
    maxConcurrent: 2,
    builtin: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "run-1",
    agentId: "agent-1",
    sessionId: "sess-9",
    trigger: "manual",
    task: "Write the README",
    engine: "builtin",
    model: "openai::gpt-5",
    worktree: null,
    startedAt: Math.floor(Date.now() / 1000),
    finishedAt: null,
    status: "running",
    summary: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  subagentState.agents = [agent()];
  subagentState.error = null;
  subagentState.busy = {};
  subagentState.runs = { "run-1": run() };
  subagentState.runsLoaded = true;
  runNow.mockResolvedValue("sess-42");
});
afterEach(cleanup);

/** The runs list's own region. The registry panel above repeats the agent
 *  name and the store's error, so list assertions must be scoped or they
 *  match two nodes. */
function runsList(): HTMLElement {
  return screen.getByRole("region", { name: "Subagent runs" });
}

describe("SubagentsView runs list", () => {
  it("asks for run history on mount", () => {
    render(<SubagentsView />);
    expect(loadRuns).toHaveBeenCalledWith();
  });

  it("renders agent name, task, trigger, engine, status and start time", () => {
    render(<SubagentsView />);
    const list = within(runsList());
    // The run's agent name, resolved from the registry (not the raw id).
    expect(list.getByText("doc-writer")).toBeTruthy();
    expect(list.getByText("Write the README")).toBeTruthy();
    expect(list.getByText("manual")).toBeTruthy();
    expect(list.getByText(/builtin/)).toBeTruthy();
    expect(list.getByText("Running")).toBeTruthy();
    expect(list.getByText(/started/)).toBeTruthy();
  });

  it("falls back to the id when the agent was deleted", () => {
    subagentState.agents = [];
    subagentState.runs = { "run-1": run({ agentId: "agent-gone", task: "orphaned run" }) };
    render(<SubagentsView />);
    const list = within(runsList());
    expect(list.getByText("agent-gone")).toBeTruthy();
    expect(list.getByText("orphaned run")).toBeTruthy();
  });

  it("shows an empty state when there is no history", () => {
    subagentState.runs = {};
    render(<SubagentsView />);
    expect(within(runsList()).getByText(/No runs yet/)).toBeTruthy();
  });

  it("surfaces a store error instead of an empty list", () => {
    subagentState.error = "Couldn't load run history: db locked";
    render(<SubagentsView />);
    expect(within(runsList()).getByText(/db locked/)).toBeTruthy();
  });

  it("opens the run's chat and switches to the chat view", async () => {
    render(<SubagentsView />);
    fireEvent.click(within(runsList()).getByLabelText("Open the run from doc-writer"));
    await waitFor(() => {
      expect(loadSessions).toHaveBeenCalled();
    });
    expect(selectSession).toHaveBeenCalledWith("sess-9");
    expect(setActiveView).toHaveBeenCalledWith("chat");
  });

  it("disables open for a run whose chat was deleted", () => {
    subagentState.runs = { "run-1": run({ sessionId: null }) };
    render(<SubagentsView />);
    const btn = within(runsList()).getByLabelText("Run chat deleted");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SubagentsView run modal", () => {
  it("opens from the registry row's Run button", () => {
    render(<SubagentsView />);
    expect(screen.queryByLabelText("Task")).toBeNull();
    fireEvent.click(screen.getByLabelText("Run doc-writer"));
    expect(screen.getByLabelText("Task")).toBeTruthy();
  });

  it("requires task text before the run can be submitted", () => {
    render(<SubagentsView />);
    fireEvent.click(screen.getByLabelText("Run doc-writer"));
    const submit = screen.getByRole("button", { name: "Run" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    // Whitespace is not a task.
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "   " } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(runNow).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Write the README" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers a project picker and a wait/background toggle", () => {
    render(<SubagentsView />);
    fireEvent.click(screen.getByLabelText("Run doc-writer"));
    // The project picker is a SubagentSelect: the option list exists while open.
    fireEvent.click(screen.getByLabelText("Project"));
    expect(
      screen.getAllByRole("option").map((o) => o.textContent?.replace("✓", "").trim()),
    ).toEqual(["No project — run project-less", "Relay", "Site"]);
    expect(screen.getByLabelText("Wait for the first turn to finish")).toBeTruthy();
  });

  it("submits the task, project and wait choice through runNow and closes", async () => {
    render(<SubagentsView />);
    fireEvent.click(screen.getByLabelText("Run doc-writer"));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "  Write the README  " } });
    fireEvent.click(screen.getByLabelText("Project"));
    fireEvent.click(await screen.findByRole("option", { name: "Site" }));
    fireEvent.click(screen.getByLabelText("Wait for the first turn to finish"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(runNow).toHaveBeenCalledWith("agent-1", "Write the README", "proj-2", true);
    });
    await waitFor(() => expect(screen.queryByLabelText("Task")).toBeNull());
  });

  it("keeps the modal open and explains a failed run", async () => {
    runNow.mockResolvedValueOnce(null);
    subagentState.error = "Couldn't run the agent: agent is at its concurrency limit";
    render(<SubagentsView />);
    fireEvent.click(screen.getByLabelText("Run doc-writer"));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Write the README" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      // Scoped to the dialog: the registry panel surfaces the same store
      // error beside it.
      expect(within(screen.getByRole("dialog")).getByText(/concurrency limit/)).toBeTruthy();
    });
    // Still open, so the task text isn't lost.
    expect(screen.getByLabelText("Task")).toBeTruthy();
  });

  it("does not open the modal for a run-history row when no agent is left", () => {
    subagentState.agents = [];
    subagentState.runs = { "run-1": run({ agentId: "agent-gone" }) };
    render(<SubagentsView />);
    expect(within(runsList()).queryByLabelText("Run agent-gone again")).toBeNull();
  });
});
