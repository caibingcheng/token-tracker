// 配对码 / device token 的纯逻辑测试
import { describe, it, expect } from "vitest";
import {
  PAIRING_CODE_CHARSET,
  deviceTokenHash,
  generateDeviceToken,
  generatePairingCode,
  isDeviceTokenShaped,
  normalizePairingCode,
  pairingCodeHash,
  sanitizeDeviceName,
  sha256Hex,
} from "./pairing";

describe("pairing code", () => {
  it("格式为 4-4，字符集排除 0 O I 1", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const body = code.replace("-", "");
      expect(body).toHaveLength(8);
      for (const ch of body) {
        expect(PAIRING_CODE_CHARSET).toContain(ch);
        expect(["0", "O", "I", "1"]).not.toContain(ch);
      }
    }
  });

  it("归一化：去连字符/空格、转大写，长度必须 8", () => {
    expect(normalizePairingCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizePairingCode(" ABCD EFGH ")).toBe("ABCDEFGH");
    expect(normalizePairingCode("ABCD--EFGH")).toBe("ABCDEFGH");
    expect(normalizePairingCode("ABCD-EFG")).toBeNull();
    expect(normalizePairingCode("0123-4567")).toBeNull(); // 含 0/1
    expect(normalizePairingCode("")).toBeNull();
  });

  it("码哈希与归一化一致（带不带连字符同哈希）", () => {
    expect(pairingCodeHash(normalizePairingCode("ABCD-EFGH")!)).toBe(
      pairingCodeHash(normalizePairingCode("abcdefgh")!)
    );
    expect(pairingCodeHash("ABCDEFGH")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("device token", () => {
  it("格式 dt- + 32 base64url，且只存 sha256", () => {
    const token = generateDeviceToken();
    expect(isDeviceTokenShaped(token)).toBe(true);
    expect(token).toMatch(/^dt-[A-Za-z0-9_-]{32}$/);
    expect(deviceTokenHash(token)).toBe(sha256Hex(token));
    expect(deviceTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("畸形 token 不通过形状校验", () => {
    expect(isDeviceTokenShaped("dt-short")).toBe(false);
    expect(isDeviceTokenShaped("sk-" + "a".repeat(32))).toBe(false);
    expect(isDeviceTokenShaped("dt-" + "!".repeat(32))).toBe(false);
  });
});

describe("sanitizeDeviceName", () => {
  it("去控制字符、空值回退、截断 64", () => {
    expect(sanitizeDeviceName("  laptop\u0000\n", "relay")).toBe("laptop");
    expect(sanitizeDeviceName("", "relay")).toBe("relay");
    expect(sanitizeDeviceName(null, "relay")).toBe("relay");
    expect(sanitizeDeviceName("x".repeat(100), "relay")).toHaveLength(64);
  });
});
