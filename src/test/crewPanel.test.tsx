// Settings → Agents → Crew panel (Phase 1 registry surface).
// The store is mocked as a selector-callable over a mutable fixture (the
// PullsPanel style) so this covers the user-facing surface only: row rendering,
// the enforcement-tier badges, the builtin delete guard, and what the editor
// sends to create/update. Store behavior + the ipc column parsing live in
// crewStore.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const load = vi.fn().mockResolvedValue(undefined);
const create = vi.fn().mockResolvedValue(null);
const update = vi.fn().mockResolvedValue(null);
const remove = vi.fn().mockResolvedValue(undefined);

const crewState = {
  loaded: true,
  agents: [] as unknown[],
  error: null as string | null,
  busy: {} as Record<string, boolean>,
  load: (...a: unknown[]) => load(...a),
  create: (...a: unknown[]) => create(...a),
  update: (...a: unknown[]) => update(...a),
  remove: (...a: unknown[]) => remove(...a),
};
vi.mock("../state/crew", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/crew")>();
  return {
    ...actual,
    useCrewStore: (sel: (s: typeof crewState) => unknown) => sel(crewState),
  };
});

import { CrewPanel } from "../components/crew/CrewPanel";
import { crewEngineTier, type CrewAgent } from "../lib/ipc/crew";

function agent(over: Partial<CrewAgent> = {}): CrewAgent {
  return {
    id: "agent-1",
    name: "doc-writer",
    description: "Writes and polishes user documentation",
    promptMd: "You are a doc writer.",
    tools: ["read_file", "list_directory"],
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

beforeEach(() => {
  vi.clearAllMocks();
  crewState.agents = [];
  crewState.error = null;
  crewState.busy = {};
  crewState.loaded = true;
  create.mockResolvedValue(agent({ id: "agent-new", name: "reviewer" }));
  update.mockResolvedValue(agent());
  remove.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("CrewPanel", () => {
  it("loads the registry on mount and shows the empty state", async () => {
    render(<CrewPanel />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/No crew agents yet/)).toBeTruthy();
  });

  it("renders a seeded agent with its description, tool count and scope", async () => {
    crewState.agents = [agent()];
    render(<CrewPanel />);
    expect(await screen.findByText("doc-writer")).toBeTruthy();
    expect(screen.getByText(/Writes and polishes user documentation/)).toBeTruthy();
    expect(screen.getByText(/2 tools/)).toBeTruthy();
    // Sandbox and approval are separate pills now, not one dot-joined string.
    expect(screen.getByText("read_only")).toBeTruthy();
    expect(screen.getByText("on_request")).toBeTruthy();
    expect(screen.getByText(/40 rounds/)).toBeTruthy();
  });

  it("says \"engine default tools\" when the row has no explicit allowlist", async () => {
    crewState.agents = [agent({ tools: null })];
    render(<CrewPanel />);
    expect(await screen.findByText(/engine default tools/)).toBeTruthy();
  });

  it("surfaces the store's error inline", async () => {
    crewState.error = "Couldn't delete the agent: built-in agents cannot be deleted";
    render(<CrewPanel />);
    expect(await screen.findByText(/built-in agents cannot be deleted/)).toBeTruthy();
  });

  it("disables Delete on a builtin row with an explanatory tooltip", async () => {
    crewState.agents = [agent({ builtin: true }), agent({ id: "agent-2", name: "reviewer" })];
    render(<CrewPanel />);
    const builtinDelete = await screen.findByLabelText("Delete doc-writer");
    const ownDelete = screen.getByLabelText("Delete reviewer");
    expect((builtinDelete as HTMLButtonElement).disabled).toBe(true);
    expect(builtinDelete.getAttribute("title")).toMatch(/can't be deleted/);
    expect((ownDelete as HTMLButtonElement).disabled).toBe(false);
  });

  it("deletes a user agent through the store's remove", async () => {
    crewState.agents = [agent()];
    render(<CrewPanel />);
    fireEvent.click(await screen.findByLabelText("Delete doc-writer"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("agent-1"));
  });

  it("badges a builtin engine as enforced and a harness engine as advisory", async () => {
    crewState.agents = [
      agent(),
      agent({ id: "agent-2", name: "claude-runner", engine: "harness:claude_code" }),
      agent({ id: "agent-3", name: "local-runner", engine: "local" }),
    ];
    render(<CrewPanel />);
    const builtinRow = (await screen.findByText("doc-writer")).closest(".crew-agent-row")!;
    const harnessRow = (await screen.findByText("claude-runner")).closest(".crew-agent-row")!;
    const localRow = (await screen.findByText("local-runner")).closest(".crew-agent-row")!;
    expect(builtinRow.textContent).toContain("enforced");
    expect(harnessRow.textContent).toContain("advisory");
    expect(harnessRow.textContent).toContain("CLI tools not restrictible");
    expect(localRow.textContent).toContain("enforced");
  });

  it("tiers engine strings the way the badge vocabulary defines them", () => {
    expect(crewEngineTier("builtin")).toBe("enforced");
    expect(crewEngineTier("local")).toBe("enforced");
    expect(crewEngineTier(null)).toBe("enforced");
    expect(crewEngineTier("harness:claude_code")).toBe("advisory");
    expect(crewEngineTier("acp:zed")).toBe("advisory");
  });

  it("saves a new agent with the typed fields", async () => {
    render(<CrewPanel />);
    fireEvent.click(await screen.findByText("New agent"));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "reviewer" } });
    fireEvent.change(screen.getByLabelText("Agent description"), {
      target: { value: "Reviews diffs" },
    });
    fireEvent.change(screen.getByLabelText("Agent prompt"), {
      target: { value: "You review code." },
    });
    fireEvent.click(screen.getByRole("button", { name: "read_file" }));
    // The Engine picker is the custom CrewSelect: open the menu, click the
    // option (a change event can't drive a button).
    fireEvent.click(screen.getByLabelText("Engine"));
    fireEvent.click(await screen.findByRole("option", { name: "Claude Code (harness)" }));
    // The harness model probe finds nothing under jsdom (no Tauri runtime), so
    // the model control falls back to the free-text input once loading settles.
    const modelField = await screen.findByLabelText("Model");
    await waitFor(() => expect((modelField as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(modelField, {
      target: { value: "openrouter::x-ai/grok-4" },
    });
    // Scope & budget are CrewSelects too: open the menu, click the option.
    fireEvent.click(screen.getByLabelText("Approval policy"));
    fireEvent.click(await screen.findByRole("option", { name: "Auto-approve edits" }));
    fireEvent.click(screen.getByLabelText("Worktree policy"));
    fireEvent.click(await screen.findByRole("option", { name: "Always provision a worktree" }));
    fireEvent.change(screen.getByLabelText("Max rounds"), { target: { value: "12" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({
      name: "reviewer",
      description: "Reviews diffs",
      promptMd: "You review code.",
      tools: ["read_file"],
      engine: "harness:claude_code",
      model: "openrouter::x-ai/grok-4",
      effort: null,
      sandboxPolicy: "read_only",
      approvalPolicy: "auto_edit",
      worktreePolicy: "always",
      maxRounds: 12,
      maxConcurrent: 2,
    });
  });

  it("sends null for the fields left on inherit", async () => {
    render(<CrewPanel />);
    fireEvent.click(await screen.findByText("New agent"));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "reviewer" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const input = create.mock.calls[0][0];
    expect(input.tools).toBeNull();
    expect(input.engine).toBeNull();
    expect(input.model).toBeNull();
  });

  it("clamps rounds into 1–100 and concurrent runs to at least 1", async () => {
    render(<CrewPanel />);
    fireEvent.click(await screen.findByText("New agent"));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "reviewer" } });
    fireEvent.change(screen.getByLabelText("Max rounds"), { target: { value: "9000" } });
    fireEvent.change(screen.getByLabelText("Max concurrent"), { target: { value: "0" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0].maxRounds).toBe(100);
    expect(create.mock.calls[0][0].maxConcurrent).toBe(1);
  });

  it("refuses to save an unnamed agent and keeps the editor open", async () => {
    render(<CrewPanel />);
    fireEvent.click(await screen.findByText("New agent"));
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText(/Give the agent a name/)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("edits a builtin agent with its name locked", async () => {
    crewState.agents = [agent({ builtin: true })];
    render(<CrewPanel />);
    fireEvent.click(await screen.findByLabelText("Edit doc-writer"));
    expect((await screen.findByLabelText("Agent name")).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Agent prompt"), { target: { value: "Rewritten." } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toBe("agent-1");
    expect(update.mock.calls[0][1].promptMd).toBe("Rewritten.");
  });

  it("keeps the editor open and shows the store's error when a save fails", async () => {
    update.mockResolvedValue(null);
    crewState.agents = [agent()];
    render(<CrewPanel />);
    fireEvent.click(await screen.findByLabelText("Edit doc-writer"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Agent name")).toBeTruthy();
  });

  it("cancels back to the list without saving", async () => {
    render(<CrewPanel />);
    fireEvent.click(await screen.findByText("New agent"));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "reviewer" } });
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByText("New agent")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("renders no Run button until a caller passes onRun (Phase 2.5 extension point)", async () => {
    crewState.agents = [agent()];
    render(<CrewPanel />);
    await screen.findByText("doc-writer");
    expect(screen.queryByLabelText("Run doc-writer")).toBeNull();
  });

  it("hands the agent to onRun when the caller supplies it", async () => {
    const onRun = vi.fn();
    crewState.agents = [agent()];
    render(<CrewPanel onRun={onRun} />);
    fireEvent.click(await screen.findByLabelText("Run doc-writer"));
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-1" }));
  });
});
