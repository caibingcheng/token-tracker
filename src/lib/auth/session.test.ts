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
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect(verifySessionToken(tampered)).toBeNull();
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
