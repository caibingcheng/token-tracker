// 反代终止 TLS 后到容器/裸进程的原始 socket 恒为明文：@hono/node-server 只按
// `socket.encrypted` 生成 request.url 的 scheme，而迁移前 Next 采信 x-forwarded-proto
// （route-module.js：protocol = xfp.includes("https") ? "https" : "http"）。
// 不校正的话，Caddy/Nginx → 127.0.0.1 明文这条生产推荐拓扑下 shouldSecureCookie(request.url)
// 永远判 http，会话 cookie 静默丢 Secure（安全控制无声失效）。
// 与迁移前逐字等价、无条件采信：客户端直连伪造该头只会拿到浏览器拒收的 Secure cookie（自伤）；
// 生产该头由前置反代覆盖下发。
export function forwardedRequestUrl(raw: Request): string {
  const proto = raw.headers.get("x-forwarded-proto");
  if (!proto || !proto.includes("https")) return raw.url;
  const url = new URL(raw.url);
  if (url.protocol === "https:") return raw.url;
  url.protocol = "https:";
  return url.href;
}
