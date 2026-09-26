// Vault read-aloud wiring: the note-header controls must file a read under
// the vault's own key namespace and hand the engine the note body. The TTS
// player itself is mocked out — this asserts the call the vault makes, not
// the speech synthesis behind it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toggleReadAloudMock = vi.fn();
const ttsPlayerStopMock = vi.fn();

vi.mock("../lib/tts", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    toggleReadAloud: (...a: unknown[]) => toggleReadAloudMock(...a),
    ttsPlayer: { ...(mod.ttsPlayer as object), stop: (...a: unknown[]) => ttsPlayerStopMock(...a) },
  };
});

const vaultGetStateMock = vi.fn();
const vaultTreeMock = vi.fn();
const vaultStatsMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    vaultGetState: (...a: unknown[]) => vaultGetStateMock(...a),
    vaultTree: (...a: unknown[]) => vaultTreeMock(...a),
    vaultStats: (...a: unknown[]) => vaultStatsMock(...a),
    vaultReadNote: vi.fn().mockResolvedValue(""),
    listenVaultChanged: vi.fn().mockResolvedValue(() => {}),
    listenVaultScanned: vi.fn().mockResolvedValue(() => {}),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { VaultView } from "../components/vault/VaultView";
import { useVaultStore } from "../state/vault";
import { useTtsStore } from "../state/tts";

const NOTE = "Journal/2026-09-19.md";
const BODY = "# Standup\n\nShipped the vault voice controls.";

beforeEach(() => {
  vi.clearAllMocks();
  useTtsStore.setState({
    key: null,
    label: null,
    index: 0,
    total: 0,
    rate: 1,
    phase: "idle",
    error: null,
    autoRead: false,
  });
  useVaultStore.setState({
    root: "C:/myvault",
    stats: { notes: 1, files: 1, links: 0, unresolved: 0 },
    tree: [{ name: "2026-09-19.md", path: NOTE, kind: "note", children: [] }],
    activePath: NOTE,
    content: BODY,
    savedContent: BODY,
    loadingNote: false,
    // Notes open in preview mode by default (state/vault.ts openNote); these
    // tests exercise the header controls, which need the edit surface.
    mode: "edit",
    graphOpen: false,
    switcherOpen: false,
  });
  vaultGetStateMock.mockResolvedValue({
    root: "C:/myvault",
    stats: { notes: 1, files: 1, links: 0, unresolved: 0 },
  });
  vaultTreeMock.mockResolvedValue([]);
});

describe("vault read-aloud controls", () => {
  it("reads the whole note under the vault key namespace", async () => {
    render(<VaultView />);
    const btn = await screen.findByLabelText("Read this note aloud");
    fireEvent.click(btn);
    expect(toggleReadAloudMock).toHaveBeenCalledWith({
      key: `vault:${NOTE}`,
      // The transport bar shows the bare name, not the whole vault path.
      label: "2026-09-19",
      text: BODY,
    });
  });

  it("turns into a stop button while that note is playing", async () => {
    useTtsStore.setState({ key: `vault:${NOTE}`, phase: "playing", index: 1, total: 4 });
    render(<VaultView />);
    const btn = await screen.findByLabelText("Stop reading this note aloud");
    fireEvent.click(btn);
    // Same key → stop, not a second read of the same note.
    expect(ttsPlayerStopMock).toHaveBeenCalled();
    expect(toggleReadAloudMock).not.toHaveBeenCalled();
  });

  it("stops the read when the user switches to a different note", async () => {
    useTtsStore.setState({ key: `vault:${NOTE}`, phase: "playing", index: 1, total: 4 });
    render(<VaultView />);
    await screen.findByLabelText("Stop reading this note aloud");
    // Narration must not outlive the note the user is looking at.
    await act(async () => {
      useVaultStore.setState({ activePath: "Journal/2026-09-20.md" });
    });
    await waitFor(() => expect(ttsPlayerStopMock).toHaveBeenCalled());
  });

  it("leaves a read of ANOTHER note's note alone when it is not vault's", async () => {
    useTtsStore.setState({ key: "msg:s1:m1", phase: "playing", index: 1, total: 4 });
    render(<VaultView />);
    await screen.findByLabelText("Read this note aloud");
    await act(async () => {
      useVaultStore.setState({ activePath: "Journal/2026-09-20.md" });
    });
    // A chat read shares the one transport bar; the vault's teardown guard
    // keys on the vault: prefix only and must not touch it.
    expect(ttsPlayerStopMock).not.toHaveBeenCalled();
  });

  it("disables the read-selection control until there is a selection", async () => {
    render(<VaultView />);
    const sel = await screen.findByLabelText("Read the selected text aloud");
    // No editor view is mounted in this harness, so there is never a selection.
    expect((sel as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables dictation only in edit mode, where there is something to write into", async () => {
    render(<VaultView />);
    const mic = await screen.findByLabelText("Dictate into this note");
    expect((mic as HTMLButtonElement).disabled).toBe(false);
    expect(mic.getAttribute("title")).toMatch(/hold Alt/);
  });

  it("disables dictation in preview mode and says why", async () => {
    render(<VaultView />);
    await screen.findByLabelText("Dictate into this note");
    await act(async () => {
      useVaultStore.setState({ mode: "preview" });
    });
    const mic = await screen.findByLabelText("Dictate into this note");
    expect((mic as HTMLButtonElement).disabled).toBe(true);
    expect(mic.getAttribute("title")).toBe("Switch to Edit mode to dictate");
  });
});
