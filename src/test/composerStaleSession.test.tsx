// B1 (ISSUES.md): /create and artifact generation must target the session the
// composer was rendered for AT INVOCATION TIME. `triggerArtifactGeneration`
// captured `sessionIdProp` in a useCallback with `[]` deps, so when ChatView
// passed a new active session id (session switch, no remount), /create still
// wrote the command message, the proposal and the generated artifact into the
// PREVIOUS conversation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatComposer } from "../components/chat/ChatComposer";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Mount-time loaders (silence the real IPC wrappers).
  listConnectors: vi.fn(async () => []),
  mcpGalleryList: vi.fn(async () => ({ installed: [] })),
  listSessionConnectors: vi.fn(async () => []),
  listChatSkills: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
  // The /create persistence + generation path under test.
  persistChatCommandMessage: vi.fn(async () => ({ id: 42 })),
  generateArtifact: vi.fn(async () => ({ artifactType: "skill", spec: { type: "skill" } })),
}));

import { generateArtifact, persistChatCommandMessage } from "../lib/ipc";
import { useChatStore } from "../state/chat";

const persistMock = vi.mocked(persistChatCommandMessage);
const generateMock = vi.mocked(generateArtifact);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useChatStore.setState({ activeChatSessionId: null, splitChatSessionId: null });
});

function composerProps() {
  return { onSend: vi.fn(), streaming: false, onAgentModelPick: vi.fn() };
}

describe("ChatComposer /create targets the current session", () => {
  it("rerenders with a different session, then /create writes to the NEW session", async () => {
    // Neither the active pointer nor the split pointer names s1/s2, so the
    // command message lands nowhere — the IPC session id is the contract.
    useChatStore.setState({ activeChatSessionId: null, splitChatSessionId: null });
    const props = composerProps();
    const view = render(<ChatComposer {...props} sessionId="s1" />);
    // Session switch: ChatView passes the new active id without a remount.
    view.rerender(<ChatComposer {...props} sessionId="s2" />);

    const textarea = screen.getByPlaceholderText(/Write a message/);
    fireEvent.change(textarea, { target: { value: "/create skill zap" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await vi.waitFor(() => {
      expect(generateMock).toHaveBeenCalledTimes(1);
    });
    expect(persistMock).toHaveBeenCalledWith("s2", "/create skill zap");
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatSessionId: "s2" }),
    );
  });
});
