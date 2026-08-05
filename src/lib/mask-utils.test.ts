import { describe, expect, it } from "vitest";
import { maskVirtualKey } from "./mask-utils";

describe("maskVirtualKey", () => {
  it("masks long keys with first 6 and last 4 chars visible", () => {
    expect(maskVirtualKey("vk-abcdefghijklmnopqrstuvwxyz1234567890")).toBe(
      "vk-abc***7890"
    );
  });

  it("falls back to short masking for keys <= 10 chars", () => {
    expect(maskVirtualKey("shortkey12")).toBe("sh***");
  });

  it("returns empty string for empty input", () => {
    expect(maskVirtualKey("")).toBe("");
  });
});
