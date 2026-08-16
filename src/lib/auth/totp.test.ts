import { describe, it, expect } from "vitest";
import {
  generateTotpSecret,
  generateTotpCode,
  verifyTotpCode,
  base32Encode,
  base32Decode,
  buildOtpAuthUri,
} from "./totp";

const TEST_SECRET = "JBSWY3DPEHPK3PXP";

describe("totp base32", () => {
  it("encodes known bytes to base32", () => {
    // RFC 4648 测试向量: 0x48656c6c6f -> JBSWY3DP
    expect(base32Encode(Buffer.from("Hello", "utf8"))).toBe("JBSWY3DP");
  });

  it("round-trips base32 decode", () => {
    const decoded = base32Decode(TEST_SECRET);
    expect(base32Encode(decoded)).toBe(TEST_SECRET);
  });
});

describe("totp generation (RFC 6238 test vectors)", () => {
  // RFC 6238 Appendix B: secret "12345678901234567890" (base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ)
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const VECTORS: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];

  it("matches RFC 6238 SHA1 vectors", () => {
    for (const [timestamp, expected] of VECTORS) {
      expect(generateTotpCode(SECRET, timestamp * 1000)).toBe(expected);
    }
  });
});

describe("totp verification", () => {
  it("accepts the current code", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = generateTotpCode(secret, now);
    expect(verifyTotpCode(secret, code, now)).toBe(true);
  });

  it("accepts codes within ±1 time window", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const past = generateTotpCode(secret, now - 30_000);
    const future = generateTotpCode(secret, now + 30_000);
    expect(verifyTotpCode(secret, past, now)).toBe(true);
    expect(verifyTotpCode(secret, future, now)).toBe(true);
  });

  it("rejects codes outside the tolerance window", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const stale = generateTotpCode(secret, now - 90_000);
    expect(verifyTotpCode(secret, stale, now)).toBe(false);
  });

  it("rejects malformed codes", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, "12345", Date.now())).toBe(false);
    expect(verifyTotpCode(secret, "abcdef", Date.now())).toBe(false);
    expect(verifyTotpCode(secret, "", Date.now())).toBe(false);
  });

  it("rejects wrong code for the same window", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = generateTotpCode(secret, now);
    const wrong = code === "000000" ? "000001" : "000000";
    expect(verifyTotpCode(secret, wrong, now)).toBe(false);
  });
});

describe("otpauth uri", () => {
  it("builds a valid otpauth URI with secret and params", () => {
    const uri = buildOtpAuthUri(TEST_SECRET, "Token Tracker", "admin");
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain(`secret=${TEST_SECRET}`);
    expect(uri).toContain("issuer=");
    expect(uri).toContain("period=30");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("algorithm=SHA1");
  });
});
