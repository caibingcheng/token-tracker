import { describe, it, expect, afterEach } from "vitest";
import {
  isTrustedProxy,
  resolveClientIp,
  getRateLimitKey,
  getXForwardedForRaw,
  isLoopbackAddress,
  getPeerAddress,
} from "@/lib/net/client-ip";

const ORIG = process.env.TRUSTED_PROXY;

afterEach(() => {
  if (ORIG === undefined) delete process.env.TRUSTED_PROXY;
  else process.env.TRUSTED_PROXY = ORIG;
});

function makeRequest(headers: Record<string, string>): Request {
  return new Request("https://example.com", { headers });
}

describe("isTrustedProxy", () => {
  it("defaults to false (fail-closed)", () => {
    delete process.env.TRUSTED_PROXY;
    expect(isTrustedProxy()).toBe(false);
  });

  it("accepts true/1", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(isTrustedProxy()).toBe(true);
    process.env.TRUSTED_PROXY = "1";
    expect(isTrustedProxy()).toBe(true);
  });

  it("rejects other values", () => {
    process.env.TRUSTED_PROXY = "yes";
    expect(isTrustedProxy()).toBe(false);
  });
});

describe("resolveClientIp", () => {
  it("ignores x-forwarded-for when untrusted", () => {
    delete process.env.TRUSTED_PROXY;
    expect(
      resolveClientIp(makeRequest({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))
    ).toBeNull();
  });

  it("trusts x-real-ip when TRUSTED_PROXY=true", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(
      resolveClientIp(makeRequest({ "x-real-ip": "198.51.100.7" }))
    ).toBe("198.51.100.7");
  });

  it("falls back to last x-forwarded-for entry when x-real-ip missing", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(
      resolveClientIp(makeRequest({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))
    ).toBe("10.0.0.1");
  });

  it("ignores client-spoofed x-real-ip when untrusted", () => {
    delete process.env.TRUSTED_PROXY;
    expect(resolveClientIp(makeRequest({ "x-real-ip": "198.51.100.7" }))).toBeNull();
  });

  it("returns null when no headers", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(resolveClientIp(new Request("https://example.com"))).toBeNull();
  });
});

describe("getRateLimitKey", () => {
  it("collapses to global bucket when untrusted (unforgeable)", () => {
    delete process.env.TRUSTED_PROXY;
    const a = getRateLimitKey(makeRequest({ "x-forwarded-for": "1.2.3.4" }));
    const b = getRateLimitKey(makeRequest({ "x-forwarded-for": "5.6.7.8" }));
    expect(a).toBe("global");
    expect(b).toBe("global");
  });

  it("uses real ip when trusted", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(getRateLimitKey(makeRequest({ "x-real-ip": "198.51.100.7" }))).toBe(
      "198.51.100.7"
    );
  });
});

describe("socket 对端地址（内部 header，客户端不可伪造）", () => {
  it("isLoopbackAddress 认 127.x / ::1 / IPv4-mapped 形式", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("[::1]")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:7f00:1")).toBe(true);
    expect(isLoopbackAddress("203.0.113.9")).toBe(false);
    expect(isLoopbackAddress("::ffff:203.0.113.9")).toBe(false);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });

  it("getPeerAddress 只认内部 header", () => {
    expect(getPeerAddress(makeRequest({ "x-internal-remote-addr": "127.0.0.1" }))).toBe("127.0.0.1");
    expect(getPeerAddress(makeRequest({}))).toBeNull();
    // 客户端伪造同名 header 无效（server 层会覆盖/删除；单测无 server 层时至少验证读取口径）
    expect(getPeerAddress(makeRequest({ host: "localhost" }))).toBeNull();
  });

  it("TRUSTED_PROXY=false 时用对端地址做桶（伪造 XFF 不影响）", () => {
    delete process.env.TRUSTED_PROXY;
    const a = getRateLimitKey(
      makeRequest({ "x-internal-remote-addr": "198.51.100.7", "x-forwarded-for": "1.2.3.4" })
    );
    const b = getRateLimitKey(
      makeRequest({ "x-internal-remote-addr": "198.51.100.8", "x-forwarded-for": "1.2.3.4" })
    );
    expect(a).toBe("198.51.100.7");
    expect(b).toBe("198.51.100.8");
    expect(resolveClientIp(makeRequest({ "x-internal-remote-addr": "198.51.100.7" }))).toBe(
      "198.51.100.7"
    );
  });

  it("TRUSTED_PROXY=true 时仍然以反代 header 为准（口径不变）", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(
      getRateLimitKey(
        makeRequest({ "x-internal-remote-addr": "127.0.0.1", "x-real-ip": "198.51.100.7" })
      )
    ).toBe("198.51.100.7");
  });
});

describe("getXForwardedForRaw", () => {
  it("returns full x-forwarded-for value or null", () => {
    expect(
      getXForwardedForRaw(makeRequest({ "x-forwarded-for": "a, b, c" }))
    ).toBe("a, b, c");
    expect(getXForwardedForRaw(new Request("https://example.com"))).toBeNull();
  });
});
