// Vault asset|note split-divider clamp: the persisted 20–80% bounds plus the
// live px floors (state/vault.ts) that keep a hard drag from entering the
// container's clip zone. See vault.css .vault-asset-pane and the note floors.
import { describe, expect, it } from "vitest";
import { clampAssetSplitPct } from "../state/vault";

// Note min: head 40 + live pane 260 (the wider of editor/reading) + divider 6.
const NOTE_MIN = 306;

describe("clampAssetSplitPct", () => {
  it("keeps values inside the persisted 20–80 bounds", () => {
    expect(clampAssetSplitPct(50, 2000, 200)).toBe(50);
  });

  it("tightens the 80% bound when it would crush the note side", () => {
    // 1200px center: the note side's floor caps the asset at 100 - 306/1200.
    expect(clampAssetSplitPct(95, 1200, 200)).toBeCloseTo(100 - (NOTE_MIN / 1200) * 100, 5);
  });

  it("stops before crushing the note side below its floors", () => {
    expect(clampAssetSplitPct(99, 1200, 200)).toBeCloseTo(100 - (NOTE_MIN / 1200) * 100, 5);
    // Same demand on a smaller center — the floor share grows as the center
    // shrinks, so the effective max drops.
    expect(clampAssetSplitPct(99, 1000, 200)).toBeCloseTo(100 - (NOTE_MIN / 1000) * 100, 5);
  });

  it("respects the asset's own floor (pdf 380 / generic 200)", () => {
    expect(clampAssetSplitPct(1, 1200, 380)).toBeCloseTo((380 / 1200) * 100, 5);
    // Generic asset floor 200/1200 = 16.7% sits BELOW the persisted 20% min,
    // which must not be loosened — 20 wins.
    expect(clampAssetSplitPct(1, 1200, 200)).toBe(20);
  });
});
