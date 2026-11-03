import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  deriveEdgeSessionKey,
  verifyEdgeSignature,
  parseEdgeSessionPayload,
} from "@/lib/auth/edge-verify";
import { canBypassAuth } from "@/lib/auth/local-bypass";
import {
  readSessionCookie,
  buildClearSessionCookie,
  shouldSecureCookie,
} from "@/lib/auth/session-cookie";

// 验签 middleware（第一层防漏）：Edge runtime 无法访问 SQLite / node:crypto，
// 因此这里只用 WebCrypto 验证会话 token 的 HMAC-SHA256 签名 + exp 过期检查；
// epoch 检查与 DB key 校验由路由内 withAuth 完成。
// matcher 排除 /api/auth/login 与 /api/auth/setup：login 携带原始 API key，
// setup 是首次启动的 fail-open 入口（自身闸门校验），两者均无会话 token 可用。

function unauthorized(clearCookie?: string) {
  const res = NextResponse.json(
    { success: false, error: "Invalid or missing session token" },
    { status: 401 }
  );
  if (clearCookie) res.headers.append("Set-Cookie", clearCookie);
  return res;
}

export async function middleware(request: NextRequest) {
  // 本地免密码直通：仅 LOCAL_ADMIN_BYPASS=1 且 loopback Host（见 local-bypass.ts）
  if (canBypassAuth(request)) return NextResponse.next();

  // 认证来源：X-API-Key header（脚本）优先，其次 httpOnly 会话 cookie（浏览器）。
  // 空 header 归一为 null：否则 "" ?? cookie 会选中空串、拒绝后还按 cookie 认证清掉有效 cookie
  const headerToken = request.headers.get("X-API-Key") || null;
  const cookieToken = readSessionCookie(request.cookies);
  const token = headerToken ?? cookieToken;
  // 仅当请求实际凭 cookie 认证时才在 401 时下发的过期 Set-Cookie 清除它
  //（header 与 cookie 同时存在时以 header 为准，不能误清可能仍有效的 cookie）
  const clearCookie =
    !headerToken && cookieToken
      ? buildClearSessionCookie(shouldSecureCookie(request.url))
      : undefined;
  if (!token) return unauthorized(clearCookie);

  const dot = token.indexOf(".");
  if (dot <= 0) return unauthorized(clearCookie);
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const secret = process.env.GATEWAY_SECRET;
  if (!secret) {
    return NextResponse.json(
      { success: false, error: "GATEWAY_SECRET is not configured" },
      { status: 503 }
    );
  }

  const key = await deriveEdgeSessionKey(secret);
  if (!(await verifyEdgeSignature(key, payload, sig))) {
    return unauthorized(clearCookie);
  }
  if (!parseEdgeSessionPayload(payload)) {
    return unauthorized(clearCookie);
  }

  return NextResponse.next();
}

export const config = {
  // auth/logout 不验签：登出就是清 cookie，带不带有效 token 都要能到达路由
  // cli：公开用量快照（无认证、参数固定），认证由路由自身不提供（见 api-routes.md）
  matcher: "/api/((?!auth/login|auth/setup|auth/logout|cli(?:$|/)).*)",
};
