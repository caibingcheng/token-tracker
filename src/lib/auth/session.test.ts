import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  signSessionToken,
  verifySessionToken,
  isTokenExpired,
  shouldRenewToken,
  keyFingerprint,
  getSessionTtlMs,
} from "./session";

const ORIGINAL_SECRET = process.env.GATEWAY_SECRET;
const ORIGINAL_TTL = process.env.SESSION_TOKEN_TTL_HOURS;

beforeEach(() => {
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_TTL === undefined) delete process.env.SESSION_TOKEN_TTL_HOURS;
  else process.env.SESSION_TOKEN_TTL_HOURS = ORIGINAL_TTL;
});

describe("session token", () => {
  it("signs and verifies a token with epoch and keyId", () => {
    const token = signSessionToken(0, "deadbeef");
    const payload = verifySessionToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.epoch).toBe(0);
    expect(payload!.keyId).toBe("deadbeef");
    expect(typeof payload!.exp).toBe("number");
  });

  it("rejects tampered tokens", () => {
    const token = signSessionToken(0, "deadbeef");
    const dot = token.indexOf(".");
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    // 1) 改 payload（签名覆盖的原文）→ HMAC 必然不匹配。
    // 注意不要改签名尾字符：base64url 末位有非有效位，翻转后解码字节可能不变（旧测试的偶发漏判根因）。
    const tamperedPayload = Buffer.from(
      JSON.stringify({ exp: Date.now() + 60_000, epoch: 1, keyId: "deadbeef" })
    ).toString("base64url");
    expect(verifySessionToken(`${tamperedPayload}.${sig}`)).toBeNull();

    // 2) 改签名的**首**字符（首字节全部是有效位，解码后必然不同）
    const flippedFirst = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifySessionToken(`${payload}.${flippedFirst}`)).toBeNull();

    // 3) 签名截断 / 缺失 / 长度不符
    expect(verifySessionToken(`${payload}.${sig.slice(0, -4)}`)).toBeNull();
    expect(verifySessionToken(`${payload}.`)).toBeNull();
    expect(verifySessionToken(`${payload}.${sig}extra`)).toBeNull();
  });

  it("rejects tokens with malformed payload", () => {
    expect(verifySessionToken("not-a-token")).toBeNull();
    expect(verifySessionToken("a.b")).toBeNull();
    expect(verifySessionToken("onlyone")).toBeNull();
  });

  it("rejects tokens signed with a different secret", () => {
    const token = signSessionToken(0, "deadbeef");
    process.env.GATEWAY_SECRET = "ffffffffffffffffffffffffffffffff";
    expect(verifySessionToken(token)).toBeNull();
  });

  it("detects expired tokens", () => {
    const token = signSessionToken(0, "deadbeef", -1000);
    const payload = verifySessionToken(token);
    expect(payload).not.toBeNull();
    expect(isTokenExpired(payload!)).toBe(true);
  });

  it("does not flag fresh tokens as expired", () => {
    const token = signSessionToken(0, "deadbeef");
    const payload = verifySessionToken(token);
    expect(isTokenExpired(payload!)).toBe(false);
  });

  it("renews when remaining validity is below half the TTL", () => {
    const ttl = 10_000;
    const token = signSessionToken(0, "deadbeef", ttl);
    const payload = verifySessionToken(token)!;

    // 剩余 60% -> 不需要续期
    const spy = vi.spyOn(Date, "now").mockReturnValue(payload.exp - ttl * 0.6);
    expect(shouldRenewToken(payload, ttl)).toBe(false);

    // 剩余 30% -> 需要续期
    spy.mockReturnValue(payload.exp - ttl * 0.3);
    expect(shouldRenewToken(payload, ttl)).toBe(true);
    spy.mockRestore();
  });

  it("respects SESSION_TOKEN_TTL_HOURS env", () => {
    process.env.SESSION_TOKEN_TTL_HOURS = "2";
    expect(getSessionTtlMs()).toBe(2 * 60 * 60 * 1000);
    delete process.env.SESSION_TOKEN_TTL_HOURS;
    expect(getSessionTtlMs()).toBe(24 * 60 * 60 * 1000);
  });

  it("signSessionToken 接受显式 ttlMs（settings 解析后传入）", () => {
    const ttl = 2 * 60 * 60 * 1000;
    const token = signSessionToken(0, "deadbeef", ttl);
    const payload = verifySessionToken(token)!;
    // exp 距签发时刻应等于显式 ttl
    expect(payload.exp - Date.now()).toBeGreaterThan(ttl - 5000);
    expect(payload.exp - Date.now()).toBeLessThanOrEqual(ttl);
  });

  it("keyFingerprint differs between keys and is stable per key", () => {
    expect(keyFingerprint("key-a")).not.toBe(keyFingerprint("key-b"));
    expect(keyFingerprint("key-a")).toBe(keyFingerprint("key-a"));
  });

  it("epoch mismatch invalidates previously issued tokens", () => {
    const token = signSessionToken(5, "deadbeef");
    const payload = verifySessionToken(token);
    expect(payload!.epoch).toBe(5);
    // withAuth 会比对 payload.epoch !== currentEpoch 拒绝
    expect(payload!.epoch).not.toBe(6);
  });
});
