// ACP client support (roadmap #20): the user-defined agent editor
// (AcpAgentsPanel), the composer's combined agent/model picker ACP section
// (AgentModelPicker), and store routing — acp:<id> sessions must flow through
// sendAgentChatMessage / cancelAgentChatMessage exactly like harness:<id>
// ones (agent_sessions.rs owns both). One static ipc mock covers all three
// surfaces.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentModelPicker } from "../components/chat/AgentModelPicker";
import { AcpAgentsPanel } from "../components/settings/AcpAgentsPanel";
import { useChatStore } from "../state/chat";

const listAcpAgentDefsMock = vi.fn();
const saveAcpAgentDefsMock = vi.fn();
const listHarnessesMock = vi.fn();
const listAcpAgentsMock = vi.fn();
const sendAgentChatMessageMock = vi.fn().mockResolvedValue(undefined);
const cancelAgentChatMessageMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/ipc", () => ({
  // Self-improving artifacts telemetry (P0) — loop persistence + turn runs.
  loopSessionStart: vi.fn().mockResolvedValue(null),
  loopSessionAdvance: vi.fn().mockResolvedValue(undefined),
  loopSessionFinish: vi.fn().mockResolvedValue(undefined),
  finishArtifactRuns: vi.fn().mockResolvedValue(0),
  listAcpAgentDefs: (...a: unknown[]) => listAcpAgentDefsMock(...a),
  saveAcpAgentDefs: (...a: unknown[]) => saveAcpAgentDefsMock(...a),
  listHarnesses: (...a: unknown[]) => listHarnessesMock(...a),
  listAcpAgents: (...a: unknown[]) => listAcpAgentsMock(...a),
  listHarnessModels: vi.fn().mockResolvedValue(null),
  listChatModels: vi.fn().mockResolvedValue([]),
  scanLocalModels: vi.fn().mockResolvedValue([]),
  sendAgentChatMessage: (...a: unknown[]) => sendAgentChatMessageMock(...a),
  cancelAgentChatMessage: (...a: unknown[]) => cancelAgentChatMessageMock(...a),
  sendChatMessage: vi.fn(),
  cancelChatMessage: vi.fn().mockResolvedValue(undefined),
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatSessions: vi.fn().mockResolvedValue([]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn(),
  generateChatTitle: vi.fn().mockResolvedValue(null),
  getChatConfig: vi.fn(),
  getChatSessionMetrics: vi.fn().mockResolvedValue(null),
  setChatSessionUnread: vi.fn().mockResolvedValue(undefined),
  setChatSessionStarred: vi.fn(),
  setChatSessionProject: vi.fn(),
  updateChatSessionTitle: vi.fn(),
  updateChatSessionModel: vi.fn(),
  updateChatSessionProvider: vi.fn(),
  updateChatSessionAgent: vi.fn(),
  updateChatSessionWatchMode: vi.fn(),
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  deleteAllChatSessions: vi.fn().mockResolvedValue(2),
  deleteChatMessage: vi.fn(),
  persistPartialChatMessage: vi.fn().mockResolvedValue(undefined),
  setChatApiKey: vi.fn(),
  deleteChatApiKey: vi.fn(),
  readArtifactPreview: vi.fn(),
}));

describe("AcpAgentsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAcpAgentDefsMock.mockResolvedValue([]);
    saveAcpAgentDefsMock.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("lists persisted user agents with command/args", async () => {
    listAcpAgentDefsMock.mockResolvedValue([
      { id: "my-agent", displayName: "My Agent", command: "mycli", args: ["--stdio"], env: {} },
    ]);
    render(<AcpAgentsPanel />);
    expect(await screen.findByText(/My Agent/)).toBeTruthy();
    expect(screen.getByText(/mycli --stdio/)).toBeTruthy();
  });

  it("adds an agent, parsing args and env", async () => {
    listAcpAgentDefsMock.mockResolvedValue([]);
    render(<AcpAgentsPanel />);
    fireEvent.change(screen.getByPlaceholderText("my-agent"), { target: { value: "mycool-agent" } });
    fireEvent.change(screen.getByPlaceholderText("My Agent"), { target: { value: "My Cool Agent" } });
    fireEvent.change(screen.getByPlaceholderText(/On PATH or absolute/), { target: { value: "mycli" } });
    fireEvent.change(screen.getByPlaceholderText(/Space\/comma separated/), { target: { value: "--stdio --verbose" } });
    fireEvent.change(screen.getByPlaceholderText(/KEY=VALUE/), { target: { value: "TOKEN=abc\nREGION=us" } });
    fireEvent.click(screen.getByText("Add agent"));
    await waitFor(() => expect(saveAcpAgentDefsMock).toHaveBeenCalled());
    const saved = saveAcpAgentDefsMock.mock.calls[0][0];
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("mycool-agent");
    expect(saved[0].displayName).toBe("My Cool Agent");
    expect(saved[0].command).toBe("mycli");
    expect(saved[0].args).toEqual(["--stdio", "--verbose"]);
    expect(saved[0].env).toEqual({ TOKEN: "abc", REGION: "us" });
  });

  it("rejects an invalid id and required-field gaps", async () => {
    listAcpAgentDefsMock.mockResolvedValue([]);
    render(<AcpAgentsPanel />);
    // Bad id (uppercase/spaces) → error, nothing persisted.
    fireEvent.change(screen.getByPlaceholderText("my-agent"), { target: { value: "My Agent" } });
    fireEvent.change(screen.getByPlaceholderText("My Agent"), { target: { value: "X" } });
    fireEvent.change(screen.getByPlaceholderText(/On PATH or absolute/), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Add agent"));
    await waitFor(() => expect(screen.getByText(/may only contain lowercase/)).toBeTruthy());
    expect(saveAcpAgentDefsMock).not.toHaveBeenCalled();
    // Missing command → error.
    fireEvent.change(screen.getByPlaceholderText("my-agent"), { target: { value: "ok-agent" } });
    fireEvent.change(screen.getByPlaceholderText(/On PATH or absolute/), { target: { value: "" } });
    fireEvent.click(screen.getByText("Add agent"));
    await waitFor(() => expect(screen.getByText(/Display name and command are required/)).toBeTruthy());
    expect(saveAcpAgentDefsMock).not.toHaveBeenCalled();
  });

  it("removes an agent", async () => {
    listAcpAgentDefsMock.mockResolvedValue([
      { id: "zed2", displayName: "Zed", command: "zed", args: [], env: {} },
    ]);
    render(<AcpAgentsPanel />);
    fireEvent.click(await screen.findByText("Remove"));
    await waitFor(() => expect(saveAcpAgentDefsMock).toHaveBeenCalled());
    expect(saveAcpAgentDefsMock.mock.calls[0][0]).toHaveLength(0);
  });
});

describe("AgentModelPicker ACP section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listHarnessesMock.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it("lists installed ACP agents and commits one as acp:<id>", async () => {
    listAcpAgentsMock.mockResolvedValue([
      { id: "zed", displayName: "Zed", installed: true },
      { id: "devin", displayName: "Devin", installed: false },
    ]);
    const onPick = vi.fn();
    render(<AgentModelPicker agent={null} model="" onPick={onPick} />);
    fireEvent.click(screen.getByText(/Select agent/));
    // The rail is icon-only — entries are found by their accessible names
    // (the tooltip text). Only INSTALLED agents render: uninstalled ones
    // (Devin) are hidden entirely instead of ghosting as disabled tabs.
    const zed = await screen.findByRole("tab", { name: "Zed" });
    expect(zed).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Devin" })).toBeNull();
    // Rail click drives the right pane; the Default row commits the pick.
    fireEvent.click(zed);
    fireEvent.click(await screen.findByText(/the agent picks its own model/i));
    expect(onPick).toHaveBeenCalledWith({ agent: "acp:zed", provider: null, model: "" });
  });

  it("hides the ACP section when no agents are registered", async () => {
    listAcpAgentsMock.mockResolvedValue([]);
    render(<AgentModelPicker agent={null} model="" onPick={() => {}} />);
    fireEvent.click(screen.getByText(/Select agent/));
    await waitFor(() => expect(listAcpAgentsMock).toHaveBeenCalled());
    expect(screen.queryByRole("tab", { name: "Zed" })).toBeNull();
  });
});

describe("store routing for acp: sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      sessions: [],
      activeChatSessionId: null,
      messages: [],
      streaming: {},
      chatStatus: {},
      streamingChatSessionId: null,
      messageQueue: {},
      pendingArtifacts: {},
    });
  });

  function seedAgent(agent: string) {
    useChatStore.setState({
      sessions: [{
        id: "s1",
        title: "s1",
        provider: "openai",
        model: "",
        createdAt: 0,
        lastActiveAt: 0,
        agent,
      }] as never,
      activeChatSessionId: "s1",
      streaming: {},
      chatStatus: {},
      streamingChatSessionId: null,
      messages: [],
      messageQueue: {},
      pendingArtifacts: {},
    });
  }

  it("sendMessage routes acp: sessions to sendAgentChatMessage with the bare id", async () => {
    seedAgent("acp:zed");
    await useChatStore.getState().sendMessage("hello agent");
    await waitFor(() => expect(sendAgentChatMessageMock).toHaveBeenCalled());
    const args = sendAgentChatMessageMock.mock.calls[0];
    expect(args[0]).toBe("s1");
    expect(args[1]).toBe("hello agent");
    expect(args[2]).toBe("zed"); // cliAgentId strips the acp: prefix
  });

  it("cancelStream routes acp: sessions to cancelAgentChatMessage", async () => {
    seedAgent("acp:zed");
    useChatStore.setState({ streaming: { s1: "partial" }, streamingChatSessionId: "s1" });
    await useChatStore.getState().cancelStream();
    expect(cancelAgentChatMessageMock).toHaveBeenCalledWith("s1");
  });

  it("deleteChat mid-turn cancels the ACP process like a harness", async () => {
    seedAgent("acp:devin");
    useChatStore.setState({ streaming: { s1: "mid-turn" }, streamingChatSessionId: "s1" });
    await useChatStore.getState().deleteChat("s1");
    expect(cancelAgentChatMessageMock).toHaveBeenCalledWith("s1");
  });
});
