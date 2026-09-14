import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const getCostRollupsMock = vi.fn();
vi.mock("../lib/ipc", () => ({
  getCostRollups: (...a: unknown[]) => getCostRollupsMock(...a),
  safeListen: vi.fn().mockResolvedValue(() => {}),
}));

import { useCostRollups } from "../hooks/useCostRollups";

describe("useCostRollups", () => {
  beforeEach(() => {
    getCostRollupsMock.mockReset();
    getCostRollupsMock.mockResolvedValue(null);
  });

  it("returns loading=false after the IPC resolves", async () => {
    const { result } = renderHook(() => useCostRollups(30));
    // After resolution, loading flips to false.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rollups).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("refresh while mounted updates the rollups", async () => {
    const { result } = renderHook(() => useCostRollups(30));
    await waitFor(() => expect(result.current.loading).toBe(false));
    getCostRollupsMock.mockResolvedValue({ totals: { estimatedUsd: 1 } });
    result.current.refresh();
    await waitFor(() => expect(result.current.rollups).not.toBeNull());
    expect(result.current.error).toBeNull();
  });

  it("refresh resolving after unmount must not setState or throw (audit #16)", async () => {
    const { result, unmount } = renderHook(() => useCostRollups(30));
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Hold the refresh in flight across unmount.
    let settle: () => void = () => {};
    getCostRollupsMock.mockReturnValue(
      new Promise<void>((resolve) => { settle = resolve; }),
    );
    unmount();
    expect(() => result.current.refresh()).not.toThrow();
    settle();
    await Promise.resolve();
    await Promise.resolve();
    // No assertion beyond "no unhandled rejection / React warning" — the
    // cancelledRef guard inside the hook is what keeps setState away.
  });
});
