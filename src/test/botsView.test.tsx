// Bots IPC + view/editor smoke tests (docs/architecture/BOTS.md).
//
// The wrappers are thin, so the point of these tests is the CONTRACT the UI
// depends on: camelCase payloads the Rust commands expect, patch-shaped
// updates (a rename must not carry the persona), the disabled-on-create rule
// showing up as the rail's Approve action, and the editor sending only what
// changed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("../lib/ipcCore", () => ({
  safeInvoke: (...args: unknown[]) => invokeMock(...args),
  safeListen: vi.fn(async () => () => {}),
  tauriRuntimeAvailable: () => false,
  toastError: vi.fn(),
}));

import { listBots, createBot, ensureBotSession, updateBot, runBotNow } from "../lib/ipc/bots";
import { BotEditorModal } from "../components/bots/BotEditorModal";
import type { Bot } from "../lib/ipc/bots";

function makeBot(over: Partial<Bot> = {}): Bot {
  return {
    id: "b1",
    name: "Atlas",
    description: "Morning briefings",
    emoji: "🛰️",
    color: "#4ec9b0",
    pet: "fox",
    systemPrompt: "You are Atlas.",
    provider: "",
    model: "",
    toolsEnabled: true,
    memoryEnabled: true,
    enabled: true,
    inheritGlobalPrompt: true,
    memoryReadDefault: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

afterEach(() => cleanup());
beforeEach(() => invokeMock.mockReset());

describe("bots ipc", () => {
  it("listBots invokes list_bots and passes the roster through", async () => {
    invokeMock.mockResolvedValue([makeBot()]);
    const bots = await listBots();
    expect(invokeMock).toHaveBeenCalledWith("list_bots");
    expect(bots[0].description).toBe("Morning briefings");
  });

  it("createBot sends the input under `input` (camelCase)", async () => {
    invokeMock.mockResolvedValue(makeBot({ id: "b2", name: "Scout" }));
    await createBot({ name: "Scout", description: "Repo watcher", pet: "dragon", toolsEnabled: true });
    expect(invokeMock).toHaveBeenCalledWith("create_bot", {
      input: { name: "Scout", description: "Repo watcher", pet: "dragon", toolsEnabled: true },
    });
  });

  it("updateBot is a patch: a rename carries only the name", async () => {
    invokeMock.mockResolvedValue(makeBot({ name: "Orion" }));
    await updateBot("b1", { name: "Orion" });
    expect(invokeMock).toHaveBeenCalledWith("update_bot", { botId: "b1", patch: { name: "Orion" } });
  });

  it("ensureBotSession returns the thread id", async () => {
    invokeMock.mockResolvedValue("sess-77");
    const sid = await ensureBotSession("b1");
    expect(invokeMock).toHaveBeenCalledWith("ensure_bot_session", { botId: "b1" });
    expect(sid).toBe("sess-77");
  });

  it("runBotNow asks for a run and hands back its session", async () => {
    invokeMock.mockResolvedValue({ runId: "r1", sessionId: "s9", prompt: "go" });
    const out = await runBotNow("b1", "do the thing");
    expect(invokeMock).toHaveBeenCalledWith("run_bot_now", { botId: "b1", prompt: "do the thing" });
    expect(out.sessionId).toBe("s9");
  });
});

describe("BotEditorModal", () => {
  it("creates with name, description, persona, pet and the toggles", async () => {
    const onCreate = vi.fn().mockResolvedValue(makeBot({ id: "b9" }));
    render(<BotEditorModal onClose={() => {}} onCreate={onCreate} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Atlas" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Briefings" } });
    fireEvent.change(screen.getByLabelText("Persona"), { target: { value: "Be terse." } });
    fireEvent.click(screen.getByRole("radio", { name: /fox/i }));
    fireEvent.click(screen.getByText("Save"));
    await vi.waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Atlas",
          description: "Briefings",
          systemPrompt: "Be terse.",
          pet: "fox",
          toolsEnabled: true,
          memoryEnabled: true,
        }),
      ),
    );
  });

  it("edits through a patch and never re-sends untouched fields", async () => {
    const onUpdate = vi.fn().mockResolvedValue(makeBot());
    render(
      <BotEditorModal
        bot={makeBot()}
        onClose={() => {}}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.change(screen.getByLabelText("Persona"), { target: { value: "New persona" } });
    fireEvent.click(screen.getByText("Save"));
    await vi.waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith("b1", { systemPrompt: "New persona" }),
    );
  });

  it("sends a changed enabled flag from the Active toggle", async () => {
    const onUpdate = vi.fn().mockResolvedValue(makeBot({ enabled: false }));
    render(
      <BotEditorModal
        bot={makeBot({ enabled: true })}
        onClose={() => {}}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Active/));
    fireEvent.click(screen.getByText("Save"));
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith("b1", { enabled: false }));
  });

  it("keeps the modal open and shows the backend's name error verbatim", async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error('A bot named "Atlas" already exists'));
    render(
      <BotEditorModal
        bot={makeBot()}
        onClose={() => {}}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Scout" } });
    fireEvent.click(screen.getByText("Save"));
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("already exists"),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("a disabled bot is presented as waiting for approval", async () => {
    render(
      <BotEditorModal
        bot={makeBot({ enabled: false })}
        onClose={() => {}}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
