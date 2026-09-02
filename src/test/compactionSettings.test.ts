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

describe("cloud context-limit override", () => {
  it("defaults to 0 (auto — the model's own window)", () => {
    expect(useSettingsStore.getState().cloudContextLimit).toBe(0);
  });

  it("accepts a positive token cap and rejects negatives", () => {
    useSettingsStore.getState().setCloudContextLimit(200_000);
    expect(useSettingsStore.getState().cloudContextLimit).toBe(200_000);
    useSettingsStore.getState().setCloudContextLimit(-5);
    expect(useSettingsStore.getState().cloudContextLimit).toBe(200_000);
    useSettingsStore.getState().setCloudContextLimit(0);
    expect(useSettingsStore.getState().cloudContextLimit).toBe(0);
  });
});

describe("local compaction quality knobs (P4) — defaults", () => {
  it("ships sidecar summarizer with rebuild-from-raw on", () => {
    expect(useSettingsStore.getState().localCompactionSummarizer).toBe("sidecar");
    expect(useSettingsStore.getState().localCompactionRebuildFromRaw).toBe(true);
  });

  it("toggles both knobs", () => {
    useSettingsStore.getState().setLocalCompactionSummarizer("cloud");
    useSettingsStore.getState().setLocalCompactionRebuildFromRaw(false);
    expect(useSettingsStore.getState().localCompactionSummarizer).toBe("cloud");
    expect(useSettingsStore.getState().localCompactionRebuildFromRaw).toBe(false);
    useSettingsStore.getState().setLocalCompactionSummarizer("sidecar");
    useSettingsStore.getState().setLocalCompactionRebuildFromRaw(true);
    expect(useSettingsStore.getState().localCompactionSummarizer).toBe("sidecar");
    expect(useSettingsStore.getState().localCompactionRebuildFromRaw).toBe(true);
  });
});

describe("cloud compaction settings — defaults", () => {
  it("ships enabled with the documented threshold (0.75) and pin (6 exchanges)", () => {
    expect(useSettingsStore.getState().cloudCompactionEnabled).toBe(true);
    expect(useSettingsStore.getState().cloudCompactionThreshold).toBe(0.75);
    expect(useSettingsStore.getState().cloudPinExchanges).toBe(6);
  });
});

describe("cloud compaction settings — setter clamping", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      cloudCompactionEnabled: true,
      cloudCompactionThreshold: 0.75,
      cloudPinExchanges: 6,
    });
  });

  it("toggles the master switch", () => {
    useSettingsStore.getState().setCloudCompactionEnabled(false);
    expect(useSettingsStore.getState().cloudCompactionEnabled).toBe(false);
    useSettingsStore.getState().setCloudCompactionEnabled(true);
    expect(useSettingsStore.getState().cloudCompactionEnabled).toBe(true);
  });

  it("accepts an in-band threshold and rejects out-of-band", () => {
    useSettingsStore.getState().setCloudCompactionThreshold(0.6);
    expect(useSettingsStore.getState().cloudCompactionThreshold).toBe(0.6);
    useSettingsStore.getState().setCloudCompactionThreshold(1.2); // > 0.99
    expect(useSettingsStore.getState().cloudCompactionThreshold).toBe(0.6);
    useSettingsStore.getState().setCloudCompactionThreshold(0.1); // < 0.25
    expect(useSettingsStore.getState().cloudCompactionThreshold).toBe(0.6);
  });

  it("accepts an in-band pin count and rejects out-of-band", () => {
    useSettingsStore.getState().setCloudPinExchanges(3);
    expect(useSettingsStore.getState().cloudPinExchanges).toBe(3);
    useSettingsStore.getState().setCloudPinExchanges(0); // < 1
    expect(useSettingsStore.getState().cloudPinExchanges).toBe(3);
    useSettingsStore.getState().setCloudPinExchanges(51); // > 50
    expect(useSettingsStore.getState().cloudPinExchanges).toBe(3);
  });
});
