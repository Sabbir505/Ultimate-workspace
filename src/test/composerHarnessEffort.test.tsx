// Full composer-chain test for the harness effort slider: ChatView wires
// ChatComposer with harnessEffort/onHarnessEffortChange, ChatComposer must
// forward both to AgentModelPicker. Guards against a dropped prop along the
// three-hop chain (ChatView → ChatComposer → AgentModelPicker) — the picker's
// own gating is covered in AgentModelPicker-level tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

import { ChatComposer } from "../components/chat/ChatComposer";
import { paneCache, paneInFlight } from "../components/chat/agentPickerShared";

const listHarnessesMock = vi.fn();
const listHarnessModelsMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  // Partial mock: the picker needs exact control of the harness probes;
  // everything else runs for real (safeInvoke no-ops without a Tauri
  // runtime, same as the other composer tests).
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    listHarnesses: (...a: unknown[]) => listHarnessesMock(...a),
    listAcpAgents: vi.fn().mockResolvedValue([]),
    listHarnessModels: (...a: unknown[]) => listHarnessModelsMock(...a),
    listChatModels: vi.fn().mockResolvedValue([]),
    scanLocalModels: vi.fn().mockResolvedValue([]),
    getChatConfig: vi.fn().mockResolvedValue(null),
  };
});

const slider = (): HTMLElement | null =>
  screen.queryByRole("slider", { name: "Harness effort" });

beforeEach(() => {
  vi.clearAllMocks();
  paneCache.clear();
  paneInFlight.clear();
  listHarnessesMock.mockResolvedValue([
    { id: "claude_code", displayName: "Claude Code", installed: true },
  ]);
  listHarnessModelsMock.mockResolvedValue({
    defaultModel: "opus[1m]",
    endpoint: "https://api2.sharkai.cc",
    effort: "max",
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    models: [],
  });
});
afterEach(cleanup);

describe("ChatComposer → AgentModelPicker harness effort wiring", () => {
  it("forwards harnessEffort + setter so the slider renders and fires", async () => {
    const onHarnessEffortChange = vi.fn();
    const { container } = render(
      <ChatComposer
        sessionId="s1"
        onSend={() => {}}
        streaming={false}
        agent="harness:claude_code"
        model="opus[1m]"
        onAgentModelPick={() => {}}
        // Exactly what ChatView passes for a harness session:
        harnessEffort=""
        onHarnessEffortChange={onHarnessEffortChange}
      />,
    );
    // Open the picker chip.
    fireEvent.click(container.querySelector<HTMLElement>(".agent-chip")!);
    const el = await waitFor(() => {
      const s = slider();
      expect(s).toBeTruthy();
      return s!;
    });
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(onHarnessEffortChange).toHaveBeenCalledWith("low");
  });

  it("renders slider-free when ChatView passes no setter (non-harness session)", async () => {
    const { container } = render(
      <ChatComposer
        sessionId="s1"
        onSend={() => {}}
        streaming={false}
        agent="harness:claude_code"
        model="opus[1m]"
        onAgentModelPick={() => {}}
      />,
    );
    fireEvent.click(container.querySelector<HTMLElement>(".agent-chip")!);
    await waitFor(() =>
      expect(listHarnessModelsMock).toHaveBeenCalledWith("claude_code"),
    );
    // There is no harness session to persist a tier onto.
    await waitFor(() => expect(paneCache.get("harness:claude_code")?.status).toBe("ready"));
    expect(slider()).toBeNull();
  });
});
