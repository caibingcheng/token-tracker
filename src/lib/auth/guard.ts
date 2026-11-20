import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { safeCompare } from "@/lib/gateway/crypto";
import {
  verifySessionToken,
  isTokenExpired,
  shouldRenewToken,
  signSessionToken,
  keyFingerprint,
} from "./session";
import { getTokenEpoch, getAdminApiKey, getEnvAdminKeys, resolveSessionTtlMs } from "./settings";
import { canBypassAuth } from "./local-bypass";
import {
  readSessionCookie,
  buildSessionCookie,
  buildClearSessionCookie,
  shouldSecureCookie,
} from "./session-cookie";

// Next 15+ 动态路由的 `params` 是 Promise（16 的生成类型校验强制要求）；
// 单测仍可直接传同步对象，`await` 对两者等价
export type RouteContext<P extends Record<string, string> = Record<string, string>> = {
  params: Promise<P> | P;
};

export type RouteHandler<P extends Record<string, string> = Record<string, string>> = (
  request: NextRequest,
  ctx: RouteContext<P>
) => Promise<Response> | Response;

export function unauthorized(
  message = "Invalid or missing session token",
  clearCookie?: string
) {
  const res = NextResponse.json({ success: false, error: message }, { status: 401 });
  if (clearCookie) res.headers.append("Set-Cookie", clearCookie);
  return res;
}

// 当前生效的候选登录 key：DB key 优先（单值），env ADMIN_API_KEY / API_KEYS 仅 bootstrap 兜底（可多个）
export async function resolveCandidateLoginKeys(): Promise<string[]> {
  const dbKey = await getAdminApiKey();
  if (dbKey !== null) return [dbKey];
  return getEnvAdminKeys();
}

// 校验 token 的 keyId 指纹是否命中任一候选 key（登录可能用任一 env key 签发）
export async function matchesActiveLoginKey(keyId: string): Promise<boolean> {
  const keys = await resolveCandidateLoginKeys();
  return keys.some((k) => safeCompare(keyId, keyFingerprint(k)));
}

// 路由内认证（第二层）：会话 token 验签 + exp + epoch 检查 + 登录 key 指纹校验；
// 认证通过且 token 剩余有效期不足一半时滑动续期：X-Session-Token 响应头（header 认证的脚本）
// + httpOnly Set-Cookie（cookie 认证的浏览器，续上的新 cookie 代替旧的）
export function withAuth(handler: RouteHandler): RouteHandler {
  return async (request, ctx) => {
    // 本地免密码直通：仅 LOCAL_ADMIN_BYPASS=1 且 loopback Host（见 local-bypass.ts）
    if (canBypassAuth(request)) return handler(request, ctx);

    // 认证来源：X-API-Key header（脚本）优先，其次 httpOnly 会话 cookie（浏览器）。
    // 空 header 归一为 null：否则 "" ?? cookie 会选中空串、拒绝后还按 cookie 认证清掉有效 cookie
    const headerToken = request.headers.get("X-API-Key") || null;
    const cookieToken = readSessionCookie(request.cookies);
    const token = headerToken ?? cookieToken;
    // 仅当请求实际凭 cookie 认证时才在 401/续期时下发 Set-Cookie（header 优先，不能误清有效 cookie）
    const viaCookie = !headerToken && cookieToken !== null;
    const clearCookie = viaCookie
      ? buildClearSessionCookie(shouldSecureCookie(request.url))
      : undefined;
    if (!token) return unauthorized(undefined, clearCookie);

    const payload = verifySessionToken(token);
    if (!payload || isTokenExpired(payload)) return unauthorized(undefined, clearCookie);

    // epoch 检查（留在这里而不是 proxy：第二层校验，proxy 只验签名+exp）
    const epoch = await getTokenEpoch();
    if (payload.epoch !== epoch) return unauthorized(undefined, clearCookie);

    // 登录 key 指纹校验：修改 key 后旧 token 立即失效（遍历候选 key，覆盖多 env key 场景）
    if (!(await matchesActiveLoginKey(payload.keyId))) {
      return unauthorized(undefined, clearCookie);
    }

    const response = await handler(request, ctx);

    // 滑动续期：剩余有效期不足一半时签发新 token
    const ttlMs = await resolveSessionTtlMs();
    const renewed = shouldRenewToken(payload, ttlMs)
      ? signSessionToken(epoch, payload.keyId, ttlMs)
      : null;
    // 续期按认证来源二选一：cookie 认证只 Set-Cookie（httpOnly， renewed token 不进 JS 视野）；
    // header 认证只发 X-Session-Token 给脚本。两者不能同时给——否则同源 JS 能读走续期 token
    const renewalHeaders = (res: Response) => {
      if (!renewed) return;
      if (viaCookie) {
        res.headers.append(
          "Set-Cookie",
          buildSessionCookie(renewed, ttlMs, shouldSecureCookie(request.url))
        );
      } else {
        res.headers.set("X-Session-Token", renewed);
      }
    };
    if (response instanceof NextResponse) {
      renewalHeaders(response);
    } else {
      // 普通 Response：包装并附带续期 header
      if (renewed) {
        const wrapped = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        renewalHeaders(wrapped);
        return wrapped;
      }
    }

    return response;
  };
}
