// Regression tests for the completion-notification phantom-turn gate: the
// backend's cancel/teardown path (Stop, chat deletion, bulk clear) emits
// chat:done with NULL usage purely to clear streaming state, and headless or
// deleted sessions never sit in the frontend session list. Both used to fire
// "Untitled Session finished — Agent turn complete" alerts for turns that
// never produced anything. Only a real finished turn (output tokens reported,
// session the user actually has) may notify.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const notifySpy = vi.fn();
vi.mock("../lib/notifyCenter", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  relayNotify: (...a: unknown[]) => notifySpy(...a),
}));
vi.mock("../lib/appFocus", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAppFocused: () => true,
}));
vi.mock("../hooks/useTtsAutoRead", () => ({
  autoReadFinishedTurn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/openBrowserPane", () => ({
  openInBrowserPane: vi.fn(),
}));
vi.mock("../lib/ipc/harnessChat", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitMobileSessionChatEvent: vi.fn(),
}));

const listeners = new Map<string, (p: unknown) => void>();
vi.mock("../lib/ipcCore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tauriRuntimeAvailable: () => false,
  safeInvoke: vi.fn(async (cmd: string): Promise<never> => {
    if (cmd.includes("message")) return [] as never;
    if (cmd.includes("session")) return [] as never;
    return null as never;
  }),
  safeListen: vi.fn((event: string, handler: (p: unknown) => void) => {
    listeners.set(event, handler);
    return Promise.resolve(() => {});
  }),
}));

import { useChatStore } from "../state/chat";
import { useChatEvents } from "../hooks/useChatEvents";

function seed() {
  useChatStore.setState({
    sessions: [
      { id: "s1", title: null, provider: "openai", model: "m", createdAt: 0, lastActiveAt: 0 },
    ] as never,
    // The user is looking at a different chat: s1 completes in the background.
    focusedChatSessionId: null,
    activeChatSessionId: "other",
    messages: [],
    streaming: {},
    chatStatus: {},
    streamingChatSessionId: null,
  });
  notifySpy.mockClear();
}

function donePayload(over: Record<string, unknown>) {
  return {
    chatSessionId: "s1",
    inputTokens: 12,
    outputTokens: 250,
    costUsd: 0.001,
    ...over,
  };
}

beforeEach(() => {
  seed();
  listeners.clear();
});

describe("chat:done completion notification gate", () => {
  it("alerts for a real finished turn in a background session", async () => {
    renderHook(() => useChatEvents());
    const handler = listeners.get("chat:done");
    expect(handler).toBeTruthy();
    handler!(donePayload({}));
    await Promise.resolve();
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "completed", chatSessionId: "s1" }),
    );
  });

  it("stays silent for the cancel/teardown done (no output tokens)", async () => {
    renderHook(() => useChatEvents());
    const handler = listeners.get("chat:done");
    handler!(donePayload({ inputTokens: null, outputTokens: null, costUsd: null }));
    handler!(donePayload({ outputTokens: 0 }));
    await Promise.resolve();
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("stays silent for sessions the store doesn't know (headless/deleted)", async () => {
    renderHook(() => useChatEvents());
    const handler = listeners.get("chat:done");
    handler!(donePayload({ chatSessionId: "ghost-session" }));
    await Promise.resolve();
    expect(notifySpy).not.toHaveBeenCalled();
  });
});
