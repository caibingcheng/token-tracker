import { describe, it, expect, vi, afterEach } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import {
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateHost,
  isLoopbackHost,
  isBlockedOutboundIp,
  isLoopbackIp,
  assertOutboundUrlAllowed,
  isOutboundUrlAllowed,
  OUTBOUND_BLOCKED_ADDRESS_MESSAGE,
  expandIpv6,
  extractEmbeddedIpv4,
  stripIpv6Brackets,
  privateUpstreamsAllowed,
  validateUpstreamBaseUrl,
  validateProxyUrl,
  sanitizeProxyUrlForDisplay,
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

describe("IPv4-mapped / IPv4-compatible IPv6（十六进制写法的私网识别）", () => {
  it("识别十六进制映射形式 ::ffff:7f00:1 / ::ffff:a00:1", () => {
    expect(isPrivateIpv6("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isPrivateIpv6("::ffff:a00:1")).toBe(true); // 10.0.0.1
    expect(isPrivateIpv6("::ffff:c0a8:101")).toBe(true); // 192.168.1.1
    expect(isPrivateIpv6("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254 元数据
    expect(isPrivateIpv6("::FFFF:7F00:1")).toBe(true); // 大写
  });

  it("识别全展开形式与 zone id", () => {
    expect(isPrivateIpv6("0000:0000:0000:0000:0000:ffff:7f00:0001")).toBe(true);
    expect(isPrivateIpv6("0:0:0:0:0:ffff:a00:1")).toBe(true);
    expect(isPrivateIpv6("fe80::1%eth0")).toBe(true);
  });

  it("识别 IPv4-compatible ::/96 与 NAT64 64:ff9b::/96", () => {
    expect(isPrivateIpv6("::7f00:1")).toBe(true); // ::127.0.0.1
    expect(isPrivateIpv6("64:ff9b::a00:1")).toBe(true); // NAT64 → 10.0.0.1
  });

  it("公网映射地址仍放行", () => {
    expect(isPrivateIpv6("::ffff:808:808")).toBe(false); // 8.8.8.8
    expect(isPrivateIpv6("::ffff:104.18.20.21")).toBe(false);
    expect(isPrivateIpv6("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedOutboundIp("::ffff:808:808")).toBe(false);
    expect(isBlockedOutboundIp("::ffff:7f00:1")).toBe(true);
  });

  it("expandIpv6 / extractEmbeddedIpv4 基础正确性", () => {
    expect(expandIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x1]);
    expect(expandIpv6("not-an-ip")).toBeNull();
    expect(extractEmbeddedIpv4([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x1])).toBe("127.0.0.1");
    expect(extractEmbeddedIpv4([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])).toBeNull();
  });

  it("stripIpv6Brackets 去掉 URL hostname 的方括号", () => {
    expect(stripIpv6Brackets("[::1]")).toBe("::1");
    expect(stripIpv6Brackets("::1")).toBe("::1");
  });

  it("isLoopbackHost 覆盖 localhost / 127.x / ::1", () => {
    for (const host of ["localhost", "LocalHost", "app.localhost", "127.0.0.1", "127.5.5.5", "::1", "[::1]"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["example.com", "10.0.0.1", "::2", "2001:db8::1"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("URL 中带方括号的 IPv6 hostname", () => {
  it("isPrivateHost / validateUpstreamBaseUrl 能识别 [::1]，不当成域名去 DNS", async () => {
    expect(isPrivateHost("[::1]")).toBe(true);
    await expect(validateUpstreamBaseUrl("http://[::1]:8000/v1")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    // 十六进制映射形式同样被拒
    await expect(validateUpstreamBaseUrl("http://[::ffff:7f00:1]:8000/v1")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("validateProxyUrl 同样识别带括号的私网 IPv6", async () => {
    await expect(validateProxyUrl("http://[::1]:1080")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    await expect(validateProxyUrl("http://[::ffff:a00:1]:1080")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe("upstream HTTP/HTTPS 兼容", () => {
  it("公网域名/公网 IP 的 http 允许", async () => {
    lookupMock.mockResolvedValue([{ address: "104.18.20.21", family: 4 }]);
    await expect(validateUpstreamBaseUrl("http://api.openai.com/v1")).resolves.toBe(
      "http://api.openai.com/v1"
    );
    await expect(validateUpstreamBaseUrl("http://8.8.8.8/v1")).resolves.toBe(
      "http://8.8.8.8/v1"
    );
  });

  it("环回地址仍由 SSRF 策略把关（不是被 https 规则拒）", async () => {
    // 未开 ALLOW_PRIVATE_UPSTREAMS 时环回依旧拒绝，但拒绝理由必须是私网地址分类，
    // 而不是 https 规则 —— 否则开逃生开关后内网 http 仍会被 scheme 拦下
    for (const url of ["http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"]) {
      await expect(validateUpstreamBaseUrl(url)).rejects.toThrow(/private address/);
    }
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("逃生开关打开后环回/内网 http 放行（本地/容器内联调）", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    for (const url of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:8000/v1",
      "http://[::1]:8000/v1",
      "http://192.168.1.5:8000/v1",
    ]) {
      await expect(validateUpstreamBaseUrl(url)).resolves.toBe(url);
    }
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("ALLOW_PRIVATE_UPSTREAMS=true 时内网 http 放行（自建 LLM 逃生）", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    await expect(validateUpstreamBaseUrl("http://192.168.1.5:8000/v1")).resolves.toBe(
      "http://192.168.1.5:8000/v1"
    );
    await expect(validateUpstreamBaseUrl("http://internal.corp/v1")).resolves.toBe(
      "http://internal.corp/v1"
    );
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

describe("validateProxyUrl", () => {
  it("rejects non-http(s) schemes and malformed URLs", async () => {
    await expect(validateProxyUrl("socks5://host:1080")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    await expect(validateProxyUrl("ftp://proxy")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    await expect(validateProxyUrl("http://")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    await expect(validateProxyUrl("not a url")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
  });

  it("rejects private IP literals without DNS lookup", async () => {
    await expect(validateProxyUrl("http://127.0.0.1:8080")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    await expect(validateProxyUrl("http://192.168.1.1:3128")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    await expect(validateProxyUrl("http://100.64.0.1:1080")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("allows public IP literal proxies with credentials", async () => {
    await expect(
      validateProxyUrl("https://user:pass@8.8.8.8:3128")
    ).resolves.toBe("https://user:pass@8.8.8.8:3128");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects domains resolving to private addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(validateProxyUrl("http://internal-proxy.example.com:8080")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
  });

  it("allows domains resolving to public addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "104.18.20.21", family: 4 }]);
    await expect(
      validateProxyUrl("https://user:pass@proxy.example.com:3128")
    ).resolves.toBe("https://user:pass@proxy.example.com:3128");
  });

  it("rejects unresolvable domains", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(validateProxyUrl("http://nope.invalid:3128")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
  });

  it("ALLOW_PRIVATE_UPSTREAMS=true bypasses proxy address classification", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    await expect(validateProxyUrl("http://10.0.0.1:1080")).resolves.toBe("http://10.0.0.1:1080");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("公网代理的 http 允许", async () => {
    lookupMock.mockResolvedValue([{ address: "104.18.20.21", family: 4 }]);
    await expect(validateProxyUrl("http://proxy.example.com:3128")).resolves.toBe(
      "http://proxy.example.com:3128"
    );
    await expect(validateProxyUrl("http://8.8.8.8:3128")).resolves.toBe(
      "http://8.8.8.8:3128"
    );
    await expect(
      validateProxyUrl("http://user:pass@proxy.example.com:3128")
    ).resolves.toBe("http://user:pass@proxy.example.com:3128");
  });

  it("环回/私网代理的明文 http 仅在逃生开关下放行", async () => {
    await expect(validateProxyUrl("http://127.0.0.1:8080")).rejects.toBeInstanceOf(
      InvalidUpstreamUrlError
    );
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    await expect(validateProxyUrl("http://127.0.0.1:8080")).resolves.toBe(
      "http://127.0.0.1:8080"
    );
  });
});

describe("sanitizeProxyUrlForDisplay", () => {
  it("strips userinfo and keeps scheme://host[:port]", () => {
    expect(sanitizeProxyUrlForDisplay("https://user:pass@proxy.example.com:3128")).toBe(
      "https://proxy.example.com:3128"
    );
    expect(sanitizeProxyUrlForDisplay("https://proxy.example.com:8080")).toBe(
      "https://proxy.example.com:8080"
    );
  });

  it("keeps IPv6 brackets", () => {
    expect(sanitizeProxyUrlForDisplay("http://user:pass@[2001:db8::1]:1080")).toBe(
      "http://[2001:db8::1]:1080"
    );
  });
});

describe("assertOutboundUrlAllowed（运行时统一出站校验）", () => {
  // 运行时校验挡的是「写入校验管不到的存量配置」：旧行、直接改库、env 覆盖
  it("upstream/proxy/sync 均允许公网 HTTP 与 HTTPS", () => {
    for (const scope of ["upstream", "proxy", "sync"] as const) {
      expect(() => assertOutboundUrlAllowed("http://api.openai.com/v1", scope)).not.toThrow();
      expect(() => assertOutboundUrlAllowed("http://8.8.8.8:8080", scope)).not.toThrow();
      expect(() => assertOutboundUrlAllowed("https://api.openai.com/v1", scope)).not.toThrow();
    }
  });

  it("字面私网/环回/元数据 IP 不依赖 DNS 即可拦截（连接时 lookup 拦不到字面 IP）", () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "[::1]", "[::ffff:7f00:1]"]) {
      expect(() => assertOutboundUrlAllowed(`https://${host}/v1`, "upstream"), host).toThrow(
        OUTBOUND_BLOCKED_ADDRESS_MESSAGE
      );
    }
    // 公网字面 IP + https 放行
    expect(() => assertOutboundUrlAllowed("https://8.8.8.8/v1", "upstream")).not.toThrow();
  });

  it("sync 允许 loopback 明文 http（localhost/127.x/::1），其他私网仍需逃生开关", () => {
    for (const url of [
      "http://localhost:3000/ingest/records",
      "http://127.0.0.1:3000/ingest/records",
      "http://[::1]:3000/ingest/records",
    ]) {
      expect(isOutboundUrlAllowed(url, "sync"), url).toBe(true);
      expect(() => assertOutboundUrlAllowed(url, "sync")).not.toThrow();
    }
    // 非环回私网：http 与 https 都被拒（不允许为 sync 全面放开私网）
    expect(isOutboundUrlAllowed("http://192.168.1.10:3000/ingest/records", "sync")).toBe(false);
    expect(isOutboundUrlAllowed("https://192.168.1.10:3000/ingest/records", "sync")).toBe(false);
    expect(isOutboundUrlAllowed("https://tracker.example.com/ingest/records", "sync")).toBe(true);
    expect(isOutboundUrlAllowed("http://tracker.example.com/ingest/records", "sync")).toBe(true);
    // upstream/proxy 不吃 loopback 字面 IP 例外
    expect(isOutboundUrlAllowed("http://127.0.0.1:3000/v1", "upstream")).toBe(false);
  });

  it("ALLOW_PRIVATE_UPSTREAMS=true 时内网明文与私网地址放行（统一逃生开关）", () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    for (const [url, scope] of [
      ["http://192.168.1.5:8000/v1", "upstream"],
      ["http://10.0.0.9:3128", "proxy"],
      ["http://192.168.1.10:3000/ingest/records", "sync"],
    ] as const) {
      expect(() => assertOutboundUrlAllowed(url, scope), url).not.toThrow();
    }
  });

  it("非法 scheme / 不可解析 URL 拒绝", () => {
    expect(() => assertOutboundUrlAllowed("ftp://x", "upstream")).toThrow(/http/);
    expect(() => assertOutboundUrlAllowed("not a url", "upstream")).toThrow(/valid URL/);
  });

  it("isLoopbackIp 精确识别 127/8 与 ::1", () => {
    for (const ip of ["127.0.0.1", "127.9.9.9", "::1", "[::1]"]) {
      expect(isLoopbackIp(ip), ip).toBe(true);
    }
    for (const ip of ["10.0.0.1", "192.168.1.1", "::2", "::ffff:7f00:1", "8.8.8.8"]) {
      expect(isLoopbackIp(ip), ip).toBe(false);
    }
  });
});
