import { describe, it, expect } from "vitest";
import {
  localDateKeyFromUtcDate,
  localDateKeyToUtcStartISO,
  offsetMinutesToSqlModifiers,
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
