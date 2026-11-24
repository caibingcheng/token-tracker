// Next route handler 签名 → Hono handler 的适配。
// handler(request: NextRequest, ctx: { params }) 原样保留；这里只负责三件事：
//   1. 把 Hono 的 c.req.raw 包成 shim 的 NextRequest（cookies/nextUrl 等视图可用）
//   2. 组装 ctx.params（Next 15+ 是 Promise；通配段 [...path] 是 segment 数组，Hono 给的是字符串）
//   3. body 透传：网关链路依赖 request.body 流式读取（见 lib/gateway/proxy.ts），必须走 stream + duplex
import type { Context } from "hono";
import { forwardedRequestUrl } from "./forwarded";
import { applyPeerAddressHeader } from "./client-addr";
import { NextRequest } from "./next-shim";

type RouteHandler = (
  request: NextRequest,
  // params 用 Promise<any>：具体 P（string / 通配 string[]）由各 route 文件的 RouteContext 声明，
  // dispatch 只整体传递不访问成员，这样才与 RouteHandler<P> 的逆变参数兼容（见 tsc 严格函数类型）
  ctx: { params: Promise<any> }
) => Response | Promise<Response>;

export function dispatch(
  handler: RouteHandler,
  c: Context,
  wildcardKeys: string[] = []
): Response | Promise<Response> {
  // codegen 防御：注释/字符串里碰巧出现 `export const GET` 会注册到 undefined，
  // 宁可 500 + 明确日志（errorHandler 不回显 message 给客户端）也不要含糊的 TypeError
  if (typeof handler !== "function") {
    throw new Error(
      `gen-routes: missing handler for ${c.req.method} ${c.req.routePath} — rerun scripts/gen-routes.mjs`
    );
  }
  const raw = c.req.raw;
  const init: RequestInit = {
    method: raw.method,
    // 对端地址写进内部 header（无条件覆盖，客户端同名 header 不可信）：
    // route handler 靠它判 loopback（setup 闸门 / LOCAL_ADMIN_BYPASS / 限流桶）
    headers: applyPeerAddressHeader(raw.headers, c),
    signal: raw.signal,
  };
  if (raw.method !== "GET" && raw.method !== "HEAD" && raw.body) {
    // duplex:'half' 由 NextRequest 构造器按 init.body 自动补（见 next-shim.ts）
    init.body = raw.body;
  }
  // 反代拓扑下用 XFP 校正 scheme（见 forwarded.ts），否则 Secure cookie 判定失效
  const request = new NextRequest(forwardedRequestUrl(raw), init);

  const params: Record<string, string | string[]> = { ...c.req.param() };
  if (wildcardKeys.length > 0) {
    // Hono 只有裸 `*`（不存具名通配值）：用注册 pattern（routePath，如 /v1/*）的前缀长度
    // 从实际 path 里切出余量，还原 Next [...name] 的 params 值
    const rest = c.req.path.slice(Math.max(0, c.req.routePath.length - 1));
    const segments = rest.split("/").filter((seg) => seg !== "");
    // Next 的 catch-all `[...name]` 要求至少一段：`/v1`、`/raw` 这类裸前缀在迁移前是 404。
    // Hono 的 `*` 零段也命中（segments 为空 ⇔ path 恰等于前缀），不拦就会把空路径送进网关
    //（`GET /v1` → 上游 `/`），并让基线里「裸前缀 404」变成探测网关存在性的入口
    if (segments.length === 0) return c.notFound();
    for (const key of wildcardKeys) params[key] = segments;
  }

  return handler(request, { params: Promise.resolve(params) });
}
