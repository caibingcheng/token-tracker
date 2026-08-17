import { describe, it, expect } from "vitest";
import { getProxyDispatcher } from "@/lib/gateway/proxy-dispatcher";
import { ProxyAgent } from "undici";

describe("getProxyDispatcher", () => {
  it("returns undefined for null/empty proxyUrl", () => {
    expect(getProxyDispatcher(null)).toBeUndefined();
    expect(getProxyDispatcher(undefined)).toBeUndefined();
    expect(getProxyDispatcher("")).toBeUndefined();
    expect(getProxyDispatcher("   ")).toBeUndefined();
  });

  it("returns the same instance for the same URL (cache)", () => {
    const a = getProxyDispatcher("http://proxy.example.com:3128");
    const b = getProxyDispatcher("http://proxy.example.com:3128");
    expect(a).toBeInstanceOf(ProxyAgent);
    expect(a).toBe(b);
  });

  it("returns distinct instances for distinct URLs", () => {
    const a = getProxyDispatcher("http://proxy-a.example.com:3128");
    const b = getProxyDispatcher("http://proxy-b.example.com:3128");
    expect(a).not.toBe(b);
  });

  it("treats URLs differing in credentials as distinct keys", () => {
    const a = getProxyDispatcher("http://user1:pass1@proxy.example.com:3128");
    const b = getProxyDispatcher("http://user2:pass2@proxy.example.com:3128");
    expect(a).not.toBe(b);
  });

  it("rebuilds cache after exceeding the 50-entry cap", () => {
    const first = getProxyDispatcher("http://cap-check.example.com:1");
    for (let i = 0; i < 55; i++) {
      getProxyDispatcher(`http://bulk-${i}.example.com:${1000 + i}`);
    }
    const after = getProxyDispatcher("http://cap-check.example.com:1");
    expect(after).toBeInstanceOf(ProxyAgent);
    expect(after).not.toBe(first);
  });
});
