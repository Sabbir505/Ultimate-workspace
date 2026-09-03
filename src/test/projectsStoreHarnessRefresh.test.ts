// Store-level tests for the harness re-check wiring: `refreshHarnesses` must
// pass the `force` flag through to the `list_harnesses` IPC (the Settings
// "Re-check" button relies on it to bypass the backend's 30s probe cache and
// catch out-of-band installs), and must keep the current list when the IPC
// resolves with null (no Tauri runtime).
import { beforeEach, describe, expect, it, vi } from "vitest";

const listHarnessesMock = vi.fn();

// The mock factory must cover every ipc symbol state/projects.ts imports.
vi.mock("../lib/ipc", () => ({
  addProject: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getGitStatus: vi.fn(),
  initGitRepo: vi.fn(),
  listHarnesses: (...a: unknown[]) => listHarnessesMock(...a),
  listProjects: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn().mockResolvedValue([]),
  removeProject: vi.fn(),
  renameProject: vi.fn(),
  updateSessionTitle: vi.fn(),
}));

import { useProjectsStore } from "../state/projects";

const SAMPLE: { id: string; displayName: string; installed: boolean }[] = [
  { id: "claude_code", displayName: "Claude Code", installed: true },
  { id: "pi", displayName: "Pi", installed: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  listHarnessesMock.mockResolvedValue(SAMPLE);
});

describe("refreshHarnesses", () => {
  it("defaults to a cached (non-forced) probe", async () => {
    await useProjectsStore.getState().refreshHarnesses();
    expect(listHarnessesMock).toHaveBeenCalledWith(false);
  });

  it("passes force=true through to the IPC", async () => {
    await useProjectsStore.getState().refreshHarnesses(true);
    expect(listHarnessesMock).toHaveBeenCalledWith(true);
  });

  it("stores the probed list", async () => {
    await useProjectsStore.getState().refreshHarnesses(true);
    expect(useProjectsStore.getState().harnesses).toEqual(SAMPLE);
    expect(useProjectsStore.getState().loaded).toBe(false); // refresh doesn't imply boot load
  });

  it("keeps the previous list when the IPC resolves null", async () => {
    await useProjectsStore.getState().refreshHarnesses(true);
    listHarnessesMock.mockResolvedValue(null);
    await useProjectsStore.getState().refreshHarnesses(true);
    expect(useProjectsStore.getState().harnesses).toEqual(SAMPLE);
  });
});
