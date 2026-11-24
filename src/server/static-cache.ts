// 静态导出的协商缓存（ETag + 304）。
// 背景：静态文件改由 @hono/node-server 的 serveStatic 托管后，它只下发 Last-Modified，
// 从不返回 304（其实现里没有任何条件请求分支），而页面壳 / public 资源又带
// `Cache-Control: no-cache`（见 security-headers.ts）——没有校验器时 no-cache 退化成
// 「每次都整包重下」。这里在 serveStatic 之前补一层：命中 If-None-Match / If-Modified-Since
// 直接 304，未命中则放行并给 200 补 ETag。
// 校验器用弱 ETag（size + mtime）：compress 中间件会把 ETag 再降成 W/，语义一致。
import type { MiddlewareHandler } from "hono";
import { STATIC_ROOT, resolveExportFile } from "./static";

function isNotModified(
  ifNoneMatch: string | undefined,
  ifModifiedSince: string | undefined,
  etag: string,
  mtimeMs: number
): boolean {
  if (ifNoneMatch !== undefined) {
    // 弱比较：W/ 前缀不参与比较；`*` 表示任意当前表示都命中
    const bare = (tag: string) => tag.trim().replace(/^W\//, "");
    const target = bare(etag);
    return ifNoneMatch.split(",").some((tag) => bare(tag) === "*" || bare(tag) === target);
  }
  if (ifModifiedSince !== undefined) {
    const since = Date.parse(ifModifiedSince);
    // HTTP 日期精度到秒：文件 mtime 截断到秒后再比，否则同秒内修改会误判为已变更
    if (!Number.isNaN(since)) return Math.floor(mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

export function createStaticCache(root: string = STATIC_ROOT): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") return next();
    const found = resolveExportFile(c.req.path, root);
    if (!found) return next();

    const etag = `W/"${found.size.toString(16)}-${Math.floor(found.mtimeMs).toString(16)}"`;
    if (isNotModified(c.req.header("if-none-match"), c.req.header("if-modified-since"), etag, found.mtimeMs)) {
      c.header("ETag", etag);
      c.header("Last-Modified", new Date(found.mtimeMs).toUTCString());
      // 200 路径的 Vary 由 compress 中间件补；304 没有 body，compress 会提前 return，这里自己补，
      // 两侧口径保持一致（否则前置共享缓存会把 304 当成与编码无关）
      c.header("Vary", "Accept-Encoding");
      return c.body(null, 304);
    }

    await next();
    // 200 才补 ETag：serveStatic 未命中会走 notFound（404 壳），Range 命中是 206（各段内容不同，
    // 弱 ETag 会让浏览器把整份表示当成同一份）
    if (c.res.status === 200 && !c.res.headers.has("etag")) c.header("ETag", etag);
  };
}

export const staticCache = createStaticCache();
