// Store-level tests for the permission-mode selector + per-action approval flow.
//
// Verifies the behavioral acceptance criteria that live in the frontend:
//  - Switching INTO full_auto opens a one-time confirmation modal (does NOT
//    apply the mode on first request); subsequent switches within the same
//    runtime session don't re-prompt.
//  - Switching to read_only / auto_edit / manual applies immediately.
//  - A pending approval card is surfaced via onApprovalRequest and dismissed
//    via onApprovalResolved / resolveApproval (the manual-mode regression:
//    the approval-card flow still works).
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the IPC layer so the store never touches the Tauri bridge.
vi.mock("../lib/ipc", () => ({
  updateChatSessionPermissionMode: vi.fn().mockResolvedValue(undefined),
  resolveToolAction: vi.fn().mockResolvedValue(undefined),
  listChatSessions: vi.fn().mockResolvedValue([]),
  getChatMessages: vi.fn().mockResolvedValue([]),
  listChatArtifacts: vi.fn().mockResolvedValue([]),
  touchChatSession: vi.fn().mockResolvedValue(undefined),
  cancelChatMessage: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  generateChatTitle: vi.fn(),
  getChatConfig: vi.fn(),
  sendChatMessage: vi.fn(),
  setChatApiKey: vi.fn(),
  deleteChatApiKey: vi.fn(),
  setChatSessionStarred: vi.fn(),
  setChatSessionUnread: vi.fn(),
  updateChatSessionModel: vi.fn(),
  updateChatSessionTitle: vi.fn(),
}));

import {
  updateChatSessionPermissionMode,
  resolveToolAction,
} from "../lib/ipc";
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
  // Reset the module-scoped fullAutoConfirmed set by reloading the store module
  // fresh each test would be ideal, but the set is private; instead we drive
  // state purely through the actions, which is what the tests exercise.
});

describe("permission-mode selector (full_auto confirmation)", () => {
  it("opens the confirmation modal instead of applying full_auto on first switch", async () => {
    seedSession("manual");
    const applied = await useChatStore.getState().setSessionPermissionMode(SID, "full_auto");
    // NOT applied yet — the modal opened.
    expect(applied).toBe(false);
    expect(useChatStore.getState().fullAutoConfirmingFor).toBe(SID);
    // The backend setter was NOT called (mode unchanged).
    expect(updateChatSessionPermissionMode).not.toHaveBeenCalled();
    // The session's mode is still manual.
    expect(
      useChatStore.getState().sessions.find((s) => s.id === SID)?.permissionMode,
    ).toBe("manual");
  });

  it("applies full_auto after confirming, and does not re-prompt on a later switch", async () => {
    const id = seedSession("manual", "sess-confirm");
    // First switch → modal.
    await useChatStore.getState().setSessionPermissionMode(id, "full_auto");
    expect(useChatStore.getState().fullAutoConfirmingFor).toBe(id);
    // Confirm.
    await useChatStore.getState().confirmFullAuto(id);
    expect(updateChatSessionPermissionMode).toHaveBeenCalledWith(id, "full_auto");
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
    expect(updateChatSessionPermissionMode).toHaveBeenCalledWith(id, "manual");
    expect(updateChatSessionPermissionMode).toHaveBeenCalledWith(id, "full_auto");
  });

  it("applies read_only / auto_edit immediately without a modal", async () => {
    seedSession("manual");
    const a1 = await useChatStore.getState().setSessionPermissionMode(SID, "read_only");
    const a2 = await useChatStore.getState().setSessionPermissionMode(SID, "auto_edit");
    expect(a1).toBe(true);
    expect(a2).toBe(true);
    expect(useChatStore.getState().fullAutoConfirmingFor).toBeNull();
    expect(updateChatSessionPermissionMode).toHaveBeenCalledWith(SID, "read_only");
    expect(updateChatSessionPermissionMode).toHaveBeenCalledWith(SID, "auto_edit");
  });

  it("cancelFullAutoConfirm leaves the mode unchanged", async () => {
    seedSession("manual");
    await useChatStore.getState().setSessionPermissionMode(SID, "full_auto");
    useChatStore.getState().cancelFullAutoConfirm();
    expect(useChatStore.getState().fullAutoConfirmingFor).toBeNull();
    expect(updateChatSessionPermissionMode).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().sessions.find((s) => s.id === SID)?.permissionMode,
    ).toBe("manual");
  });
});

describe("per-action approval flow (manual-mode regression)", () => {
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
    expect(resolveToolAction).toHaveBeenCalledWith("p1", true);
    // Card is gone.
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
    expect(resolveToolAction).toHaveBeenCalledWith("p3", false);
  });
});
