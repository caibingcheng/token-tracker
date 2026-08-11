// 可信客户端标识解析（限流 / 审计的 IP 来源）。
//
// 部署形态：next standalone 直出（无反代内置剥头），客户端可随意伪造
// x-forwarded-for / x-real-ip。默认 TRUSTED_PROXY=false（fail-closed）：
// 忽略全部客户端可控头，限流退化为全局桶 —— 不可伪造、不可绕过的唯一保证
// （代价：同一窗口内所有人的失败次数共享，攻击者可阻塞登录 15 分钟，但无法爆破）。
// 配置反代并设置 X-Real-IP 后，设 TRUSTED_PROXY=true 可恢复精确 IP 限流。
export function isTrustedProxy(): boolean {
  const v = process.env.TRUSTED_PROXY;
  return v === "true" || v === "1";
}

// 可信模式：优先 x-real-ip（反代设置），回退 XFF 最后一项
// （$proxy_add_x_forwarded_for 追加的真实 IP 在末位，客户端伪造项在首项）。
export function resolveClientIp(request: Request): string | null {
  if (!isTrustedProxy()) return null;
  return (
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ||
    null
  );
}

// 限流桶 key：可信 IP 或全局桶（不可伪造）
export function getRateLimitKey(request: Request): string {
  return resolveClientIp(request) ?? "global";
}

// 审计用：原始 XFF 全文（仅展示，不参与限流）
export function getXForwardedForRaw(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.trim() || null;
}
