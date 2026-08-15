// Store-level tests for the permission-mode selector + per-action approval flow.
//
// Verifies the behavioral acceptance criteria that live in the frontend:
//  - Switching INTO full_auto opens a one-time confirmation modal (does NOT
//    apply the mode on first request); subsequent switches within the same
//    runtime session don't re-prompt.
//  - Switching to read_only / auto_edit / manual applies immediately.
//  - A pending approval card is surfaced via onApprovalRequest and dismissed
//    via onApprovalResolved / resolveApproval.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the IPC layer so the store never touches the Tauri bridge. The mock
// factory must cover every ipc symbol state/chat.ts imports.
vi.mock("../lib/ipc", () => ({
  cancelAgentChatMessage: vi.fn().mockResolvedValue(undefined),
  cancelChatMessage: vi.fn().mockResolvedValue(undefined),
  persistPartialChatMessage: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn(),
  setChatSessionProject: vi.fn().mockResolvedValue(undefined),
  deleteChatApiKey: vi.fn().mockResolvedValue(undefined),
  deleteAllChatSessions: vi.fn().mockResolvedValue(0),
  deleteChatMessage: vi.fn().mockResolvedValue(undefined),
  deleteChatSession: vi.fn().mockResolvedValue(undefined),
  generateChatTitle: vi.fn(),
  getChatConfig: vi.fn(),
  getChatMessages: vi.fn().mockResolvedValue([]),
  getChatSessionMetrics: vi.fn(),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  listChatCheckpoints: vi.fn().mockResolvedValue([]),
  listChatSessions: vi.fn().mockResolvedValue([]),
  readArtifactPreview: vi.fn(),
  sendAgentChatMessage: vi.fn().mockResolvedValue(undefined),
  sendChatMessage: vi.fn().mockResolvedValue(undefined),
  setChatApiKey: vi.fn().mockResolvedValue(undefined),
  setChatSessionStarred: vi.fn().mockResolvedValue(undefined),
  setChatSessionUnread: vi.fn().mockResolvedValue(undefined),
  toastError: vi.fn(),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  updateChatSessionAgent: vi.fn().mockResolvedValue(undefined),
  updateChatSessionModel: vi.fn().mockResolvedValue(undefined),
  updateChatSessionProvider: vi.fn().mockResolvedValue(undefined),
  updateChatSessionTitle: vi.fn().mockResolvedValue(undefined),
  updateChatSessionPermissionMode: vi.fn().mockResolvedValue(undefined),
  updateChatSessionWatchMode: vi.fn().mockResolvedValue(undefined),
  resolveToolAction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/sessionLauncher", () => ({
  openArtifactInBrowserPane: vi.fn(),
}));
vi.mock("./artifacts", () => ({
  useArtifactsStore: { getState: () => ({}) },
}));
vi.mock("./projects", () => ({
  useProjectsStore: {
    getState: () => ({ sessions: [], projects: [], refreshSessions: vi.fn() }),
  },
}));
vi.mock("./ui", () => ({
  useUiStore: {
    getState: () => ({ pushToast: vi.fn() }),
    subscribe: vi.fn(),
    setState: vi.fn(),
  },
}));

const { updateChatSessionPermissionMode, resolveToolAction } = await import("../lib/ipc");
const updateModeMock = vi.mocked(updateChatSessionPermissionMode);
const resolveMock = vi.mocked(resolveToolAction);

import { useChatStore } from "../state/chat";

const SID = "sess-1";

// Use a fresh session id per test that involves full_auto confirmation, so the
// module-scoped `fullAutoConfirmed` set (private, not resettable across tests)
// can't leak state between them and make test order matter.
function seedSession(mode = "manual", id = SID) {
  useChatStore.setState({
    sessions: [
      {
        id,
        title: "t",
        provider: "openai",
        model: "gpt-4o",
        createdAt: 0,
        lastActiveAt: 0,
        starred: false,
        unread: false,
        permissionMode: mode,
      } as never,
    ],
    activeChatSessionId: id,
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    sessions: [],
    activeChatSessionId: null,
    pendingApprovals: {},
    fullAutoConfirmingFor: null,
    streaming: {},
    streamingChatSessionId: null,
  });
});

describe("permission-mode selector (full_auto confirmation)", () => {
  it("opens the confirmation modal instead of applying full_auto on first switch", async () => {
    seedSession("manual");
    const applied = await useChatStore.getState().setSessionPermissionMode(SID, "full_auto");
    expect(applied).toBe(false);
    expect(useChatStore.getState().fullAutoConfirmingFor).toBe(SID);
    expect(updateModeMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().sessions.find((s) => s.id === SID)?.permissionMode,
    ).toBe("manual");
  });

  it("applies full_auto after confirming, and does not re-prompt on a later switch", async () => {
    const id = seedSession("manual", "sess-confirm");
    await useChatStore.getState().setSessionPermissionMode(id, "full_auto");
    expect(useChatStore.getState().fullAutoConfirmingFor).toBe(id);
    await useChatStore.getState().confirmFullAuto(id);
    expect(updateModeMock).toHaveBeenCalledWith(id, "full_auto");
    expect(useChatStore.getState().fullAutoConfirmingFor).toBeNull();
    expect(
      useChatStore.getState().sessions.find((s) => s.id === id)?.permissionMode,
    ).toBe("full_auto");

    // Switch away then back to full_auto — already confirmed this session, so
    // no re-prompt: applied immediately.
    vi.clearAllMocks();
    const applied2 = await useChatStore.getState().setSessionPermissionMode(id, "manual");
    expect(applied2).toBe(true);
    const applied3 = await useChatStore.getState().setSessionPermissionMode(id, "full_auto");
    expect(applied3).toBe(true);
    expect(updateModeMock).toHaveBeenCalledWith(id, "manual");
    expect(updateModeMock).toHaveBeenCalledWith(id, "full_auto");
  });

  it("applies read_only / auto_edit immediately without a modal", async () => {
    seedSession("manual");
    const a1 = await useChatStore.getState().setSessionPermissionMode(SID, "read_only");
    const a2 = await useChatStore.getState().setSessionPermissionMode(SID, "auto_edit");
    expect(a1).toBe(true);
    expect(a2).toBe(true);
    expect(useChatStore.getState().fullAutoConfirmingFor).toBeNull();
    expect(updateModeMock).toHaveBeenCalledWith(SID, "read_only");
    expect(updateModeMock).toHaveBeenCalledWith(SID, "auto_edit");
  });

  it("cancelFullAutoConfirm leaves the mode unchanged", async () => {
    seedSession("manual");
    await useChatStore.getState().setSessionPermissionMode(SID, "full_auto");
    useChatStore.getState().cancelFullAutoConfirm();
    expect(useChatStore.getState().fullAutoConfirmingFor).toBeNull();
    expect(updateModeMock).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().sessions.find((s) => s.id === SID)?.permissionMode,
    ).toBe("manual");
  });
});

describe("per-action approval flow", () => {
  it("surfaces a pending approval card via onApprovalRequest and dismisses it on resolve", async () => {
    seedSession("manual");

    // A gated write_file call arrives → card surfaces.
    useChatStore.getState().onApprovalRequest({
      chatSessionId: SID,
      pendingId: "p1",
      tool: "write_file",
      summary: "write C:/projects/alpha/f.txt",
      args: { path: "C:/projects/alpha/f.txt", content: "hi" },
    });
    expect(useChatStore.getState().pendingApprovals[SID]?.tool).toBe("write_file");
    expect(useChatStore.getState().pendingApprovals[SID]?.pendingId).toBe("p1");

    // User approves → backend resolveToolAction called with the pending id.
    await useChatStore.getState().resolveApproval(SID, true);
    expect(resolveMock).toHaveBeenCalledWith("p1", true);
    expect(useChatStore.getState().pendingApprovals[SID]).toBeUndefined();
  });

  it("onApprovalResolved dismisses the card (backend resumed the loop)", () => {
    seedSession("manual");
    useChatStore.getState().onApprovalRequest({
      chatSessionId: SID,
      pendingId: "p2",
      tool: "delete_file",
      summary: "delete C:/x.txt",
      args: {},
    });
    expect(useChatStore.getState().pendingApprovals[SID]).toBeDefined();
    useChatStore.getState().onApprovalResolved({
      chatSessionId: SID,
      pendingId: "p2",
      approved: false,
    });
    expect(useChatStore.getState().pendingApprovals[SID]).toBeUndefined();
  });

  it("deny sends approved=false to the backend", async () => {
    seedSession("manual");
    useChatStore.getState().onApprovalRequest({
      chatSessionId: SID,
      pendingId: "p3",
      tool: "delete_file",
      summary: "delete C:/x.txt",
      args: {},
    });
    await useChatStore.getState().resolveApproval(SID, false);
    expect(resolveMock).toHaveBeenCalledWith("p3", false);
  });
});
