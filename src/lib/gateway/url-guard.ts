import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// 上游 baseUrl SSRF 防护：格式校验 + DNS 解析后拒绝环回/私有/链路本地/元数据/组播地址。
// 内网自建 LLM（如 192.168.x.x）场景可设 ALLOW_PRIVATE_UPSTREAMS=true 逃生开关。
//
// 两层防护：
// 1. 保存/校验时（本文件）：格式 + 解析后地址分类，挡掉明显的私网目标
// 2. 连接时（`outbound-guard.ts`）：自定义 DNS lookup 在真正建连前校验地址，
//    挡住 DNS rebinding（保存时解析到公网、连接时解析到 127.0.0.1）

export class InvalidUpstreamUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUpstreamUrlError";
  }
}

const PRIVATE_HINT =
  " (baseUrl resolves to a private/loopback/link-local/metadata address; " +
  "set ALLOW_PRIVATE_UPSTREAMS=true to allow internal LLM deployments)";

// WHATWG URL 的 hostname 对 IPv6 保留方括号（如 `[::1]`），isIP/isPrivateIpv6 都识别不了，
// 统一去括号后再分类（否则 `http://[::1]/` 会被当成域名去走 DNS 分支）
export function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

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

// 展开 IPv6 为 8 个 16 bit 组；支持 `::` 压缩、尾部点分 IPv4（`::ffff:127.0.0.1`）与 zone id。
// 非法输入返回 null（调用方决定 fail-open 还是 fail-closed）
export function expandIpv6(input: string): number[] | null {
  let s = stripIpv6Brackets(input.trim().toLowerCase());
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (s === "") return null;

  // 尾部点分 IPv4 转成两组十六进制，后续按常规 8 组解析
  const lastColon = s.lastIndexOf(":");
  if (lastColon >= 0) {
    const tail = s.slice(lastColon + 1);
    if (tail.includes(".")) {
      const v4 = tail.split(".");
      if (v4.length !== 4) return null;
      const nums = v4.map((p) => Number(p));
      if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
      const high = ((nums[0]! << 8) | nums[1]!).toString(16);
      const low = ((nums[2]! << 8) | nums[3]!).toString(16);
      s = `${s.slice(0, lastColon + 1)}${high}:${low}`;
    }
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...tail,
  ];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (g === "" ? NaN : parseInt(g, 16)));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

// 从 IPv6 组提取内嵌 IPv4（IPv4-mapped `::ffff:a.b.c.d` / `::ffff:7f00:1`、
// IPv4-compatible `::7f00:1`、NAT64 `64:ff9b::/96`）；无内嵌返回 null
export function extractEmbeddedIpv4(groups: number[]): string | null {
  const high = groups[6]!;
  const low = groups[7]!;
  const v4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
  // ::ffff:0:0/96 IPv4-mapped（第六组 0xffff）
  if (firstFiveZero && groups[5] === 0xffff) return v4;
  // ::/96 IPv4-compatible（已弃用，但仍有解析器接受）
  if (groups.slice(0, 6).every((g) => g === 0)) return v4;
  // 64:ff9b::/96 NAT64
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return v4;
  }
  return null;
}

export function isPrivateIpv6(ip: string): boolean {
  const lower = stripIpv6Brackets(ip.toLowerCase());
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 链路本地
  if (lower.startsWith("ff")) return true; // ff00::/8 组播
  const groups = expandIpv6(lower);
  if (!groups) {
    // 无法解析：v4-mapped 前缀按私网处理（fail-closed），其余交给上层
    return lower.startsWith("::ffff:");
  }
  const embedded = extractEmbeddedIpv4(groups);
  if (embedded) return isPrivateIpv4(embedded);
  return false;
}

export function isPrivateHost(host: string): boolean {
  const normalized = stripIpv6Brackets(host);
  const ipType = isIP(normalized);
  if (ipType === 4) return isPrivateIpv4(normalized);
  if (ipType === 6) return isPrivateIpv6(normalized);
  return false; // 域名需 DNS 解析后判断
}

// 环回主机名（字面 IP 或 localhost 约定名）：允许明文 http 的唯一例外
export function isLoopbackHost(host: string): boolean {
  const normalized = stripIpv6Brackets(host).toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const ipType = isIP(normalized);
  if (ipType === 4) return normalized.startsWith("127.");
  if (ipType === 6) {
    const groups = expandIpv6(normalized);
    if (!groups) return false;
    return groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  }
  return false;
}

// 连接时地址分类：私网/环回/链路本地/元数据/非法地址一律阻断（供 outbound-guard 使用）
export function isBlockedOutboundIp(ip: string): boolean {
  const normalized = stripIpv6Brackets(ip);
  const ipType = isIP(normalized);
  if (ipType === 4) return isPrivateIpv4(normalized);
  if (ipType === 6) return isPrivateIpv6(normalized);
  return true; // 无法识别的地址类型：fail-closed
}

export function privateUpstreamsAllowed(): boolean {
  const v = process.env.ALLOW_PRIVATE_UPSTREAMS;
  return v === "true" || v === "1";
}

// 环回 IP 字面量（127.0.0.0/8、::1）：sync 的 loopback 例外只认这一档与 localhost 名
export function isLoopbackIp(ip: string): boolean {
  const host = stripIpv6Brackets(ip);
  const ipType = isIP(host);
  if (ipType === 4) return host.startsWith("127.");
  if (ipType === 6) {
    const groups = expandIpv6(host);
    return !!groups && groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  }
  return false;
}

// ---- 运行时（真正发请求时）的 URL 安全约束 ----
// 写入侧校验可以被绕过（存量行、env、直接改库），所以统一出站边界必须再校验一次。
// 规则：
// - HTTP / HTTPS 均允许（个人/家庭部署可自选明文或加密传输）
// - 字面 IP 不等 DNS，连接时 lookup 拦不到 → 必须在这里同步分类
// - 例外：ALLOW_PRIVATE_UPSTREAMS=true（内网自建 LLM / 内网代理），
//   以及 sync 的 loopback（本机/容器内联调，仅 loopback，不包含其他私网）
export type OutboundScope = "upstream" | "proxy" | "sync";

export const OUTBOUND_BLOCKED_ADDRESS_MESSAGE =
  "outbound target must not be a private/loopback/link-local/metadata address " +
  "(set ALLOW_PRIVATE_UPSTREAMS=true to allow internal targets)";

// 字面私网/环回/元数据 IP 是否可用：sync 的 loopback 例外 or 全局逃生开关
function blockedAddressAllowedFor(scope: OutboundScope, host: string): boolean {
  if (privateUpstreamsAllowed()) return true;
  return scope === "sync" && isLoopbackHost(host);
}

// 统一出站 URL 校验（运行时）：outboundFetch / getOutboundDispatcher / sync 推送前调用。
// 抛 InvalidUpstreamUrlError（fail-closed，绝不静默放行）。
export function assertOutboundUrlAllowed(rawUrl: string, scope: OutboundScope = "upstream"): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidUpstreamUrlError("outbound URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidUpstreamUrlError("outbound URL must start with http(s)://");
  }
  const host = stripIpv6Brackets(parsed.hostname);
  if (!host) {
    throw new InvalidUpstreamUrlError("outbound URL must include a hostname");
  }
  // 字面 IP：undici 直接建连不走 DNS，连接时 lookup 拦不到，必须在此同步拒绝
  if (isIP(host) !== 0 && isBlockedOutboundIp(host)) {
    if (!blockedAddressAllowedFor(scope, host)) {
      throw new InvalidUpstreamUrlError(OUTBOUND_BLOCKED_ADDRESS_MESSAGE);
    }
  }
}

// 便捷布尔版（sync 配置写入/推送使用，与运行时同一套规则）
export function isOutboundUrlAllowed(rawUrl: string, scope: OutboundScope): boolean {
  try {
    assertOutboundUrlAllowed(rawUrl, scope);
    return true;
  } catch {
    return false;
  }
}

// 校验并返回规范化后的 baseUrl；非法（格式/不可解析/内网地址）时抛错，HTTP/HTTPS 均允许
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
  if (isIP(stripIpv6Brackets(hostname)) !== 0) {
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
    if (isBlockedOutboundIp(addr)) {
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
  if (isIP(stripIpv6Brackets(hostname)) !== 0) {
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
    if (isBlockedOutboundIp(addr)) {
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
