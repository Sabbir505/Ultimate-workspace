// Settings → Hooks panel: renders configured hooks, add/toggle/remove flows,
// and the per-hook Test button (mocked ipc). Backend behavior — matching,
// substitution, verdict classification — is unit-tested Rust-side in
// src-tauri/src/hooks.rs; this covers the user-facing surface.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const getHooksMock = vi.fn();
const saveHooksMock = vi.fn();
const testHookMock = vi.fn();
const importFromClaudeMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    getHooks: (...a: unknown[]) => getHooksMock(...a),
    saveHooks: (...a: unknown[]) => saveHooksMock(...a),
    testHook: (...a: unknown[]) => testHookMock(...a),
    importFromClaude: (...a: unknown[]) => importFromClaudeMock(...a),
  };
});

import { HooksPanel } from "../components/settings/HooksPanel";
import type { HookDef } from "../lib/ipc";

const hook: HookDef = {
  id: "hook-1",
  event: "pre_tool_use",
  name: "protect-secrets",
  matcher: "write_file|edit_file",
  command: "node",
  args: ["C:/hooks/block-secrets.js"],
  timeoutSecs: 30,
  onError: "closed",
  async: false,
  origins: [],
  enabled: true,
};

describe("HooksPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHooksMock.mockResolvedValue([]);
    saveHooksMock.mockResolvedValue(undefined);
    importFromClaudeMock.mockResolvedValue({
      imported: [],
      skippedDuplicates: 0,
      skippedNonCommand: 0,
      fileFound: false,
    });
    testHookMock.mockResolvedValue({
      ran: true,
      gateDenied: false,
      spawnFailed: false,
      timedOut: false,
      exitCode: 0,
      stdout: "",
      stderr: "",
      decision: null,
      reason: null,
      durationMs: 12,
    });
  });
  afterEach(cleanup);

  it("shows the empty state when no hooks are configured", async () => {
    render(<HooksPanel />);
    expect(await screen.findByText(/No hooks yet/)).toBeTruthy();
  });

  it("renders a configured hook with its matcher and controls", async () => {
    getHooksMock.mockResolvedValue([hook]);
    render(<HooksPanel />);
    expect(await screen.findByText(/protect-secrets/)).toBeTruthy();
    expect(screen.getByText(/write_file\|edit_file/)).toBeTruthy();
    expect((screen.getByLabelText("Enable protect-secrets") as HTMLInputElement).checked).toBe(true);
  });

  it("adds a hook from the draft form", async () => {
    render(<HooksPanel />);
    await screen.findByText(/No hooks yet/);
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("Tool matcher"), { target: { value: "run_shell" } });
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(saveHooksMock).toHaveBeenCalledTimes(1));
    const saved = saveHooksMock.mock.calls[0][0] as HookDef[];
    expect(saved).toHaveLength(1);
    expect(saved[0].command).toBe("node");
    expect(saved[0].matcher).toBe("run_shell");
    expect(saved[0].event).toBe("pre_tool_use");
  });

  it("disables Add until a command is entered", async () => {
    render(<HooksPanel />);
    await screen.findByText(/No hooks yet/);
    const add = screen.getByText("Add").closest("button") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    expect(add.disabled).toBe(false);
    expect(saveHooksMock).not.toHaveBeenCalled();
  });

  it("toggles a hook's enabled state", async () => {
    getHooksMock.mockResolvedValue([hook]);
    render(<HooksPanel />);
    await screen.findByText(/protect-secrets/);
    fireEvent.click(screen.getByLabelText("Enable protect-secrets"));
    await waitFor(() => expect(saveHooksMock).toHaveBeenCalledTimes(1));
    const saved = saveHooksMock.mock.calls[0][0] as HookDef[];
    expect(saved[0].enabled).toBe(false);
  });

  it("removes a hook", async () => {
    getHooksMock.mockResolvedValue([hook]);
    render(<HooksPanel />);
    await screen.findByText(/protect-secrets/);
    fireEvent.click(screen.getByLabelText("Remove hook"));
    await waitFor(() => expect(saveHooksMock).toHaveBeenCalledTimes(1));
    expect(saveHooksMock.mock.calls[0][0]).toEqual([]);
  });

  it("runs the Test button and shows the report", async () => {
    getHooksMock.mockResolvedValue([hook]);
    render(<HooksPanel />);
    await screen.findByText(/protect-secrets/);
    fireEvent.click(screen.getByLabelText("Test hook"));
    await waitFor(() => expect(testHookMock).toHaveBeenCalledWith(hook));
    expect(await screen.findByText(/Exit 0 in 12 ms/)).toBeTruthy();
  });

  it("shows a gate-denied test report distinctly", async () => {
    getHooksMock.mockResolvedValue([hook]);
    importFromClaudeMock.mockResolvedValue({
      imported: [],
      skippedDuplicates: 0,
      skippedNonCommand: 0,
      fileFound: false,
    });
    testHookMock.mockResolvedValue({
      ran: false,
      gateDenied: true,
      spawnFailed: false,
      timedOut: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      decision: null,
      reason: null,
      durationMs: 3,
    });
    render(<HooksPanel />);
    await screen.findByText(/protect-secrets/);
    fireEvent.click(screen.getByLabelText("Test hook"));
    expect(await screen.findByText(/Not allowed to run/)).toBeTruthy();
  });
});
