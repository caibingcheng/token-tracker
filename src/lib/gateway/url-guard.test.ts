import { describe, it, expect, vi, afterEach } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import {
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateHost,
  privateUpstreamsAllowed,
  validateUpstreamBaseUrl,
  InvalidUpstreamUrlError,
} from "@/lib/gateway/url-guard";

const ORIG_ALLOW = process.env.ALLOW_PRIVATE_UPSTREAMS;

afterEach(() => {
  lookupMock.mockReset();
  if (ORIG_ALLOW === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAMS;
  else process.env.ALLOW_PRIVATE_UPSTREAMS = ORIG_ALLOW;
});

describe("isPrivateIpv4", () => {
  it("rejects loopback/private/link-local/cgnat/multicast ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "127.8.8.8",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "0.0.0.0",
    ]) {
      expect(isPrivateIpv4(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.5", "172.32.0.1", "192.169.0.1"]) {
      expect(isPrivateIpv4(ip), ip).toBe(false);
    }
  });
});

describe("isPrivateIpv6", () => {
  it("rejects ::1, ULA, link-local, multicast and v4-mapped private", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIpv6(ip), ip).toBe(true);
    }
  });

  it("allows public ipv6", () => {
    for (const ip of ["2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateIpv6(ip), ip).toBe(false);
    }
  });
});

describe("isPrivateHost", () => {
  it("classifies literal IPs and leaves domains to DNS", () => {
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("api.openai.com")).toBe(false);
  });
});

describe("validateUpstreamBaseUrl", () => {
  it("rejects non-http(s) and malformed URLs", async () => {
    await expect(validateUpstreamBaseUrl("ftp://x")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    await expect(validateUpstreamBaseUrl("not a url")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    await expect(validateUpstreamBaseUrl("http://")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
  });

  it("rejects private IP literals without DNS lookup", async () => {
    await expect(validateUpstreamBaseUrl("http://127.0.0.1/v1")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    await expect(validateUpstreamBaseUrl("https://10.0.0.5")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    await expect(validateUpstreamBaseUrl("https://169.254.169.254")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("allows public IP literals", async () => {
    await expect(validateUpstreamBaseUrl("https://8.8.8.8/v1")).resolves.toBe(
      "https://8.8.8.8/v1"
    );
  });

  it("rejects domains resolving to private addresses", async () => {
    lookupMock.mockResolvedValue([
      { address: "10.0.0.5", family: 4 },
      { address: "192.168.1.2", family: 4 },
    ]);
    await expect(validateUpstreamBaseUrl("https://internal.example.com")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
  });

  it("rejects domains resolving to link-local metadata addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(validateUpstreamBaseUrl("https://metadata.example.com")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
  });

  it("allows domains resolving to public addresses", async () => {
    lookupMock.mockResolvedValue([
      { address: "104.18.20.21", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ]);
    await expect(validateUpstreamBaseUrl("https://api.example.com/v1")).resolves.toBe(
      "https://api.example.com/v1"
    );
  });

  it("rejects unresolvable domains", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(validateUpstreamBaseUrl("https://nope.invalid")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
  });

  it("ALLOW_PRIVATE_UPSTREAMS=true bypasses address classification", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    expect(privateUpstreamsAllowed()).toBe(true);
    await expect(validateUpstreamBaseUrl("http://127.0.0.1:8000/v1")).resolves.toBe(
      "http://127.0.0.1:8000/v1"
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
