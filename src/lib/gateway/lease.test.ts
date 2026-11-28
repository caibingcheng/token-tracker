// lease 封装单测：往返、AAD 篡改、错密钥、过期判定。
import { describe, it, expect } from "vitest";
import {
  LEASE_CLOCK_SKEW_MS,
  generateDeviceKeypair,
  isLeaseExpired,
  openLease,
  sealLease,
  type LeasePayload,
} from "./lease";

function payloadOf(over: Partial<LeasePayload> = {}): LeasePayload {
  return {
    v: 1,
    planId: "plan-abc",
    upstreamId: 3,
    keyId: 22,
    apiKey: "sk-real-upstream-key",
    protocol: "openai",
    url: "https://api.example.com/v1/chat/completions",
    proxyUrl: null,
    headers: { "x-sess": "abc" },
    requiresPrivateNetwork: false,
    expiresAt: 1764000060000,
    ...over,
  };
}

describe("lease seal/open", () => {
  it("往返：seal → open 得到同一 payload", () => {
    const device = generateDeviceKeypair();
    const payload = payloadOf();
    const wire = sealLease(payload, device.publicKey);
    expect(wire.startsWith("v1.")).toBe(true);
    expect(wire.split(".")).toHaveLength(5);
    const opened = openLease(wire, device.privateKeyPem, {
      planId: payload.planId,
      upstreamId: payload.upstreamId,
      keyId: payload.keyId,
    });
    expect(opened).toEqual(payload);
  });

  it("每次 seal 的临时公钥不同（不复用 eph 密钥对）", () => {
    const device = generateDeviceKeypair();
    const a = sealLease(payloadOf(), device.publicKey).split(".")[1];
    const b = sealLease(payloadOf(), device.publicKey).split(".")[1];
    expect(a).not.toBe(b);
  });

  it("AAD 绑定：换 planId / upstreamId / keyId 任一都解不开", () => {
    const device = generateDeviceKeypair();
    const wire = sealLease(payloadOf(), device.publicKey);
    for (const expected of [
      { planId: "plan-other", upstreamId: 3, keyId: 22 },
      { planId: "plan-abc", upstreamId: 4, keyId: 22 },
      { planId: "plan-abc", upstreamId: 3, keyId: 23 },
    ]) {
      expect(openLease(wire, device.privateKeyPem, expected)).toBeNull();
    }
  });

  it("错私钥 / 坏 wire / 非 v1 前缀一律 null（fail-closed）", () => {
    const device = generateDeviceKeypair();
    const other = generateDeviceKeypair();
    const wire = sealLease(payloadOf(), device.publicKey);
    const expected = { planId: "plan-abc", upstreamId: 3, keyId: 22 };
    expect(openLease(wire, other.privateKeyPem, expected)).toBeNull();
    expect(openLease("garbage", device.privateKeyPem, expected)).toBeNull();
    expect(openLease(`v2.${wire.split(".").slice(1).join(".")}`, device.privateKeyPem, expected)).toBeNull();
    const flipped = wire.split(".");
    flipped[4] = (flipped[4] ?? "").slice(0, -2) + "AA";
    expect(openLease(flipped.join("."), device.privateKeyPem, expected)).toBeNull();
  });

  it("过期判定允许 ±120s 时钟漂移", () => {
    const payload = payloadOf({ expiresAt: 1_000_000 });
    expect(isLeaseExpired(payload, 1_000_000)).toBe(false);
    expect(isLeaseExpired(payload, 1_000_000 + LEASE_CLOCK_SKEW_MS)).toBe(false);
    expect(isLeaseExpired(payload, 1_000_000 + LEASE_CLOCK_SKEW_MS + 1)).toBe(true);
  });
});
