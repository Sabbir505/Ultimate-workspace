// Phase 4 — origin-scoped hooks. Covers the frontend half of the contract:
// the loader defaults a config written before `origins` existed to the global
// scope, `isKnownOrigin` keeps the open-ended `agent:<id>` family known, the
// panel exposes the picker and saves the selected set, and a stored origin
// Relay never dispatches is flagged without being hidden. The backend filter
// and the deny-for-one-origin path are covered Rust-side in
// src-tauri/src/hooks.rs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const getHooksMock = vi.fn();
const saveHooksMock = vi.fn();
const testHookMock = vi.fn();
const importFromClaudeMock = vi.fn();
const safeInvokeMock = vi.fn();

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

// The real `getHooks` reads the `hooks` app_settings key through the generic
// settings pair, which is `safeInvoke("get_setting")` — mocked at the
// transport so the genuine load path (JSON parse + normalize) is exercised
// end to end, not a stub.
vi.mock("../lib/ipcCore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipcCore")>();
  return { ...actual, safeInvoke: (...a: unknown[]) => safeInvokeMock(...a) };
});

import { HooksPanel } from "../components/settings/HooksPanel";
// Imported from the domain module, NOT the mocked barrel above, so these
// tests exercise the real loader instead of the panel's stub.
import {
  getHooks,
  isKnownOrigin,
  KNOWN_HOOK_ORIGINS,
  normalizeHookDef,
  type HookDef,
} from "../lib/ipc/hooks";

const stored = (over: Partial<HookDef> = {}): HookDef => ({
  id: "hook-1",
  event: "pre_tool_use",
  name: "protect-secrets",
  matcher: "write_file|edit_file",
  command: "node",
  args: [],
  timeoutSecs: 30,
  onError: "closed",
  async: false,
  origins: [],
  enabled: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  safeInvokeMock.mockResolvedValue(null);
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
    durationMs: 4,
  });
});
afterEach(cleanup);

describe("origin vocabulary", () => {
  it("knows the four dispatched origins and the whole agent: family", () => {
    expect(KNOWN_HOOK_ORIGINS).toEqual(["chat", "subagent", "harness", "relay_tools"]);
    for (const o of KNOWN_HOOK_ORIGINS) expect(isKnownOrigin(o)).toBe(true);
    // Crew ids are dynamic — any agent:<id> is known, including ids this
    // build has never seen (a check that would flag every crew hook unknown).
    expect(isKnownOrigin("agent:abc")).toBe(true);
    expect(isKnownOrigin("agent:doc-writer")).toBe(true);
    // Case and prefix are exact: the backend matches verbatim.
    expect(isKnownOrigin("Agent:abc")).toBe(false);
    expect(isKnownOrigin("agent")).toBe(false);
    expect(isKnownOrigin("crew:abc")).toBe(false);
    expect(isKnownOrigin("")).toBe(false);
  });
});

describe("HookDef.origins loading", () => {
  it("defaults to the global scope when the stored JSON omits it", async () => {
    // A config saved before Phase 4 — no `origins` key at all.
    safeInvokeMock.mockImplementation(async (cmd: string) =>
      cmd === "get_setting"
        ? JSON.stringify([
            {
              id: "legacy",
              event: "pre_tool_use",
              name: "legacy",
              matcher: "*",
              command: "node",
              args: [],
              timeoutSecs: 30,
              onError: "open",
              async: false,
              enabled: true,
            },
          ])
        : null,
    );
    const loaded = await getHooks();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].origins).toEqual([]);
    // The old config is untouched otherwise (nothing is rewritten on load).
    expect(loaded[0].command).toBe("node");
  });

  it("keeps a stored origin list verbatim and normalizes a non-array value", async () => {
    safeInvokeMock.mockImplementation(async (cmd: string) =>
      cmd === "get_setting"
        ? JSON.stringify([
            { ...stored({ id: "a" }), origins: ["chat", "agent:crew-1"] },
            { ...stored({ id: "b" }), origins: "chat" },
          ])
        : null,
    );
    const loaded = await getHooks();
    expect(loaded[0].origins).toEqual(["chat", "agent:crew-1"]);
    // A hand-edited non-array degrades to global rather than throwing in the
    // panel; the backend skips such an entry, so the user sees it as global.
    expect(loaded[1].origins).toEqual([]);
    expect(normalizeHookDef({ ...stored(), origins: undefined as never }).origins).toEqual([]);
  });
});

describe("HooksPanel origin picker", () => {
  it("saves the selected origins on the added hook", async () => {
    render(<HooksPanel />);
    await screen.findByText(/No hooks yet/);
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });

    // Nothing ticked = global (the default, and what today's configs mean).
    expect(screen.getByText("Runs for:")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Scope to main chat"));
    fireEvent.click(screen.getByLabelText("Scope to CLI harness (claude/kimi)"));
    expect(screen.getByText("Only for:")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Crew agent origins"), {
      target: { value: "crew-7" },
    });

    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(saveHooksMock).toHaveBeenCalledTimes(1));
    const saved = saveHooksMock.mock.calls[0][0] as HookDef[];
    expect(saved).toHaveLength(1);
    // A bare id in the field is stored in its dispatched form, `agent:<id>`.
    expect(saved[0].origins).toEqual(["chat", "harness", "agent:crew-7"]);
  });

  it("saves an empty list (global) when nothing is selected", async () => {
    render(<HooksPanel />);
    await screen.findByText(/No hooks yet/);
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.click(screen.getByLabelText("Scope to main chat"));
    fireEvent.click(screen.getByLabelText("Scope to main chat"));
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(saveHooksMock).toHaveBeenCalled());
    const saved = saveHooksMock.mock.calls[0][0] as HookDef[];
    expect(saved[0].origins).toEqual([]);
  });

  it("hides the picker for lifecycle events, which are always global", async () => {
    render(<HooksPanel />);
    await screen.findByText(/No hooks yet/);
    fireEvent.change(screen.getByLabelText("Hook event"), { target: { value: "turn_complete" } });
    expect(screen.queryByLabelText("Scope to main chat")).toBeNull();
    expect(screen.queryByLabelText("Crew agent origins")).toBeNull();
    expect(screen.getByText(/Fires for every turn/)).toBeTruthy();
  });

  it("clears the staged agent-origin text when the event toggles through a lifecycle type", async () => {
    // Regression: switching pre → lifecycle cleared `draft.origins` but left
    // the free-text mirror showing the ids the user typed, so a hook saved
    // after switching BACK looked scoped in the editor while persisting as
    // GLOBAL — a deny hook that silently widened to every origin.
    render(<HooksPanel />);
    await screen.findByText(/No hooks yet/);
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("Crew agent origins"), {
      target: { value: "crew-7" },
    });

    // Round-trip through a lifecycle event (the scope is dropped)…
    fireEvent.change(screen.getByLabelText("Hook event"), { target: { value: "turn_complete" } });
    expect(screen.queryByLabelText("Crew agent origins")).toBeNull();
    fireEvent.change(screen.getByLabelText("Hook event"), { target: { value: "pre_tool_use" } });

    // …and the mirror is empty with the parsed scope, not showing stale ids.
    expect((screen.getByLabelText("Crew agent origins") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/Runs for:/)).toBeTruthy();
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(saveHooksMock).toHaveBeenCalledTimes(1));
    const saved = saveHooksMock.mock.calls[0][0] as HookDef[];
    expect(saved[0].event).toBe("pre_tool_use");
    expect(saved[0].origins).toEqual([]);
  });

  it("shows the stored scope and flags an unknown origin without hiding it", async () => {
    getHooksMock.mockResolvedValue([
      stored({ id: "everywhere", name: "everywhere" }),
      stored({ id: "scoped", name: "scoped", origins: ["agent:crew-1", "harness"] }),
      stored({ id: "weird", name: "weird", origins: ["agenttypo"] }),
    ]);
    render(<HooksPanel />);
    await screen.findByText(/everywhere/);
    // A global hook says so…
    expect(screen.getByText("all origins")).toBeTruthy();
    // …a scoped one names its origins.
    expect(screen.getByText("only: agent:crew-1, harness")).toBeTruthy();
    // The unknown one is flagged AND still displayed.
    const chips = screen.getAllByText(/unknown origin/);
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain("agenttypo");
    // A known `agent:<id>` never gets the chip.
    expect(screen.queryByText(/unknown origin: agent:crew-1/)).toBeNull();
  });
});
