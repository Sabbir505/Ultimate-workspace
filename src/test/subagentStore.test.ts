// Subagent store + ipc-wrapper normalization (Phase 1 registry).
//
// Only the transport is mocked (@tauri-apps/api/core's invoke), so these
// assertions run the real wrapper → store path: the `tools` JSON column is
// parsed by `listSubagents` exactly as it is in the app, and the store's
// load/create/update/remove actions are exercised against it.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

import { useSubagentStore, SUBAGENT_NEW_KEY } from "../state/subagents";
import {
  createSubagent,
  listSubagents,
  parseSubagentTools,
  updateSubagent,
  type Subagent,
  type SubagentRun,
} from "../lib/ipc/subagents";

/** A wire row as the backend sends it: `tools` is still the raw JSON column. */
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "agent-1",
    name: "doc-writer",
    description: "Writes docs",
    promptMd: "You are a doc writer.",
    tools: JSON.stringify(["read_file", "list_directory"]),
    engine: "builtin",
    model: null,
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

let prevInternals: unknown;

beforeEach(() => {
  invokeMock.mockReset();
  prevInternals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  // Fresh store per test — zustand's create() is a module singleton.
  useSubagentStore.setState({ loaded: false, agents: [], error: null, busy: {}, runs: {} });
});

afterEach(() => {
  if (prevInternals === undefined) {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  } else {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = prevInternals;
  }
});

describe("subagent tools parsing", () => {
  it("parses a JSON array column", () => {
    expect(parseSubagentTools('["read_file","write_file"]')).toEqual(["read_file", "write_file"]);
  });

  it("treats an empty allowlist as an explicit empty set", () => {
    expect(parseSubagentTools("[]")).toEqual([]);
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(parseSubagentTools("{not json")).toBeNull();
    expect(parseSubagentTools('"read_file"')).toBeNull();
    expect(parseSubagentTools("42")).toBeNull();
  });

  it("returns null for an absent/empty column", () => {
    expect(parseSubagentTools(null)).toBeNull();
    expect(parseSubagentTools(undefined)).toBeNull();
    expect(parseSubagentTools("")).toBeNull();
  });

  it("drops non-string entries and duplicates rather than widening the set", () => {
    expect(parseSubagentTools('["read_file", 7, null, "read_file", " write_file "]')).toEqual([
      "read_file",
      "write_file",
    ]);
  });
});

describe("useSubagentStore", () => {
  it("loads agents and marks the slice loaded", async () => {
    invokeMock.mockResolvedValue([row()]);
    await useSubagentStore.getState().load();
    const s = useSubagentStore.getState();
    expect(invokeMock).toHaveBeenCalledWith("list_subagents", undefined);
    expect(s.loaded).toBe(true);
    expect(s.agents).toHaveLength(1);
    // The column arrives as a string; the store only ever sees the array.
    expect(s.agents[0].tools).toEqual(["read_file", "list_directory"]);
  });

  it("surfaces a malformed tools column as null without throwing", async () => {
    invokeMock.mockResolvedValue([row({ tools: "[[[" })]);
    await expect(useSubagentStore.getState().load()).resolves.toBeUndefined();
    expect(useSubagentStore.getState().agents[0].tools).toBeNull();
  });

  it("surfaces a failed load as an error string", async () => {
    invokeMock.mockRejectedValue(new Error("db locked"));
    await useSubagentStore.getState().load();
    const s = useSubagentStore.getState();
    expect(s.error).toContain("db locked");
    expect(s.loaded).toBe(true);
  });

  it("create calls create_subagent and appends the saved row", async () => {
    invokeMock.mockResolvedValueOnce(row({ id: "agent-2", name: "reviewer" }));
    const input = {
      name: "reviewer",
      description: "Reviews diffs",
      promptMd: "You review code.",
      tools: ["read_file"],
      engine: null,
      model: "openrouter::x-ai/grok-4",
      sandboxPolicy: "read_only",
      approvalPolicy: "on_request",
      worktreePolicy: "inherit",
      maxRounds: 25,
      maxConcurrent: 2,
    };
    const created = await useSubagentStore.getState().create(input);
    // The store hands the ipc wrapper an array; the wrapper owns the JSON.
    expect(invokeMock).toHaveBeenCalledWith("create_subagent", {
      input: { ...input, tools: '["read_file"]' },
    });
    expect(created?.id).toBe("agent-2");
    expect(useSubagentStore.getState().agents.map((a) => a.id)).toEqual(["agent-2"]);
  });

  it("create clears the busy flag and keeps the editor usable on failure", async () => {
    invokeMock.mockRejectedValueOnce(new Error("name is reserved"));
    const created = await useSubagentStore.getState().create({ name: "explore" });
    expect(created).toBeNull();
    const s = useSubagentStore.getState();
    expect(s.busy[SUBAGENT_NEW_KEY]).toBeUndefined();
    expect(s.error).toContain("name is reserved");
    expect(s.agents).toEqual([]);
  });

  it("update calls update_subagent with the id, then refetches", async () => {
    invokeMock.mockResolvedValueOnce([row()]);
    await useSubagentStore.getState().load();
    const input = { name: "doc-writer", promptMd: "New body." };
    invokeMock.mockResolvedValueOnce(row({ promptMd: "New body.", updatedAt: 3000 }));
    invokeMock.mockResolvedValueOnce([row({ promptMd: "New body.", updatedAt: 3000 })]);
    const saved = await useSubagentStore.getState().update("agent-1", input);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "update_subagent", {
      agentId: "agent-1",
      input,
    });
    expect(saved?.promptMd).toBe("New body.");
    // The refetch is what lands in state (the backend normalizes name/rounds).
    expect(invokeMock).toHaveBeenNthCalledWith(3, "list_subagents", undefined);
    expect(useSubagentStore.getState().agents[0].promptMd).toBe("New body.");
    expect(useSubagentStore.getState().busy["agent-1"]).toBeUndefined();
  });

  it("update reports the failure and leaves the previous row in place", async () => {
    invokeMock.mockResolvedValueOnce([row()]);
    await useSubagentStore.getState().load();
    invokeMock.mockRejectedValueOnce(new Error("agent has live runs"));
    const saved = await useSubagentStore.getState().update("agent-1", { name: "doc-writer" });
    expect(saved).toBeNull();
    const s = useSubagentStore.getState();
    expect(s.error).toContain("agent has live runs");
    expect(s.agents).toHaveLength(1);
  });

  it("remove drops the row optimistically and calls delete_subagent", async () => {
    invokeMock.mockResolvedValueOnce([row()]);
    await useSubagentStore.getState().load();
    invokeMock.mockResolvedValueOnce(undefined);
    await useSubagentStore.getState().remove("agent-1");
    expect(invokeMock).toHaveBeenLastCalledWith("delete_subagent", { agentId: "agent-1" });
    expect(useSubagentStore.getState().agents).toEqual([]);
  });

  it("remove restores the row when the backend refuses the delete", async () => {
    invokeMock.mockResolvedValueOnce([row({ builtin: true })]);
    await useSubagentStore.getState().load();
    invokeMock.mockRejectedValueOnce(new Error("built-in agents cannot be deleted"));
    await useSubagentStore.getState().remove("agent-1");
    const s = useSubagentStore.getState();
    expect(s.agents.map((a) => a.id)).toEqual(["agent-1"]);
    expect(s.error).toContain("built-in agents cannot be deleted");
  });

  it("ingestRun records a run by id and is idempotent", () => {
    const run: SubagentRun = {
      id: "run-1",
      agentId: "agent-1",
      sessionId: "sess-9",
      trigger: "manual",
      task: "Write the README",
      engine: "builtin",
      model: "openai::gpt-5",
      worktree: null,
      startedAt: 1,
      finishedAt: null,
      status: "running",
      summary: null,
    };
    useSubagentStore.getState().ingestRun(run);
    useSubagentStore.getState().ingestRun({ ...run, status: "ok", finishedAt: 9 });
    const runs = useSubagentStore.getState().runs;
    expect(Object.keys(runs)).toEqual(["run-1"]);
    expect(runs["run-1"].status).toBe("ok");
  });
});

describe("create/update payload shape", () => {
  it("serializes the allowlist array into the JSON column", async () => {
    invokeMock.mockResolvedValueOnce(row());
    await createSubagent({ name: "doc-writer", tools: ["read_file", "list_directory"] });
    expect(invokeMock).toHaveBeenCalledWith("create_subagent", {
      input: { name: "doc-writer", tools: '["read_file","list_directory"]' },
    });
  });

  it("sends JSON null for an explicit \"inherit the engine default\" allowlist", async () => {
    invokeMock.mockResolvedValueOnce(row());
    await createSubagent({ name: "doc-writer", tools: null });
    expect(invokeMock.mock.calls[0][1].input.tools).toBeNull();
  });

  it("omits tools entirely when the caller leaves it unset", async () => {
    invokeMock.mockResolvedValueOnce(row());
    await createSubagent({ name: "doc-writer" });
    expect("tools" in invokeMock.mock.calls[0][1].input).toBe(false);
  });

  it("carries the agent id alongside the serialized input on update", async () => {
    invokeMock.mockResolvedValueOnce(row());
    await updateSubagent("agent-1", { name: "doc-writer", tools: [] });
    expect(invokeMock).toHaveBeenCalledWith("update_subagent", {
      agentId: "agent-1",
      input: { name: "doc-writer", tools: "[]" },
    });
  });
});

describe("listSubagents wrapper", () => {
  it("normalizes a row and fills defaulted columns defensively", async () => {
    invokeMock.mockResolvedValue([
      { id: "a", name: "n", tools: null, sandboxPolicy: null, maxRounds: "40" },
    ]);
    const [agent] = await listSubagents();
    expect(agent).toEqual<Subagent>({
      id: "a",
      name: "n",
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
    });
  });

  it("returns an empty list when the runtime returns nothing", async () => {
    invokeMock.mockResolvedValue(null);
    expect(await listSubagents()).toEqual([]);
  });
});
