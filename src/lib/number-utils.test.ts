import { describe, expect, it } from "vitest";
import { formatLatencyMs } from "./number-utils";

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
