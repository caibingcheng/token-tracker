import { describe, expect, it } from "vitest";
import { formatLatencyMs, parseCompactNumber } from "./number-utils";

describe("parseCompactNumber", () => {
  it("parses plain integers", () => {
    expect(parseCompactNumber("0")).toBe(0);
    expect(parseCompactNumber("2000")).toBe(2000);
    expect(parseCompactNumber("  2000 ")).toBe(2000);
  });

  it("parses suffixed values with or without spaces, case-insensitive", () => {
    expect(parseCompactNumber("2K")).toBe(2000);
    expect(parseCompactNumber("2 K")).toBe(2000);
    expect(parseCompactNumber("2k")).toBe(2000);
    expect(parseCompactNumber("1M")).toBe(1_000_000);
    expect(parseCompactNumber("1 M")).toBe(1_000_000);
    expect(parseCompactNumber("1m")).toBe(1_000_000);
    expect(parseCompactNumber("1.5M")).toBe(1_500_000);
    expect(parseCompactNumber("1B")).toBe(1_000_000_000);
  });

  it("rounds fractional results to an integer", () => {
    expect(parseCompactNumber("0.0006K")).toBe(1);
  });

  it("returns null for invalid input", () => {
    expect(parseCompactNumber("")).toBeNull();
    expect(parseCompactNumber("   ")).toBeNull();
    expect(parseCompactNumber("-1")).toBeNull();
    expect(parseCompactNumber("K")).toBeNull();
    expect(parseCompactNumber("2K3")).toBeNull();
    expect(parseCompactNumber("2KB")).toBeNull();
    expect(parseCompactNumber("1,000")).toBeNull();
    expect(parseCompactNumber("abc")).toBeNull();
    expect(parseCompactNumber("1e3")).toBeNull();
    expect(parseCompactNumber("99999999999999999999T")).toBeNull();
  });
});

describe("formatLatencyMs", () => {
  it("returns rounded ms for values below 1s", () => {
    expect(formatLatencyMs(0)).toBe("0ms");
    expect(formatLatencyMs(1)).toBe("1ms");
    expect(formatLatencyMs(999)).toBe("999ms");
    expect(formatLatencyMs(999.4)).toBe("999ms");
    expect(formatLatencyMs(999.6)).toBe("1000ms");
  });

  it("switches to seconds with 1 decimal for values >= 1s", () => {
    expect(formatLatencyMs(1000)).toBe("1.0s");
    expect(formatLatencyMs(1234)).toBe("1.2s");
    expect(formatLatencyMs(1500)).toBe("1.5s");
    expect(formatLatencyMs(59999)).toBe("60.0s");
  });

  it("returns '-' for null, undefined or non-finite values", () => {
    expect(formatLatencyMs(null)).toBe("-");
    expect(formatLatencyMs(undefined)).toBe("-");
    expect(formatLatencyMs(NaN)).toBe("-");
    expect(formatLatencyMs(Infinity)).toBe("-");
    expect(formatLatencyMs(-Infinity)).toBe("-");
  });
});
