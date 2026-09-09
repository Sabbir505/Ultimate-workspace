import { describe, expect, it } from "vitest";
import { formatBytes, formatDate, formatDateTime, formatDuration, formatRate, shortName } from "../lib/format";

describe("formatBytes", () => {
  it("formats each unit tier", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 12)).toBe("12 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("stops at the largest unit", () => {
    expect(formatBytes(3 * 1024 ** 4)).toBe("3.0 TB");
    expect(formatBytes(5 * 1024 ** 5)).toBe("5120 TB");
  });

  it("renders the placeholder for non-positive or non-finite input", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(-4)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(0, "0 B")).toBe("0 B");
  });
});

describe("formatRate", () => {
  it("appends /s and stays empty while idle", () => {
    expect(formatRate(2048)).toBe("2.0 KB/s");
    expect(formatRate(0)).toBe("");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatDuration(0.5)).toBe("1s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(133)).toBe("2m 13s");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(3660)).toBe("1h 1m");
  });
});

describe("formatDate", () => {
  it("accepts ISO strings and epoch seconds, blanking bad input", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate("not a date")).toBe("");
    expect(formatDate("2026-09-07T12:00:00Z")).toMatch(/Sep 7, 2026/);
    const sep7 = Math.floor(new Date("2026-09-07T12:00:00Z").getTime() / 1000);
    expect(formatDate(sep7)).toMatch(/Sep 7, 2026/);
  });
});

describe("formatDateTime", () => {
  it("renders month/day + time from epoch seconds", () => {
    const sep7 = Math.floor(new Date("2026-09-07T14:31:00").getTime() / 1000);
    expect(formatDateTime(sep7)).toMatch(/Sep 7/);
    expect(formatDateTime(sep7)).toMatch(/2:31/);
    expect(formatDateTime(0)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
  });
});

describe("shortName", () => {
  it("keeps short paths and truncates long ones to two segments", () => {
    expect(shortName("C:\\models\\q4.bin")).toBe("C:\\models\\q4.bin");
    const long = ["C:", "models", "whisper", "ggml", "large-v3-turbo-q5", "ggml-large-v3-turbo-q5_0.bin"].join("\\");
    expect(shortName(long)).toBe("…/large-v3-turbo-q5/ggml-large-v3-turbo-q5_0.bin");
  });
});
