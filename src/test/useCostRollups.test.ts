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

  it("refetches with the new range on switch", async () => {
    getCostRollupsMock.mockResolvedValue({ rangeDays: 30 });
    const { result, rerender } = renderHook(({ r }) => useCostRollups(r), {
      initialProps: { r: 30 as 7 | 30 | 90 },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getCostRollupsMock).toHaveBeenLastCalledWith(30);

    getCostRollupsMock.mockResolvedValue({ rangeDays: 90 });
    rerender({ r: 90 });
    await waitFor(() => expect(result.current.rollups).toEqual({ rangeDays: 90 }));
    expect(getCostRollupsMock).toHaveBeenLastCalledWith(90);
  });

  it("keeps the previous range's data on screen while the new one loads", async () => {
    getCostRollupsMock.mockResolvedValue({ rangeDays: 30, marker: "thirty-days" });
    const { result, rerender } = renderHook(({ r }) => useCostRollups(r), {
      initialProps: { r: 30 as 7 | 30 | 90 },
    });
    await waitFor(() => expect(result.current.rollups).toEqual({ rangeDays: 30, marker: "thirty-days" }));
    expect(result.current.stale).toBe(false);

    // Hold the 90d fetch in flight and inspect the intermediate state. The
    // rollups must survive (so the dashboard doesn't collapse to a
    // full-page spinner), and `stale` must flag them as belonging to the
    // old range — otherwise 30-day numbers read as 90-day numbers.
    let settle: (v: unknown) => void = () => {};
    getCostRollupsMock.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    rerender({ r: 90 });

    expect(result.current.loading).toBe(true);
    expect(result.current.stale).toBe(true);
    expect(result.current.rollups).toEqual({ rangeDays: 30, marker: "thirty-days" });

    settle({ rangeDays: 90 });
    await waitFor(() => expect(result.current.rollups).toEqual({ rangeDays: 90 }));
    expect(result.current.stale).toBe(false);
  });

  it("does not let a stale in-flight range resolve over the newer one", async () => {
    let settle7: (v: unknown) => void = () => {};
    getCostRollupsMock.mockReturnValueOnce(new Promise(resolve => { settle7 = resolve; }));
    const { result, rerender } = renderHook(({ r }) => useCostRollups(r), {
      initialProps: { r: 7 as 7 | 30 | 90 },
    });

    getCostRollupsMock.mockResolvedValue({ rangeDays: 30 });
    rerender({ r: 30 });
    await waitFor(() => expect(result.current.rollups).toEqual({ rangeDays: 30 }));

    // The abandoned 7d request lands late; it must not overwrite 30d.
    settle7({ rangeDays: 7 });
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.rollups).toEqual({ rangeDays: 30 });
  });
});
