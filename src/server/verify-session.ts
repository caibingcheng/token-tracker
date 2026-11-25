// /api 会话验签（第一层防漏）：复刻原 src/proxy.ts 的 config.matcher 排除语义，
// 验签逻辑本体仍在 ./proxy（edge-verify HMAC + exp，epoch/key 校验留给路由内 withAuth）。
// matcher 原文：/api/((?!auth/login|auth/setup|auth/logout|cli(?:$|/)).*)
//   - login 携带原始 API key；setup 是首次启动的 fail-open 入口；logout 无状态删 cookie；
//     cli 是公开用量快照 —— 四者均无会话 token 可验，直接放行（见 docs/agents/api-routes.md）
// 排除集用**精确匹配**而非前缀：与 guard-scan.test.ts 的 exempt 文件清单一一对应。
// `/api/auth/loginX`、`/api/cli/xxx` 这类同前缀路径必须继续过验签，否则将来加一个
// `login/callback` 之类的兼容路由就会默默变成免验签入口。尾斜杠不必特判：
// strict:false 下 c.req.path 已归一（`/api/cli/` → `/api/cli`）
import type { MiddlewareHandler } from "hono";
import { forwardedRequestUrl } from "./forwarded";
import { applyPeerAddressHeader } from "./client-addr";
import { NextRequest } from "./next-shim";
import { proxy } from "./proxy";

const VERIFY_EXCLUDED = /^\/api\/(?:auth\/(?:login|setup|logout)|cli)$/;

export const verifySession: MiddlewareHandler = async (c, next) => {
  // 裸 `/api` 也归验签层（不在排除集里 → 401），与 `^\/api(\/|$)` 同口径；
  // 只用 startsWith("/api/") 会让 `/api` 绕过去，将来假设出现裸 `/api` 路由就是漏网
  if (!/^\/api(?:\/|$)/.test(c.req.path)) return next();
  if (VERIFY_EXCLUDED.test(c.req.path)) return next();

  // proxy 只读 headers/cookies/url，不读 body —— 不重建带 body 的请求，
  // 原始 c.req.raw 的 body 留给后续 route handler 流式消费；
  // url 经 XFP 校正（401 清 cookie 分支的 shouldSecureCookie 依赖它）；
  // 对端地址同样写入内部 header（与 dispatch 同口径，免密码直通判定靠它）
  const probe = new NextRequest(forwardedRequestUrl(c.req.raw), {
    method: c.req.method,
    headers: applyPeerAddressHeader(c.req.raw.headers, c),
  });
  const res = await proxy(probe);
  // NextResponse.next()（放行）→ 交还给路由；401/503 直接终止
  if (res.headers.get("x-middleware-next")) return next();
  return res;
};
