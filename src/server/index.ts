// Hono 服务端入口：替代原 Next standalone server.js（换运行时的收益见 bench/RESULTS.md §10）。
// 中间件顺序即语义：压缩 → 全局安全头 → /api 会话验签 → route handler → 静态协商缓存 → 静态导出 → 404。
// 压缩在最外层：它的「包 body」动作必须看到内层写好的 Content-Type/ETag（compress 会把强 ETag 降为弱）。
// strict:false —— 尾斜杠与无斜杠等价命中（Next trailingSlash:false 会 308 归一到同一页；
// 不关的话 `/api/cli/` 会从「308→200」退化成硬 404）
// 内存：NODE_OPTIONS（heap/semi-space 上限）、--optimize-for-size、jemalloc 与之前完全一致
// （Dockerfile runner 阶段），GC 归还调度由 instrumentation.node 提供。
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { registerNode } from "@/instrumentation.node";
import { compressResponse } from "./compress";
import { registerRoutes } from "./routes.generated";
import { securityHeaders } from "./security-headers";
import { STATIC_ROOT, notFound, resolveExportPath } from "./static";
import { staticCache } from "./static-cache";
import { verifySession } from "./verify-session";

const app = new Hono({ strict: false });

app.use("*", compressResponse);
app.use("*", securityHeaders);
app.use("/api/*", verifySession);
registerRoutes(app);
app.use("*", staticCache);
app.use("*", serveStatic({ root: STATIC_ROOT, rewriteRequestPath: (path) => resolveExportPath(path) }));
app.notFound(notFound);

const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOSTNAME || "0.0.0.0";

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[server] listening on http://${hostname}:${info.port}`);
});

// 优雅关闭：docker stop / tsx watch 重启发 SIGTERM，先停接收、让在途请求
//（SSE 透传、用量写库）收尾，3s 兜底强退（未处理的长连接靠它不会挂住 stop）
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// 周期性 RSS 归还（30s 扫描 + 超阈值 full GC）；仅 production 生效，依赖 --expose-gc
registerNode();
