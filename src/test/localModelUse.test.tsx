// C11 (ISSUES.md): LocalModelsPanel's "Use" button always created a NEW chat
// session — the `existing` lookup was dead code, so two "Use" clicks on the
// same model spawned two identical sessions. A matching session must be
// REUSED via selectSession.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scanLocalModelsMock = vi.fn();
const startLocalModelMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scanLocalModels: (...a: unknown[]) => scanLocalModelsMock(...(a as [])),
  startLocalModel: (...a: unknown[]) => startLocalModelMock(...(a as [])),
  localModelStatus: vi.fn(async () => null),
  getLlamaServerPath: vi.fn(async () => null),
  getLocalModelOverrides: vi.fn(async () => null),
  getSetting: vi.fn(async () => ""),
  setSetting: vi.fn(async () => undefined),
}));

import { SettingsView } from "../components/settings/SettingsView";
import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";

const MODEL = {
  id: "model-7b",
  path: "D:/models/model-7b.gguf",
  filename: "model-7b.gguf",
  name: "model-7b",
  sizeBytes: 4_000_000_000,
};

const newChatMock = vi.fn();
const selectSessionMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  scanLocalModelsMock.mockResolvedValue([MODEL]);
  startLocalModelMock.mockResolvedValue({ ok: true });
  useUiStore.setState({ activeView: "settings", settingsCategory: "localmodels", localModelsOpenMarket: false });
  // Controllable chat-store session actions (the real newChat/selectSession
  // hit the backend; the mock mirrors newChat's store append).
  newChatMock.mockImplementation(async (provider: string, model: string) => {
    const session = { id: "new-1", title: null, provider, model, createdAt: 1, lastActiveAt: 2 };
    useChatStore.setState((s) => ({ sessions: [...s.sessions, session] }));
    return session;
  });
  selectSessionMock.mockResolvedValue(undefined);
  useChatStore.setState({
    sessions: [],
    newChat: newChatMock as never,
    selectSession: selectSessionMock as never,
  });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ activeView: "chat", settingsCategory: null, localModelsOpenMarket: false });
  useChatStore.setState({ sessions: [] });
});

describe("LocalModelsPanel — Use reuses the matching session (C11)", () => {
  it("two Use clicks yield one session (second click selects)", async () => {
    render(<SettingsView />);
    const useButtons = await screen.findAllByText("Use", { exact: true });
    expect(useButtons.length).toBeGreaterThanOrEqual(1);

    // First click: no matching session → create one.
    await act(async () => {
      fireEvent.click(useButtons[0]);
    });
    await waitFor(() => expect(newChatMock).toHaveBeenCalledTimes(1));
    expect(useChatStore.getState().sessions).toHaveLength(1);

    // Second click: the local_gguf session for this model already exists →
    // select it, do NOT create another.
    await act(async () => {
      fireEvent.click(useButtons[0]);
    });
    await waitFor(() => expect(selectSessionMock).toHaveBeenCalledWith("new-1"));
    expect(newChatMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().sessions).toHaveLength(1);
  });
});
