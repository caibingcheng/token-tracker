// 响应压缩（gzip/deflate）：静态导出与 JSON API 都过这一层。
// 迁移前这件事由 Next standalone 的 compression() 中间件兜底（next/dist/server/lib/router-server.js，
// `compress !== false` 即挂载）；换成 Hono 后 serveStatic 只做原样 file stream，不压缩，
// 1.4MB 的 /_next/static JS 会整包直下（实测 gzip 后约 400KB）。
//
// 排除两类路径（不是「压缩不重要」，而是不能压）：
//   - /v1、/v1beta、/raw：SSE 透传（text/event-stream），压缩中间件会把事件包在
//     CompressionStream 里，flush 时机由压缩器决定 → 流式分块可能被攒批；上游自有
//     Content-Encoding 也不该被二次编码。透传保真优先。
//   - 上游已经带 Content-Encoding 的响应：compress 自身会跳过，不必额外判断。
// 另外对 text/event-stream 再兜一层 content-type 过滤：未来 /api 下新增 SSE 路由也不会被压。
import { compress } from "hono/compress";
import type { MiddlewareHandler } from "hono";

const GATEWAY_PREFIX = /^\/(?:v1|v1beta|raw)(?:\/|$)/;

const gzip = compress({
  contentTypeFilter: (type) => !type.toLowerCase().startsWith("text/event-stream"),
});

export const compressResponse: MiddlewareHandler = async (c, next) => {
  if (GATEWAY_PREFIX.test(c.req.path)) return next();
  return gzip(c, next);
};
