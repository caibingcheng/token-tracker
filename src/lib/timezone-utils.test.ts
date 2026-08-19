import { describe, it, expect } from "vitest";
import {
  localDateKeyFromUtcDate,
  localDateKeyToUtcStartISO,
  offsetMinutesToSqlModifiers,
  computeRangeStartDateKey,
} from "./timezone-utils";

describe("localDateKeyToUtcStartISO", () => {
  it("converts UTC+8 local day start to UTC instant (offset=-480)", () => {
    expect(localDateKeyToUtcStartISO("2026-08-08", -480)).toBe(
      "2026-08-07T16:00:00.000Z"
    );
  });

  it("converts UTC day start as-is (offset=0)", () => {
    expect(localDateKeyToUtcStartISO("2026-08-08", 0)).toBe(
      "2026-08-08T00:00:00.000Z"
    );
  });

  it("converts UTC-5 local day start to UTC instant (offset=300)", () => {
    expect(localDateKeyToUtcStartISO("2026-08-08", 300)).toBe(
      "2026-08-08T05:00:00.000Z"
    );
  });

  it("round-trips with localDateKeyFromUtcDate for any offset", () => {
    for (const offset of [-480, -330, 0, 60, 300, 540]) {
      const utcStart = localDateKeyToUtcStartISO("2026-03-15", offset);
      expect(localDateKeyFromUtcDate(new Date(utcStart), offset)).toBe(
        "2026-03-15"
      );
    }
  });

  it("is monotonic across consecutive days (index-range friendly)", () => {
    const d1 = localDateKeyToUtcStartISO("2026-08-07", -480);
    const d2 = localDateKeyToUtcStartISO("2026-08-08", -480);
    expect(d2 > d1).toBe(true);
  });
});

describe("offsetMinutesToSqlModifiers", () => {
  it("handles whole hours and minutes", () => {
    expect(offsetMinutesToSqlModifiers(-480)).toEqual(["+8 hours"]);
    expect(offsetMinutesToSqlModifiers(330)).toEqual(["-5 hours", "-30 minutes"]);
    expect(offsetMinutesToSqlModifiers(0)).toEqual(["+0 hours"]);
  });
});

describe("computeRangeStartDateKey", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");

  it("returns today-(N-1) for an N-day range", () => {
    expect(computeRangeStartDateKey(7, -480, now)).toBe("2026-08-13");
    expect(computeRangeStartDateKey(3, -480, now)).toBe("2026-08-17");
  });

  it("keeps exactly N days for UTC- time zones (no round-trip drift)", () => {
    // 修复前 UTC- 时区会多偏一天，导致 7d 实际覆盖 9 个本地日期
    expect(computeRangeStartDateKey(7, 300, now)).toBe("2026-08-13");
    expect(computeRangeStartDateKey(3, 300, now)).toBe("2026-08-17");
  });

  it("returns today for a 1-day range", () => {
    expect(computeRangeStartDateKey(1, -480, now)).toBe("2026-08-19");
    expect(computeRangeStartDateKey(1, 300, now)).toBe("2026-08-19");
  });
});
