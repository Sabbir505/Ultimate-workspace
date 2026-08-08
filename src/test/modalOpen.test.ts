// Regression tests for M22: the shared `modalOpen` boolean was stomped by
// competing writers — closing modal A set it false while modal B was still
// open, letting the native webview paint over B. The store now tracks a set
// of open-modal ids and derives the flag.
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../state/ui";

describe("modalOpen id registry (M22)", () => {
  beforeEach(() => {
    useUiStore.setState({ modalOpen: false, openModalIds: [] });
  });

  it("stays true until the LAST modal closes", () => {
    const set = useUiStore.getState().setModalOpen;
    set("a", true);
    set("b", true);
    expect(useUiStore.getState().modalOpen).toBe(true);

    set("a", false);
    // The M22 bug: this went false and the webview painted over modal b.
    expect(useUiStore.getState().modalOpen).toBe(true);
    expect(useUiStore.getState().openModalIds).toEqual(["b"]);

    set("b", false);
    expect(useUiStore.getState().modalOpen).toBe(false);
  });

  it("is idempotent — re-setting the current state is a no-op", () => {
    const set = useUiStore.getState().setModalOpen;
    set("a", true);
    const before = useUiStore.getState().openModalIds;
    set("a", true); // duplicate open
    set("ghost", false); // closing a modal that isn't open
    expect(useUiStore.getState().openModalIds).toBe(before); // identity: no churn
    expect(useUiStore.getState().modalOpen).toBe(true);
  });

  it("duplicate opens collapse to a single entry", () => {
    const set = useUiStore.getState().setModalOpen;
    set("a", true);
    set("a", true);
    set("a", false);
    expect(useUiStore.getState().modalOpen).toBe(false);
    expect(useUiStore.getState().openModalIds).toEqual([]);
  });
});
