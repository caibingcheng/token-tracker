import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// 上游 baseUrl SSRF 防护：格式校验 + DNS 解析后拒绝环回/私有/链路本地/元数据/组播地址。
// 内网自建 LLM（如 192.168.x.x）场景可设 ALLOW_PRIVATE_UPSTREAMS=true 逃生开关。

export class InvalidUpstreamUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUpstreamUrlError";
  }
}

const PRIVATE_HINT =
  " (baseUrl resolves to a private/loopback/link-local/metadata address; " +
  "set ALLOW_PRIVATE_UPSTREAMS=true to allow internal LLM deployments)";

export function isPrivateIpv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 环回
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 224/4 组播 + 240/4 保留
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 链路本地
  if (lower.startsWith("ff")) return true; // ff00::/8 组播
  if (lower.startsWith("::ffff:")) {
    return isPrivateIpv4(lower.slice("::ffff:".length));
  }
  return false;
}

export function isPrivateHost(host: string): boolean {
  const ipType = isIP(host);
  if (ipType === 4) return isPrivateIpv4(host);
  if (ipType === 6) return isPrivateIpv6(host);
  return false; // 域名需 DNS 解析后判断
}

export function privateUpstreamsAllowed(): boolean {
  const v = process.env.ALLOW_PRIVATE_UPSTREAMS;
  return v === "true" || v === "1";
}

// 校验并返回规范化后的 baseUrl；非法（格式/不可解析/内网地址）时抛出 InvalidUpstreamUrlError
export async function validateUpstreamBaseUrl(baseUrl: string): Promise<string> {
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new InvalidUpstreamUrlError("baseUrl must start with http(s)://");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new InvalidUpstreamUrlError("baseUrl is not a valid URL");
  }
  const hostname = parsed.hostname;
  if (!hostname) {
    throw new InvalidUpstreamUrlError("baseUrl must include a hostname");
  }
  if (privateUpstreamsAllowed()) {
    return baseUrl;
  }
  if (isPrivateHost(hostname)) {
    throw new InvalidUpstreamUrlError("baseUrl must not be a private address" + PRIVATE_HINT);
  }
  if (isIP(hostname) !== 0) {
    // IP 字面量：同步分类已完成（公开地址），无需 DNS
    return baseUrl;
  }
  let addresses: string[];
  try {
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    addresses = resolved.map((r) => r.address);
  } catch {
    throw new InvalidUpstreamUrlError("baseUrl hostname does not resolve");
  }
  if (addresses.length === 0) {
    throw new InvalidUpstreamUrlError("baseUrl hostname does not resolve");
  }
  for (const addr of addresses) {
    const ipType = isIP(addr);
    const blocked =
      ipType === 4 ? isPrivateIpv4(addr) : ipType === 6 ? isPrivateIpv6(addr) : true;
    if (blocked) {
      throw new InvalidUpstreamUrlError("baseUrl must not be a private address" + PRIVATE_HINT);
    }
  }
  return baseUrl;
}

// 校验并返回规范化后的 HTTP(S) 代理 URL（可含 user:pass@ 凭据）。
// 私网拒绝口径与 validateUpstreamBaseUrl 一致，共用 ALLOW_PRIVATE_UPSTREAMS 逃生开关
// （公网代理无需开；Tailscale 100.64/10 等内网代理需开）。
export async function validateProxyUrl(proxyUrl: string): Promise<string> {
  if (!/^https?:\/\//.test(proxyUrl)) {
    throw new InvalidUpstreamUrlError("proxyUrl must start with http:// or https://");
  }
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new InvalidUpstreamUrlError("proxyUrl is not a valid URL");
  }
  const hostname = parsed.hostname;
  if (!hostname) {
    throw new InvalidUpstreamUrlError("proxyUrl must include a hostname");
  }
  if (privateUpstreamsAllowed()) {
    return proxyUrl;
  }
  if (isPrivateHost(hostname)) {
    throw new InvalidUpstreamUrlError(
      "proxyUrl must not be a private address" +
        " (set ALLOW_PRIVATE_UPSTREAMS=true to allow internal proxies)"
    );
  }
  if (isIP(hostname) !== 0) {
    // IP 字面量：同步分类已完成（公开地址），无需 DNS
    return proxyUrl;
  }
  let addresses: string[];
  try {
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    addresses = resolved.map((r) => r.address);
  } catch {
    throw new InvalidUpstreamUrlError("proxyUrl hostname does not resolve");
  }
  if (addresses.length === 0) {
    throw new InvalidUpstreamUrlError("proxyUrl hostname does not resolve");
  }
  for (const addr of addresses) {
    const ipType = isIP(addr);
    const blocked =
      ipType === 4 ? isPrivateIpv4(addr) : ipType === 6 ? isPrivateIpv6(addr) : true;
    if (blocked) {
      throw new InvalidUpstreamUrlError(
        "proxyUrl must not be a private address" +
          " (set ALLOW_PRIVATE_UPSTREAMS=true to allow internal proxies)"
      );
    }
  }
  return proxyUrl;
}

// 脱敏：剥掉 userinfo，返回 scheme://host[:port]（IPv6 保留括号）。永不泄漏凭据。
export function sanitizeProxyUrlForDisplay(proxyUrl: string): string {
  const parsed = new URL(proxyUrl);
  return `${parsed.protocol}//${parsed.host}`;
}
