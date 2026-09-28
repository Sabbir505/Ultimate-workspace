// Crew Phase 2.5/3 — the run surface.
//
// Three contracts, all binding across the Rust/frontend waves:
//   1. `run_crew_agent` (+ export/import/list_crew_runs) argument shape. These
//      are CONTRACT names (research doc §F.3) — the Rust wave builds the
//      command against the same keys, so a rename here is a silent break
//      across the process boundary. Only the transport is mocked, so the real
//      wrapper → store path runs (crewStore.test.ts's pattern).
//   2. `useCrewStore.runNow`: busy → call → select the new session → busy off,
//      with the failure reason in the store's `error` string.
//   3. `meshSlice.onSessionSpawn`'s null-parent branch (§F.5): a manual crew
//      run emits the spawn event with no parent, and must land in the crew
//      store — not under a phantom key in `meshChildren`. A real mesh child
//      must behave exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

import { useCrewStore } from "../state/crew";
// The REAL chat store — meshSlice is a slice of it, so the spawn-routing
// assertions have to run against the real thing. `runNow` reaches it through
// a lazy import (state/chat → meshSlice → state/crew is a cycle), so
// stubbing the two actions it calls is enough to observe the run flow.
import { useChatStore } from "../state/chat";
import { ChatSessionRow } from "../components/chat/ChatSessionRow";
import {
  exportCrewAgents,
  importCrewAgent,
  listCrewRuns,
  runCrewAgent,
  type CrewAgentRun,
} from "../lib/ipc/crew";
import type { SessionSpawnPayload } from "../lib/ipc/sessionMesh";

/** Sparse view of the chat store for the assertions that read its internals. */
function chatState() {
  const s = useChatStore.getState() as unknown as {
    meshChildren: Record<string, { childId: string; title: string; agent: string; model?: string }[]>;
    streaming: Record<string, string>;
    chatStatus: Record<string, { reason: string; message: string }>;
  };
  return s;
}

let prevInternals: unknown;
let loadSessions: ReturnType<typeof vi.fn>;
let selectSession: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeMock.mockReset();
  prevInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  // Fresh stores per test — zustand's create() is a module singleton.
  useCrewStore.setState({
    loaded: false,
    agents: [],
    error: null,
    busy: {},
    runs: {},
    runsLoaded: false,
  });
  useChatStore.setState({ meshChildren: {}, streaming: {}, chatStatus: {}, subagents: {} });
  loadSessions = vi.fn().mockResolvedValue(undefined);
  selectSession = vi.fn().mockResolvedValue(undefined);
  useChatStore.setState({ loadSessions, selectSession });
});

afterEach(() => {
  if (prevInternals === undefined) {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  } else {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = prevInternals;
  }
});

describe("runCrewAgent wrapper (CONTRACT)", () => {
  it("calls run_crew_agent with camelCase args and returns the new session id", async () => {
    invokeMock.mockResolvedValueOnce("sess-42");
    const sessionId = await runCrewAgent("agent-1", "Write the README");
    expect(invokeMock).toHaveBeenCalledWith("run_crew_agent", {
      agentId: "agent-1",
      task: "Write the README",
      projectId: null,
      wait: null,
    });
    expect(sessionId).toBe("sess-42");
  });

  it("carries an explicit project and wait through", async () => {
    invokeMock.mockResolvedValueOnce("sess-7");
    await runCrewAgent("agent-1", "Fix the tests", "proj-9", true);
    expect(invokeMock).toHaveBeenCalledWith("run_crew_agent", {
      agentId: "agent-1",
      task: "Fix the tests",
      projectId: "proj-9",
      wait: true,
    });
  });

  it("resolves null (not a throw) when the runtime returns nothing", async () => {
    invokeMock.mockResolvedValueOnce(null);
    await expect(runCrewAgent("agent-1", "x")).resolves.toBeNull();
  });

  it("rejects with the backend's message (e.g. the concurrency guard)", async () => {
    invokeMock.mockRejectedValueOnce(new Error("agent is at its concurrency limit"));
    await expect(runCrewAgent("agent-1", "x")).rejects.toThrow(
      "agent is at its concurrency limit",
    );
  });
});

describe("export / import / list-runs wrappers (CONTRACT)", () => {
  it("exports the whole registry with a null id list", async () => {
    invokeMock.mockResolvedValueOnce("---\nname: doc-writer\n---\n");
    const md = await exportCrewAgents();
    expect(invokeMock).toHaveBeenCalledWith("export_crew_agents", { agentIds: null });
    expect(md).toContain("name: doc-writer");
  });

  it("exports a selected subset by id", async () => {
    invokeMock.mockResolvedValueOnce("");
    await exportCrewAgents(["a", "b"]);
    expect(invokeMock).toHaveBeenCalledWith("export_crew_agents", { agentIds: ["a", "b"] });
  });

  it("imports one markdown doc and normalizes the created row", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "agent-new",
      name: "reviewer",
      tools: '["read_file"]',
    });
    const agent = await importCrewAgent("---\nname: reviewer\n---\n");
    expect(invokeMock).toHaveBeenCalledWith("import_crew_agent", {
      markdown: "---\nname: reviewer\n---\n",
    });
    expect(agent?.id).toBe("agent-new");
    expect(agent?.tools).toEqual(["read_file"]);
  });

  it("lists runs with explicit nulls and normalizes each row", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        id: "run-1",
        agentId: "agent-1",
        sessionId: "sess-9",
        trigger: "manual",
        task: "Write the README",
        engine: "builtin",
        model: "openai::gpt-5",
        worktree: null,
        startedAt: 1_700_000_000,
        finishedAt: null,
        status: "running",
        summary: null,
      },
    ]);
    const runs = await listCrewRuns();
    expect(invokeMock).toHaveBeenCalledWith("list_crew_runs", { agentId: null, limit: null });
    expect(runs[0]).toEqual<CrewAgentRun>({
      id: "run-1",
      agentId: "agent-1",
      sessionId: "sess-9",
      trigger: "manual",
      task: "Write the README",
      engine: "builtin",
      model: "openai::gpt-5",
      worktree: null,
      startedAt: 1_700_000_000,
      finishedAt: null,
      status: "running",
      summary: null,
    });
  });

  it("fills a sparse run row so a deleted agent/chat still renders", async () => {
    invokeMock.mockResolvedValueOnce([{ id: "run-2" }]);
    const [run] = await listCrewRuns("agent-1", 10);
    expect(invokeMock).toHaveBeenCalledWith("list_crew_runs", { agentId: "agent-1", limit: 10 });
    expect(run).toEqual<CrewAgentRun>({
      id: "run-2",
      agentId: null,
      sessionId: null,
      trigger: "manual",
      task: "",
      engine: "",
      model: "",
      worktree: null,
      startedAt: 0,
      finishedAt: null,
      status: "running",
      summary: null,
    });
  });
});

describe("useCrewStore.runNow", () => {
  it("marks the agent busy, runs it, and selects the new session", async () => {
    // Busy must be observable WHILE the call is in flight.
    let busyDuringCall: unknown;
    invokeMock.mockImplementationOnce(async () => {
      busyDuringCall = useCrewStore.getState().busy["agent-1"];
      return "sess-42";
    });

    const sessionId = await useCrewStore.getState().runNow("agent-1", "Write the README");

    expect(busyDuringCall).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("run_crew_agent", {
      agentId: "agent-1",
      task: "Write the README",
      projectId: null,
      wait: null,
    });
    // The row was created backend-side, so the list is reloaded before the
    // selection — otherwise the user lands on an empty chat.
    expect(loadSessions).toHaveBeenCalled();
    expect(selectSession).toHaveBeenCalledWith("sess-42");
    expect(sessionId).toBe("sess-42");

    const s = useCrewStore.getState();
    expect(s.busy["agent-1"]).toBeUndefined();
    expect(s.error).toBeNull();
  });

  it("passes the project and wait choice through", async () => {
    invokeMock.mockResolvedValueOnce("sess-7");
    await useCrewStore.getState().runNow("agent-1", "Fix the tests", "proj-9", true);
    expect(invokeMock).toHaveBeenCalledWith("run_crew_agent", {
      agentId: "agent-1",
      task: "Fix the tests",
      projectId: "proj-9",
      wait: true,
    });
  });

  it("records the failure reason and clears busy without selecting anything", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no provider key for builtin"));
    const sessionId = await useCrewStore.getState().runNow("agent-1", "Write the README");
    expect(sessionId).toBeNull();
    const s = useCrewStore.getState();
    expect(s.busy["agent-1"]).toBeUndefined();
    expect(s.error).toContain("no provider key for builtin");
    expect(selectSession).not.toHaveBeenCalled();
  });

  it("treats a null session id as a failure, not a silent success", async () => {
    invokeMock.mockResolvedValueOnce(null);
    const sessionId = await useCrewStore.getState().runNow("agent-1", "Write the README");
    expect(sessionId).toBeNull();
    expect(useCrewStore.getState().error).toContain("didn't return a session");
    expect(selectSession).not.toHaveBeenCalled();
  });

  it("keeps the run (and its id) when only the navigation into it fails", async () => {
    invokeMock.mockResolvedValueOnce("sess-42");
    selectSession.mockRejectedValueOnce(new Error("db locked"));
    const sessionId = await useCrewStore.getState().runNow("agent-1", "Write the README");
    // The run DID start — refusing the id would hide a live session.
    expect(sessionId).toBe("sess-42");
    expect(useCrewStore.getState().error).toContain("started, but couldn't open it");
    expect(useCrewStore.getState().busy["agent-1"]).toBeUndefined();
  });

  it("clears a previous error when a new run starts", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    await useCrewStore.getState().runNow("agent-1", "a");
    expect(useCrewStore.getState().error).toContain("boom");
    invokeMock.mockResolvedValueOnce("sess-2");
    await useCrewStore.getState().runNow("agent-1", "b");
    expect(useCrewStore.getState().error).toBeNull();
  });
});

describe("useCrewStore.loadRuns", () => {
  it("merges history into the runs map and flips the loaded flag", async () => {
    invokeMock.mockResolvedValueOnce([
      { id: "run-1", agentId: "agent-1", sessionId: "sess-9", status: "ok", startedAt: 2 },
    ]);
    await useCrewStore.getState().loadRuns("agent-1");
    expect(invokeMock).toHaveBeenCalledWith("list_crew_runs", { agentId: "agent-1", limit: null });
    const s = useCrewStore.getState();
    expect(s.runsLoaded).toBe(true);
    expect(s.runs["run-1"].status).toBe("ok");
  });

  it("keeps a live-ingested run the history page hasn't caught up with", async () => {
    useCrewStore.getState().ingestRun({
      id: "live-1",
      agentId: "agent-1",
      sessionId: "sess-live",
      trigger: "manual",
      task: "just started",
      engine: "builtin",
      model: "openai::gpt-5",
      worktree: null,
      startedAt: Date.now(),
      finishedAt: null,
      status: "running",
      summary: null,
    });
    invokeMock.mockResolvedValueOnce([{ id: "run-1", status: "ok" }]);
    await useCrewStore.getState().loadRuns();
    expect(Object.keys(useCrewStore.getState().runs).sort()).toEqual(["live-1", "run-1"]);
  });

  it("surfaces a failed history load but still marks the list loaded", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no such table"));
    await useCrewStore.getState().loadRuns();
    const s = useCrewStore.getState();
    expect(s.runsLoaded).toBe(true);
    expect(s.error).toContain("no such table");
  });
});

describe("meshSlice.onSessionSpawn routing (F.5)", () => {
  const payload = (over: Partial<SessionSpawnPayload> = {}): SessionSpawnPayload => ({
    childSessionId: "sess-9",
    title: "doc-writer",
    agent: "builtin",
    ...over,
  });

  const spawn = (p: SessionSpawnPayload) => useChatStore.getState().onSessionSpawn(p);

  it("keys meshChildren under the parent for a real mesh child (unchanged)", () => {
    spawn(payload({ parentSessionId: "a", model: "openai::gpt-5" }));
    const s = chatState();
    expect(Object.keys(s.meshChildren)).toEqual(["a"]);
    expect(s.meshChildren["a"][0]).toEqual({
      childId: "sess-9",
      title: "doc-writer",
      agent: "builtin",
      model: "openai::gpt-5",
    });
    // The child's first turn starts right after the event — its streaming
    // entry is pre-created so tokens aren't dropped.
    expect(s.streaming["sess-9"]).toBeDefined();
    expect(s.chatStatus["sess-9"]).toEqual({ reason: "thinking", message: "" });
    // A mesh child is NOT a crew run.
    expect(useCrewStore.getState().runs).toEqual({});
  });

  it("is idempotent for a repeated mesh child", () => {
    spawn(payload({ parentSessionId: "a" }));
    spawn(payload({ parentSessionId: "a" }));
    expect(chatState().meshChildren["a"]).toHaveLength(1);
  });

  it("does not key meshChildren for a parent-less (manual crew) spawn", () => {
    spawn(payload({ agentId: "agent-1" }));
    const s = chatState();
    expect(s.meshChildren).toEqual({});
    expect(Object.values(s.meshChildren).flat()).toHaveLength(0);
  });

  it("records a parent-less spawn into the crew store's runs", () => {
    spawn(payload({ agentId: "agent-1", title: "Write the README", model: "openai::gpt-5" }));
    const runs = useCrewStore.getState().runs;
    // Keyed by session id: one spawn = one run, and a duplicate event
    // overwrites instead of duplicating.
    expect(Object.keys(runs)).toEqual(["sess-9"]);
    expect(runs["sess-9"]).toMatchObject({
      id: "sess-9",
      agentId: "agent-1",
      sessionId: "sess-9",
      trigger: "manual",
      task: "Write the README",
      engine: "builtin",
      model: "openai::gpt-5",
      status: "running",
      finishedAt: null,
    });
  });

  it("requests a chat-session list refresh for a parent-less spawn", () => {
    spawn(payload({ agentId: "agent-1" }));
    expect(loadSessions).toHaveBeenCalled();
  });

  it("does not refresh the session list for a real mesh child", () => {
    spawn(payload({ parentSessionId: "a" }));
    expect(loadSessions).not.toHaveBeenCalled();
  });

  it("tolerates a parent-less spawn with no agentId", () => {
    spawn(payload());
    const runs = useCrewStore.getState().runs;
    expect(runs["sess-9"].agentId).toBeNull();
    expect(useCrewStore.getState().error).toBeNull();
  });

  it("is idempotent for a repeated parent-less spawn", () => {
    spawn(payload({ agentId: "agent-1" }));
    spawn(payload({ agentId: "agent-1", title: "renamed" }));
    const runs = useCrewStore.getState().runs;
    expect(Object.keys(runs)).toEqual(["sess-9"]);
    expect(runs["sess-9"].task).toBe("renamed");
  });
});

describe("meshSlice.onSubagentSpawn agentId (F.5)", () => {
  const base = {
    chatSessionId: "sess-1",
    id: "sub-1",
    role: "doc-writer",
    task: "Write the README",
    prompt: "You are a doc writer.",
  };

  const subagent = () => {
    const s = useChatStore.getState() as unknown as {
      subagents: Record<string, Record<string, { id: string; agentId: string | null }>>;
    };
    return s.subagents["sess-1"]["sub-1"];
  };

  it("preserves the crew agent id when the backend sends one", () => {
    useChatStore.getState().onSubagentSpawn({ ...base, agentId: "agent-1" });
    expect(subagent().agentId).toBe("agent-1");
  });

  it("normalizes an absent agent id to null (builtin roles, CLI-native runs)", () => {
    useChatStore.getState().onSubagentSpawn(base);
    expect(subagent().agentId).toBeNull();
  });

  it("keeps the rest of the record unchanged", () => {
    useChatStore.getState().onSubagentSpawn({ ...base, model: "openai::gpt-5" });
    const s = useChatStore.getState() as unknown as {
      subagents: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(s.subagents["sess-1"]["sub-1"]).toEqual({
      id: "sub-1",
      role: "doc-writer",
      task: "Write the README",
      prompt: "You are a doc writer.",
      output: "",
      status: "running",
      model: "openai::gpt-5",
      agentId: null,
    });
  });
});

describe("ChatSessionRow crew chip", () => {
  const rowProps = {
    active: false,
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onToggleStar: vi.fn(),
    onSetUnread: vi.fn(),
    onExport: vi.fn(),
  };
  const base = {
    id: "sess-9",
    title: "Write the README",
    lastActiveAt: Math.floor(Date.now() / 1000),
  };

  const crewAgent = (over: Record<string, unknown> = {}) => ({
    id: "agent-1",
    name: "doc-writer",
    description: "",
    promptMd: "",
    tools: null,
    engine: "builtin",
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
  });

  afterEach(cleanup);

  it("tags a session with the agent's name from its own agentDefId", () => {
    useCrewStore.setState({ agents: [crewAgent()] as never });
    render(<ChatSessionRow session={{ ...base, agentDefId: "agent-1" }} {...rowProps} />);
    expect(screen.getByLabelText("Crew agent: doc-writer")).toBeTruthy();
  });

  it("falls back to the id when the agent was deleted", () => {
    useCrewStore.setState({ agents: [] });
    render(<ChatSessionRow session={{ ...base, agentDefId: "agent-gone" }} {...rowProps} />);
    expect(screen.getByLabelText("Crew agent: agent-gone")).toBeTruthy();
  });

  it("tags a session from a live run even before the row is re-read", () => {
    useCrewStore.setState({
      agents: [crewAgent()] as never,
      runs: {
        "run-1": {
          id: "run-1",
          agentId: "agent-1",
          sessionId: "sess-9",
          trigger: "manual",
          task: "Write the README",
          engine: "builtin",
          model: "openai::gpt-5",
          worktree: null,
          startedAt: Date.now(),
          finishedAt: null,
          status: "running",
          summary: null,
        },
      },
    });
    render(<ChatSessionRow session={base} {...rowProps} />);
    expect(screen.getByLabelText("Crew agent: doc-writer")).toBeTruthy();
  });

  it("leaves an ordinary chat untagged", () => {
    useCrewStore.setState({ agents: [crewAgent()] as never, runs: {} });
    render(<ChatSessionRow session={base} {...rowProps} />);
    expect(screen.queryByLabelText(/^Crew agent:/)).toBeNull();
  });
});
