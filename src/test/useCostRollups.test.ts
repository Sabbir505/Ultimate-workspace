import { renderHook, waitFor } from "@testing-library/react";
import { useCostRollups } from "../hooks/useCostRollups";

describe("useCostRollups", () => {
  it("returns loading=false after the IPC resolves", async () => {
    const { result } = renderHook(() => useCostRollups(30));
    // jsdom: getCostRollups is a no-op that returns null. After resolution,
    // loading flips to false.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rollups).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
