// 可信客户端标识解析（限流 / 审计的 IP 来源）。
//
// 部署形态：单进程直出（Hono bundle，无内置反代剥头），客户端可随意伪造
// x-forwarded-for / x-real-ip。默认 TRUSTED_PROXY=false（fail-closed）：
// 忽略全部客户端可控头，用 **socket 对端地址** 做限流桶 —— 对端地址来自内核，
// 不可伪造也不可绕过（服务端在 dispatch/verify-session 把它写进内部 header，
// 见 src/server/client-addr.ts）；取不到对端（next dev / 单测）时退化为全局桶。
// 配置反代并设置 X-Real-IP 后，设 TRUSTED_PROXY=true 可恢复精确 IP 限流。

// 内部 header：由 server 层无条件写入（客户端同名 header 会被覆盖，且不转发 upstream）
export const INTERNAL_REMOTE_ADDR_HEADER = "x-internal-remote-addr";

export function isTrustedProxy(): boolean {
  const v = process.env.TRUSTED_PROXY;
  return v === "true" || v === "1";
}

// socket 对端地址（内部 header 由 server 层写入）；取不到返回 null
export function getPeerAddress(request: Request): string | null {
  const raw = request.headers.get(INTERNAL_REMOTE_ADDR_HEADER);
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

// 对端是否 loopback：127.0.0.0/8、::1 及其 IPv4-mapped 形式。
// IPv4 socket 上报 127.0.0.1，dual-stack 上报 ::ffff:127.0.0.1（或等价的十六进制
// ::ffff:7f00:1），三种都要认，否则本机访问会被误判成远程。
export function isLoopbackAddress(addr: string | null): boolean {
  if (!addr) return false;
  let v = addr.trim().toLowerCase();
  if (v.startsWith("[")) v = v.slice(1, v.indexOf("]"));
  const zone = v.indexOf("%"); // fe80::1%eth0 之类：只看地址主干
  if (zone >= 0) v = v.slice(0, zone);
  if (v === "::1") return true;
  if (v.startsWith("127.")) return true;
  const mappedDotted = v.match(/^::ffff:(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  if (mappedDotted) return Number(mappedDotted[1]) === 127;
  const mappedHex = v.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
  if (mappedHex) return parseInt(mappedHex[1], 16) >> 8 === 127;
  return false;
}

// 可信模式：优先 x-real-ip（反代设置），回退 XFF 最后一项
// （$proxy_add_x_forwarded_for 追加的真实 IP 在末位，客户端伪造项在首项）。
// 未开可信模式：socket 对端地址（不可伪造）；取不到才返回 null（调用方退化为全局桶）。
export function resolveClientIp(request: Request): string | null {
  if (!isTrustedProxy()) return getPeerAddress(request);
  return (
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ||
    null
  );
}

// 限流桶 key：可信 IP / socket 对端地址 / 全局桶（均不可伪造）
export function getRateLimitKey(request: Request): string {
  return resolveClientIp(request) ?? "global";
}

// 审计用：原始 XFF 全文（仅展示，不参与限流）
export function getXForwardedForRaw(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.trim() || null;
}
