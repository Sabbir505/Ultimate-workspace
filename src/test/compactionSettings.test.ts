import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_COMPACTION_THRESHOLD,
  DEFAULT_LOCAL_PIN_EXCHANGES,
  useSettingsStore,
} from "../state/settings";

// The compaction defaults are tunable knobs the Rust loader
// (src-tauri/src/chat/compaction.rs) and this store must agree on; pinning them
// here catches a silent drift in either direction (e.g. someone bumps the Rust
// default without updating the UI default).

describe("local compaction settings — defaults", () => {
  it("ships the documented threshold (0.75) and pin (6 exchanges)", () => {
    expect(DEFAULT_LOCAL_COMPACTION_THRESHOLD).toBe(0.75);
    expect(DEFAULT_LOCAL_PIN_EXCHANGES).toBe(6);
  });

  it("seeds the store with those defaults before load()", () => {
    expect(useSettingsStore.getState().localCompactionThreshold).toBe(
      DEFAULT_LOCAL_COMPACTION_THRESHOLD,
    );
    expect(useSettingsStore.getState().localPinExchanges).toBe(
      DEFAULT_LOCAL_PIN_EXCHANGES,
    );
  });
});

describe("local compaction settings — setter clamping", () => {
  beforeEach(() => {
    // Reset to defaults between cases so clamping assertions are independent.
    useSettingsStore.setState({
      localCompactionThreshold: DEFAULT_LOCAL_COMPACTION_THRESHOLD,
      localPinExchanges: DEFAULT_LOCAL_PIN_EXCHANGES,
    });
  });

  it("accepts an in-band threshold", () => {
    useSettingsStore.getState().setLocalCompactionThreshold(0.8);
    expect(useSettingsStore.getState().localCompactionThreshold).toBe(0.8);
  });

  it("rejects an out-of-band threshold (keeps the prior value)", () => {
    useSettingsStore.getState().setLocalCompactionThreshold(0.8);
    useSettingsStore.getState().setLocalCompactionThreshold(1.5); // > 0.99
    expect(useSettingsStore.getState().localCompactionThreshold).toBe(0.8);
    useSettingsStore.getState().setLocalCompactionThreshold(0.1); // < 0.25
    expect(useSettingsStore.getState().localCompactionThreshold).toBe(0.8);
    useSettingsStore.getState().setLocalCompactionThreshold(Number.NaN);
    expect(useSettingsStore.getState().localCompactionThreshold).toBe(0.8);
  });

  it("accepts an in-band pin count", () => {
    useSettingsStore.getState().setLocalPinExchanges(4);
    expect(useSettingsStore.getState().localPinExchanges).toBe(4);
  });

  it("rejects an out-of-band pin count (keeps the prior value)", () => {
    useSettingsStore.getState().setLocalPinExchanges(4);
    useSettingsStore.getState().setLocalPinExchanges(0); // < 1
    expect(useSettingsStore.getState().localPinExchanges).toBe(4);
    useSettingsStore.getState().setLocalPinExchanges(999); // > 50
    expect(useSettingsStore.getState().localPinExchanges).toBe(4);
  });
});
