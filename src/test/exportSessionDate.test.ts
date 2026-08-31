// Regression test (audit E-9): export filenames carry the LOCAL date.
// The old `new Date().toISOString().slice(0, 10)` reads UTC — between local
// midnight and UTC midnight the .md filename was stamped with YESTERDAY's
// date. formatLocalDate reads local year/month/day parts instead.
import { describe, expect, it } from "vitest";
import { formatLocalDate } from "../lib/exportSession";

describe("formatLocalDate", () => {
  it("formats zero-padded local year-month-day", () => {
    expect(formatLocalDate(new Date(2026, 0, 5, 13, 45))).toBe("2026-01-05");
    expect(formatLocalDate(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });

  it("uses LOCAL date parts, not UTC (the toISOString failure mode)", () => {
    // Constructed from local components: local 00:30 on Mar 10. In any
    // UTC-… timezone the UTC date is still Mar 9 — exactly the window where
    // toISOString().slice(0, 10) said YESTERDAY. The local formatter must
    // always report Mar 10 regardless of the machine's timezone.
    const localJustAfterMidnight = new Date(2026, 2, 10, 0, 30);
    expect(formatLocalDate(localJustAfterMidnight)).toBe("2026-03-10");
  });
});
