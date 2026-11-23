import { describe, it, expect } from "vitest";
import { computeKeyHint, formatMaskedKey } from "./key-hint";

describe("computeKeyHint", () => {
  it("长 key 同时给出前 6 位与末 4 位", () => {
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    expect(computeKeyHint(key)).toEqual({ keyPrefix: "sk-pro", keyLast4: "6789" });
  });

  it("长度边界 24：刚好够就带前缀", () => {
    const key = "a".repeat(20) + "bcd9";
    expect({ len: key.length, hint: computeKeyHint(key) }).toEqual({
      len: 24,
      hint: { keyPrefix: "aaaaaa", keyLast4: "bcd9" },
    });
  });

  it("长度 23：无公开标记时只给末 4 位", () => {
    const key = "k".repeat(19) + "wxyz";
    expect(computeKeyHint(key)).toEqual({ keyPrefix: null, keyLast4: "wxyz" });
  });

  it("中段长度带公开标记 sk-：未知位数够才显示 sk-***末四位", () => {
    const key = "sk-" + "a".repeat(8) + "1234"; // 3+8+4 = 15 → 露 7、未知 8
    expect(key).toHaveLength(15);
    expect(computeKeyHint(key)).toEqual({ keyPrefix: "sk-", keyLast4: "1234" });
    expect(formatMaskedKey(computeKeyHint(key), 9)).toBe("sk-***1234");
  });

  it("12–14 字符的 sk- key 不显示标记：否则 12 位只剩 5 位未知", () => {
    for (const bodyLen of [5, 6, 7]) {
      // 3 + bodyLen + 4 = 12 / 13 / 14，带标记后未知仅 5 / 6 / 7 < 8
      const key = "sk-" + "a".repeat(bodyLen) + "1234";
      expect(computeKeyHint(key)).toEqual({ keyPrefix: null, keyLast4: "1234" });
    }
    expect(formatMaskedKey(computeKeyHint("sk-" + "a".repeat(5) + "1234"), 6)).toBe("***1234");
  });

  it("四位标记（gsk_）同样受限：需剩余未知 ≥ 8 才显示", () => {
    const len15 = "gsk_" + "a".repeat(7) + "1234"; // 4+7+4 = 15 → 带标记未知 7
    const len16 = "gsk_" + "a".repeat(8) + "1234"; // 4+8+4 = 16 → 带标记未知 8
    expect(len15).toHaveLength(15);
    expect(computeKeyHint(len15).keyPrefix).toBeNull();
    expect(computeKeyHint(len16)).toEqual({ keyPrefix: "gsk_", keyLast4: "1234" });
  });

  it("中段长度认 xai- / AIza 两个标记", () => {
    expect(computeKeyHint("xai-" + "a".repeat(8) + "1234").keyPrefix).toBe("xai-"); // 16
    expect(computeKeyHint("AIza" + "a".repeat(8) + "1234").keyPrefix).toBe("AIza"); // 16
  });

  it("白名单外的开头不当作前缀（绝不能取 key 前 N 位）", () => {
    expect(computeKeyHint("abcd-efgh1234")).toEqual({ keyPrefix: null, keyLast4: "1234" });
    expect(formatMaskedKey(computeKeyHint("abcd-efgh1234"), 8)).toBe("***1234");
  });

  it("长度边界 12：无标记时只给末 4 位", () => {
    const key = "abcdefgh" + "1234";
    expect(computeKeyHint(key)).toEqual({ keyPrefix: null, keyLast4: "1234" });
  });

  it("长度 11：一点都不露（空字符串表示已计算）", () => {
    expect(computeKeyHint("shortkey-11")).toEqual({ keyPrefix: null, keyLast4: "" });
  });

  it("极短与空串同样不露", () => {
    expect(computeKeyHint("abc")).toEqual({ keyPrefix: null, keyLast4: "" });
    expect(computeKeyHint("")).toEqual({ keyPrefix: null, keyLast4: "" });
  });

  it("旧实现会露 10/11：新阈值下 11 字符 key 不再露任何字符", () => {
    const key = "0123456789a";
    const hint = computeKeyHint(key);
    expect(formatMaskedKey(hint, 7)).toBe("key #7");
  });
});

describe("formatMaskedKey", () => {
  it("前缀 + 末四位", () => {
    expect(formatMaskedKey({ keyPrefix: "sk-pro", keyLast4: "6789" }, 1)).toBe("sk-pro***6789");
  });

  it("只有末四位", () => {
    expect(formatMaskedKey({ keyPrefix: null, keyLast4: "wxyz" }, 2)).toBe("***wxyz");
  });

  it("没有提示位（太短或未回填）回退到 id", () => {
    expect(formatMaskedKey({ keyPrefix: null, keyLast4: "" }, 3)).toBe("key #3");
    expect(formatMaskedKey({ keyPrefix: null, keyLast4: null }, 4)).toBe("key #4");
    expect(formatMaskedKey(null, 5)).toBe("key #5");
  });
});
