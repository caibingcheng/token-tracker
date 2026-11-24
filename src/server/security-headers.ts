// 全局安全响应头：逐字复刻原 next.config.js headers()（source: '/:path*'，全响应生效）。
// CSP 的 script-src 用生产口径；dev 页面仍由 next dev + next.config.js dev 分支的 headers()
// 下发（dev 构建是 eval-source-map，需要 'unsafe-eval'，两处口径不同是刻意的）。
import type { MiddlewareHandler } from "hono";

const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Content-Security-Policy", CSP);

  // 静态托管后 Next 不再自动下发缓存头：
  //   - /_next/static/* chunk 内容含 hash → immutable（原 Next 同口径）
  //   - 动态前缀（/api、/v1*、/raw、/ingest）不碰：透传响应可能带上游自己的缓存头
  //   - 其余（HTML 壳 + public 文件）no-cache，升级/换 key 后不拿旧壳打接口。
  //     no-cache 是「必须回源校验」，不是「不缓存」——校验器由 static-cache.ts 提供
  //   （弱 ETag + If-None-Match/If-Modified-Since → 304）；serveStatic 本身只发
  //   Last-Modified、从不返 304，不补那层就是每次整包重下。
  const path = c.req.path;
  if (path.startsWith("/_next/static/")) {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
  } else if (
    !(path.startsWith("/api/") || path.startsWith("/v1") || path.startsWith("/raw/") || path.startsWith("/ingest/"))
  ) {
    c.header("Cache-Control", "no-cache");
  }
};
