import { describe, it, expect } from "vitest";
import { localeFromOffsetMinutes } from "./locale";

// getTimezoneOffset 语义：UTC - 本地（分钟），UTC+8 → -480
describe("localeFromOffsetMinutes", () => {
  it("UTC+8 用中文", () => {
    expect(localeFromOffsetMinutes(-480)).toBe("zh");
  });

  it("其他时区用英文", () => {
    for (const offset of [0, 60, -300, -540, 480, -330]) {
      expect(localeFromOffsetMinutes(offset)).toBe("en");
    }
  });
});
