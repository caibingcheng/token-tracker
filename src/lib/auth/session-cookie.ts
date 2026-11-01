// 会话 token 的 httpOnly Cookie 形态（浏览器登录态持久化；脚本仍走 X-API-Key header）。
// 纯字符串函数，Edge middleware 与 node route handler 通用（不依赖 node:crypto / DB）。
// 会话 token 本身 = session.ts 签发的 HMAC token，cookie 只是载体，JS 不可读。

export const SESSION_COOKIE_NAME = "tt_session";

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

// Secure 仅在 https 或 loopback 时加：localhost/127.0.0.1 属浏览器安全上下文，接受 Secure cookie；
// 纯 http + LAN IP 部署若强设 Secure 会被浏览器拒收 → 登录死循环，此时退化为仅 HttpOnly + SameSite
export function shouldSecureCookie(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return url.protocol === "https:" || isLoopbackHost(url.hostname);
  } catch {
    return true; // URL 解析失败按安全侧处理
  }
}

// token 为 base64url(payload) + "." + base64url(sig)：字符集在 cookie-octet 允许范围内，无需编码
export function buildSessionCookie(
  token: string,
  ttlMs: number,
  secure: boolean
): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${Math.max(1, Math.floor(ttlMs / 1000))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// 过期清除：Max-Age=0 让浏览器立即丢弃（登出 / 401 时下发）
export function buildClearSessionCookie(secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// 读取 cookie 中的会话 token；header（X-API-Key）存在时调用方应优先 header
export function readSessionCookie(cookies: {
  get(name: string): { value: string } | undefined;
}): string | null {
  return cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}
