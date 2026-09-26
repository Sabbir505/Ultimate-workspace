// The agent chip must show the session's SELECTED model, not the model the
// harness LAST actually ran. Both used to ride one prop: for a harness session
// ChatView preferred the CLI's last-reported model (correct for the context
// meter — it names what produced the usage), so a freshly picked model kept
// displaying as the previous one until the next turn completed. The two
// concepts now split: `model` (selection) → the picker, `actualModel` → the
// meter.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ChatComposer } from "../components/chat/ChatComposer";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Mount-time loaders (silence the real IPC wrappers).
  listConnectors: vi.fn(async () => []),
  mcpGalleryList: vi.fn(async () => ({ installed: [] })),
  listSessionConnectors: vi.fn(async () => []),
  listChatSkills: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
  listChatInstances: vi.fn(async () => []),
  listHarnesses: vi.fn(async () => []),
  listAcpAgents: vi.fn(async () => []),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const chipLabel = (): string =>
  document.querySelector(".agent-chip-label")?.textContent ?? "";

function renderComposer() {
  return render(
    <ChatComposer
      onSend={vi.fn()}
      streaming={false}
      onAgentModelPick={vi.fn()}
      agent="harness:opencode"
      provider="opencode"
      // The user just picked gpt-5; the CLI last ran gpt-4.1.
      model="gpt-5"
      actualModel="gpt-4.1"
    />,
  );
}

describe("ChatComposer model split (selection vs last-actual)", () => {
  it("shows the SELECTION on the agent chip", () => {
    renderComposer();
    expect(chipLabel()).toContain("gpt-5");
  });

  it("does not leak the last-actual model into the chip", () => {
    renderComposer();
    expect(chipLabel()).not.toContain("gpt-4.1");
  });

  it("still names the selection with no actual model reported yet", () => {
    // First turn of a fresh pick: the harness has reported nothing.
    render(
      <ChatComposer
        onSend={vi.fn()}
        streaming={false}
        onAgentModelPick={vi.fn()}
        agent="harness:opencode"
        provider="opencode"
        model="gpt-5"
        actualModel={null}
      />,
    );
    expect(chipLabel()).toContain("gpt-5");
  });
});
