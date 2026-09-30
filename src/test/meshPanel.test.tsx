// Settings → Session Mesh (P4): the master switch reads and writes
// `sessionMesh.enabled` with the Rust runtime's default-ON semantics, the
// mesh hook events are reachable, and the deep links land on Hooks /
// Subagents.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const getSettingMock = vi.fn();
const setSettingMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    getSetting: (...a: unknown[]) => getSettingMock(...a),
    setSetting: (...a: unknown[]) => setSettingMock(...a),
  };
});

import { MeshPanel } from "../components/settings/MeshPanel";
import { useUiStore } from "../state/ui";

beforeEach(() => {
  vi.clearAllMocks();
  getSettingMock.mockResolvedValue(null);
  setSettingMock.mockResolvedValue(undefined);
  useUiStore.setState({ settingsCategory: null });
});
afterEach(cleanup);

describe("MeshPanel", () => {
  it("defaults ON when the setting is unset (matches mesh_enabled)", async () => {
    render(<MeshPanel />);
    const sw = await screen.findByTestId("mesh-enabled-switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("persists a toggle off as 'false'", async () => {
    getSettingMock.mockResolvedValue("true");
    render(<MeshPanel />);
    const sw = await screen.findByTestId("mesh-enabled-switch");
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(sw);
    await waitFor(() => expect(setSettingMock).toHaveBeenCalledWith("sessionMesh.enabled", "false"));
  });

  it("reads the Rust toggle vocabulary ('off' means off)", async () => {
    getSettingMock.mockResolvedValue("off");
    render(<MeshPanel />);
    const sw = await screen.findByTestId("mesh-enabled-switch");
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
  });

  it("deep-links to Hooks and Subagents", async () => {
    render(<MeshPanel />);
    fireEvent.click(await screen.findByTestId("mesh-open-hooks"));
    expect(useUiStore.getState().settingsCategory).toBe("hooks");
    fireEvent.click(await screen.findByTestId("mesh-open-subagents"));
    expect(useUiStore.getState().settingsCategory).toBe("subagents");
  });
});
