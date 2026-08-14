// Toast store: the global error surface. Covers push/dismiss, the stack cap
// (a failing poll loop must not accumulate unbounded toasts), and auto-dismiss
// TTLs (errors linger longer than successes).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../state/ui";

describe("toast store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushToast appends and dismissToast removes", () => {
    useUiStore.getState().pushToast("error", "git push failed", "remote rejected");
    useUiStore.getState().pushToast("success", "Committed abc123");
    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toMatchObject({ kind: "error", message: "git push failed", detail: "remote rejected" });
    useUiStore.getState().dismissToast(toasts[0].id);
    expect(useUiStore.getState().toasts).toHaveLength(1);
  });

  it("auto-dismisses after the kind's TTL (errors linger longest)", () => {
    useUiStore.getState().pushToast("success", "done");
    useUiStore.getState().pushToast("error", "broke");
    vi.advanceTimersByTime(4500); // success TTL is 4000
    let toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("error");
    vi.advanceTimersByTime(5000); // error TTL is 9000
    toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(0);
  });

  it("caps the stack at 5 entries", () => {
    for (let i = 0; i < 8; i++) useUiStore.getState().pushToast("info", `n${i}`);
    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(5);
    // Oldest dropped first — the newest message must survive.
    expect(toasts[toasts.length - 1].message).toBe("n7");
  });
});
